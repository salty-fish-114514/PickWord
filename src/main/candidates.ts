/**
 * 候选词：把 renderer 的请求转发给 llama-server 的 /completion，
 * 再把返回的 top-N 概率整理成前端要的 Candidate[]。
 *
 * 对外三个函数：
 *   getCandidates()    处理一次请求
 *   cancelCandidates() 取消一次请求
 *   getModelProfile()  模型画像（上下文长度、提示词模板、终止符），renderer 据此拼 prompt
 */
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { backend } from './backend'
import { readBackendConfig } from './backendConfig'
import { getArgNumber } from '../shared/backendArgs'
import type { Candidate, CandidateRequest, PromptMode } from '../shared/ipc'
import {
  DEFAULT_EOS_TEXTS,
  DEFAULT_HIDDEN_TEXTS,
  detectNoThinkPrefix,
  detectPromptTemplate,
  type ModelProfile
} from '../shared/modelProfile'

const MAX_TOP_K = 200
/** 多要几个：过滤掉字节碎片、特殊标记之后，仍然能凑够 topK 个。 */
const EXTRA_PROBS = 16
/** 单次请求最长等待时间。纯 CPU 下全量 prefill 一万多 token 可能要一两分钟。 */
const REQUEST_TIMEOUT_MS = 180_000
const META_TIMEOUT_MS = 5_000
const PROMPT_MODES: readonly PromptMode[] = ['plain', 'outline', 'style', 'full']

/* ───────── 处理「来路不明的 JSON」的小工具 ─────────
 * 从网络或 IPC 收到的数据在 TypeScript 里是 unknown（相当于「什么都可能」）。
 * 先用这些函数确认类型再使用，可以避免 any，也能防止格式变化时程序崩溃。 */
import type { Json } from './ioUtils'
import { isObj, asNum, asStr } from './ioUtils'

/* ───────── 模型画像与特殊 token（每次后端启动后查一次） ───────── */

interface TokenMeta {
  eosIds: Set<number>
  hiddenIds: Set<number>
  eosTexts: Set<string>
  profile: ModelProfile
  serverProps: unknown
}

const EMPTY_META: TokenMeta = {
  eosIds: new Set(),
  hiddenIds: new Set(),
  eosTexts: new Set(DEFAULT_EOS_TEXTS),
  profile: {
    modelName: '',
    contextLength: null,
    slots: 1,
    template: detectPromptTemplate('', ''),
    noThinkPrefix: '',
    eosTexts: [...DEFAULT_EOS_TEXTS]
  },
  serverProps: null
}

async function requestJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(META_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 查询某段文字是否恰好对应一个 token；是则返回它的 id。 */
async function singleTokenId(baseUrl: string, text: string): Promise<number | null> {
  try {
    const r = await requestJson(`${baseUrl}/tokenize`, {
      content: text,
      add_special: false,
      parse_special: true // 让 <|im_end|> 这类文字被识别为特殊 token，而不是拆成普通字符
    })
    const tokens = isObj(r) && Array.isArray(r.tokens) ? r.tokens : []
    if (tokens.length === 1) return asNum(tokens[0]) ?? null
  } catch {
    // 查不到就算了，后面还有按文字匹配的兜底
  }
  return null
}

/** 备用方案：从 backend.json 的启动参数里找 -c（总上下文）与 --parallel；每槽 = -c ÷ 槽位数。 */
function contextFromArgs(): { perSlot: number | null; slots: number } {
  const result = readBackendConfig()
  if (!result.ok) return { perSlot: null, slots: 1 }
  const total = getArgNumber(result.config.args, '-c') ?? getArgNumber(result.config.args, '--ctx-size')
  const parallel = getArgNumber(result.config.args, '--parallel') ?? getArgNumber(result.config.args, '-np')
  const slots = parallel !== null && Number.isInteger(parallel) && parallel > 0 ? parallel : 1
  const perSlot = total !== null && Number.isInteger(total) && total > 0 ? Math.floor(total / slots) : null
  return { perSlot, slots }
}

async function discoverMeta(baseUrl: string): Promise<TokenMeta> {
  // /props 是 llama-server 的「服务器属性」接口，包含实际生效的上下文长度、模型路径、chat_template 等。
  let props: unknown = null
  try {
    props = await requestJson(`${baseUrl}/props`)
  } catch {
    // 老版本可能没有这个接口
  }
  const p = isObj(props) ? props : {}
  const gen = isObj(p.default_generation_settings) ? p.default_generation_settings : {}
  // /props 的 n_ctx 是单个槽位的上下文（服务器已按 --parallel 平分）
  const fromArgs = contextFromArgs()
  const fromServer = asNum(gen.n_ctx) ?? asNum(p.n_ctx)
  const contextLength = fromServer && fromServer > 0 ? fromServer : fromArgs.perSlot
  const slotsFromServer = asNum(p.total_slots)
  const slots = slotsFromServer && slotsFromServer > 0 ? Math.round(slotsFromServer) : fromArgs.slots
  const modelName = (asStr(p.model_path) ?? '').split(/[\\/]/).pop() ?? ''
  const template = detectPromptTemplate(asStr(p.chat_template) ?? '', modelName)
  // 有思考开关的模型（Qwen3 / Qwen3.5 等）：assistant 回合要以空思考块开头，否则文法约束下会坍缩成「无」
  //（见 ModelProfile.noThinkPrefix 的事故记录）。候选续写与纠错用的是同一个字面量，renderer 两边都接上。
  const noThinkPrefix = detectNoThinkPrefix(asStr(p.chat_template) ?? '', modelName)

  const eosTexts = new Set(DEFAULT_EOS_TEXTS)
  const serverEos = asStr(p.eos_token)
  if (serverEos) eosTexts.add(serverEos)

  const eosIds = new Set<number>()
  for (const text of eosTexts) {
    const id = await singleTokenId(baseUrl, text)
    if (id !== null) eosIds.add(id)
  }
  const hiddenIds = new Set<number>()
  for (const text of DEFAULT_HIDDEN_TEXTS) {
    const id = await singleTokenId(baseUrl, text)
    if (id !== null && !eosIds.has(id)) hiddenIds.add(id)
  }

  if (!app.isPackaged) {
    console.log(`[candidates] 模型=${modelName} n_ctx/槽=${contextLength} 槽位=${slots} template=${template.id} EOS ids=[${[...eosIds]}]`)
  }
  return {
    eosIds,
    hiddenIds,
    eosTexts,
    profile: { modelName, contextLength, slots, template, noThinkPrefix, eosTexts: [...eosTexts] },
    serverProps: p
  }
}

/** 缓存：同一次后端启动只查一次；后端重启（generation 变化）后重新查。 */
let metaCache: { generation: number; promise: Promise<TokenMeta> } | null = null

export function getMeta(): Promise<TokenMeta> {
  const generation = backend.generation
  if (!metaCache || metaCache.generation !== generation) {
    const promise = discoverMeta(backend.getStatus().baseUrl)
    metaCache = { generation, promise }
    // 查询失败时清掉缓存，下次请求再试
    promise.catch(() => {
      if (metaCache?.promise === promise) metaCache = null
    })
  }
  return metaCache.promise
}

export async function getModelProfile(): Promise<ModelProfile | null> {
  if (backend.getStatus().state !== 'ready') return null
  try {
    return (await getMeta()).profile
  } catch {
    return null
  }
}

/* ───────── 候选请求 ───────── */

/** requestId → 用来中断该次 HTTP 请求的「取消令牌」。 */
const inflight = new Map<string, AbortController>()

interface CandidateDiagnosticAttempt {
  requestBody: Record<string, unknown>
  elapsedMs: number
  httpStatus: number
  response: unknown
}

interface CandidateFailureDiagnostic {
  schemaVersion: 1
  savedAt: string
  requestId: string
  app: { version: string; packaged: boolean; platform: string; arch: string; electron: string; node: string }
  backend: { baseUrl: string; generation: number; profile: ModelProfile; serverProps: unknown; launchConfig: ReturnType<typeof readBackendConfig> }
  candidateRequest: CandidateRequest
  httpRequest: { url: string; method: 'POST'; body: Record<string, unknown>; promptSha256: string }
  attempts: CandidateDiagnosticAttempt[]
  llamaResponse: unknown
  error: { name: string; message: string; stack?: string }
}

/** 最近的失败快照暂存在主进程内存；只有用户点击“保存错误信息”时才落盘。 */
const candidateFailureDiagnostics = new Map<string, CandidateFailureDiagnostic>()
const MAX_SAVED_DIAGNOSTICS = 10

function rememberCandidateFailure(
  req: CandidateRequest,
  status: ReturnType<typeof backend.getStatus>,
  profile: ModelProfile,
  serverProps: unknown,
  body: Record<string, unknown>,
  attempts: CandidateDiagnosticAttempt[],
  response: unknown,
  error: unknown
): void {
  const err = error instanceof Error ? error : new Error(String(error))
  const prompt = typeof body.prompt === 'string' ? body.prompt : req.prompt
  const snapshot: CandidateFailureDiagnostic = {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    requestId: req.requestId,
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node ?? 'unknown'
    },
    backend: {
      baseUrl: status.baseUrl,
      generation: backend.generation,
      profile,
      serverProps,
      launchConfig: readBackendConfig()
    },
    candidateRequest: req,
    httpRequest: {
      url: `${status.baseUrl}/completion`,
      method: 'POST',
      body,
      promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex')
    },
    attempts,
    llamaResponse: response,
    error: { name: err.name, message: err.message, stack: err.stack }
  }
  candidateFailureDiagnostics.set(req.requestId, snapshot)
  while (candidateFailureDiagnostics.size > MAX_SAVED_DIAGNOSTICS) {
    const oldest = candidateFailureDiagnostics.keys().next().value
    if (oldest === undefined) break
    candidateFailureDiagnostics.delete(oldest)
  }
}

/** 由固定主进程路径保存，不接受 renderer 提供的文件路径。 */
export async function saveCandidateFailureDiagnostic(requestId: unknown): Promise<string> {
  if (typeof requestId !== 'string') throw new Error('缺少有效的候选请求编号')
  const snapshot = candidateFailureDiagnostics.get(requestId)
  if (!snapshot) throw new Error('找不到这次候选请求的诊断快照，请重试一次后立即保存')

  // 安装目录中的 resources 通常不可写；打包后将 resources 子目录放在用户数据目录。
  const root = app.isPackaged ? app.getPath('userData') : app.getAppPath()
  const directory = path.join(root, 'resources', 'candidate-diagnostics')
  await mkdir(directory, { recursive: true })
  const stamp = snapshot.savedAt.replace(/[:.]/g, '-')
  const filePath = path.join(directory, `candidate-failure-${stamp}-${randomUUID()}.json`)
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return filePath
}

/** fatal: true = 遇到不完整的 UTF-8 直接报错，而不是悄悄变成 �。 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * 取 token 的文字：优先用 bytes 严格解码。
 * 实测 token 字段可能和真实字节不一致（例如字节是「半山」，token 字段却是「半 山」）。
 * 返回 null 表示这是半个字符的字节碎片，应当丢弃。
 */
function tokenText(item: Json, fallback: string): string | null {
  const bytes = item.bytes
  if (Array.isArray(bytes) && bytes.length > 0) {
    if (!bytes.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) {
      return null
    }
    try {
      return strictUtf8.decode(Uint8Array.from(bytes as number[]))
    } catch {
      return null
    }
  }
  return fallback.includes('\uFFFD') ? null : fallback
}

/** 校验 renderer 发来的请求。主进程不信任来自页面的任何数据。 */
function parseRequest(raw: unknown): CandidateRequest {
  if (!isObj(raw)) throw new Error('候选请求格式错误')
  const { requestId, prompt, bodyPrefix, topK, mode } = raw
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 100) {
    throw new Error('候选请求缺少有效的 requestId')
  }
  if (typeof prompt !== 'string' || prompt.length > 2_000_000) {
    throw new Error('prompt 不是字符串或过长')
  }
  const k = Math.round(asNum(topK) ?? 100)
  return {
    requestId,
    prompt,
    bodyPrefix: typeof bodyPrefix === 'string' ? bodyPrefix : '',
    topK: Math.min(MAX_TOP_K, Math.max(1, k)),
    mode: PROMPT_MODES.includes(mode as PromptMode) ? (mode as PromptMode) : 'plain'
  }
}

/** 从 llama-server 响应里取概率记录；格式错误与“尚无任何记录”由调用者区分。 */
function probabilityRecords(data: unknown): Json[] | null {
  if (!isObj(data) || !Array.isArray(data.completion_probabilities)) return null
  return data.completion_probabilities as Json[]
}

function byteArray(value: unknown): Uint8Array | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) return null
  return Uint8Array.from(value as number[])
}

/** 从一条 token 概率记录生成候选；prefixBytes 用于 UTF-8 缓冲回退时拼回已采样前缀。 */
function mapProbabilityRecord(
  record: Json,
  meta: TokenMeta,
  topK: number,
  prefixBytes?: Uint8Array
): Candidate[] {
  if (!isObj(record)) return []
  const list: unknown[] = Array.isArray(record.top_logprobs)
    ? record.top_logprobs
    : Array.isArray(record.probs)
      ? record.probs
      : []
  const byText = new Map<string, Candidate>()

  for (const raw of list) {
    if (!isObj(raw)) continue
    const id = asNum(raw.id)
    const tokenStr = asStr(raw.token) ?? asStr(raw.tok_str) ?? ''
    const prob = asNum(raw.prob)
    const logprob = asNum(raw.logprob) ?? (prob !== undefined && prob > 0 ? Math.log(prob) : undefined)
    if (logprob === undefined) continue

    const isEos = (id !== undefined && meta.eosIds.has(id)) || meta.eosTexts.has(tokenStr.trim())
    if (!isEos) {
      if (id !== undefined && meta.hiddenIds.has(id)) continue
      if (/^<\|[^|]*\|>$/.test(tokenStr) || /^<\/?think>$/.test(tokenStr)) continue
    }

    // EOS 保留给 renderer 计数/过滤，不把隐藏的采样前缀拼在 EOS 标记前。
    let text: string | null
    if (isEos) {
      text = tokenStr || '<|im_end|>'
    } else if (prefixBytes) {
      const tokenBytes = byteArray(raw.bytes)
      if (!tokenBytes) {
        // 旧响应没给 bytes 时只接受本身可解码的 token；不能猜测碎片字节。
        text = tokenText(raw as Json, tokenStr)
      } else {
        const joined = new Uint8Array(prefixBytes.length + tokenBytes.length)
        joined.set(prefixBytes)
        joined.set(tokenBytes, prefixBytes.length)
        try {
          text = strictUtf8.decode(joined)
        } catch {
          text = null
        }
      }
    } else {
      text = tokenText(raw as Json, tokenStr)
    }
    if (text === null || text === '') continue

    const prev = byText.get(text)
    if (prev && (prev.logit ?? -Infinity) >= logprob) continue
    byText.set(text, { text, prob: Math.exp(logprob), logit: logprob, tokenId: id, isEos })
  }

  return [...byText.values()]
    .sort((a, b) => (b.logit ?? -Infinity) - (a.logit ?? -Infinity))
    .slice(0, topK)
}

/** 把 llama-server 的响应整理成 Candidate[]。新旧两种响应格式都兼容。 */
function mapCandidates(data: unknown, meta: TokenMeta, topK: number, requestedNProbs: number): Candidate[] {
  const probsList = probabilityRecords(data)
  if (!probsList) {
    const details = isObj(data)
      ? (() => {
          const settings = isObj(data.generation_settings) ? data.generation_settings : {}
          const tokens = Array.isArray(data.tokens) ? data.tokens : undefined
          return [
            `响应字段=[${Object.keys(data).slice(0, 16).join(', ')}]`,
            `requested_n_probs=${requestedNProbs}`,
            `generation_settings.n_probs=${asNum(settings.n_probs) ?? 'missing'}`,
            `generation_settings.n_predict=${asNum(settings.n_predict) ?? asNum(settings.max_tokens) ?? 'missing'}`,
            `stop_type=${asStr(data.stop_type) ?? 'unknown'}`,
            `stopped_eos=${data.stopped_eos === true}`,
            `content_length=${asStr(data.content)?.length ?? -1}`,
            `tokens_length=${tokens?.length ?? 'missing'}`
          ].join(' ')
        })()
      : `响应类型=${typeof data}`
    throw new Error(`llama-server 响应中缺少 completion_probabilities 字段（${details}）`)
  }
  if (probsList.length === 0) return []
  return mapProbabilityRecord(probsList[0], meta, topK)
}

/**
 * 当 b8868 丢掉了 UTF-8 前缀 token 的概率记录时，尝试用最后一个可对齐的记录回填。
 * 只在末条概率记录能与最后采样 token / content 尾字节对齐、且 content 是完整 UTF-8 时使用，
 * 并将该记录的采样 token 前面已缓冲的字节拼到每个备选 token 上。
 */
function mapBufferedCandidates(data: unknown, meta: TokenMeta, topK: number): Candidate[] | null {
  if (!isObj(data) || data.stopped_eos === true || asStr(data.stop_type) === 'eos') return null
  const probs = probabilityRecords(data)
  const rawTokens = Array.isArray(data.tokens) ? data.tokens : []
  const content = asStr(data.content)
  if (!probs?.length || content === undefined || content.includes('\uFFFD')) return null

  const last = probs[probs.length - 1]
  if (!isObj(last)) return null
  // 优先用 return_tokens 核验最后一条概率记录；老 server 若没回 token ID，
  // 再靠原始 token bytes 是否正好位于 content 末尾来对齐。
  const finalTokenId = rawTokens.length > 0 ? asNum(rawTokens[rawTokens.length - 1]) : undefined
  if (finalTokenId !== undefined && asNum(last.id) !== finalTokenId) return null
  const sampledBytes = byteArray(last.bytes)
  if (!sampledBytes) return null

  const contentBytes = Buffer.from(content, 'utf8')
  if (contentBytes.length < sampledBytes.length) return null
  const suffix = contentBytes.subarray(contentBytes.length - sampledBytes.length)
  if (!Buffer.from(sampledBytes).equals(suffix)) return null

  const prefixBytes = contentBytes.subarray(0, contentBytes.length - sampledBytes.length)
  return mapProbabilityRecord(last as Json, meta, topK, prefixBytes)
}

/** 开发期日志：看 KV cache 是否命中。cache_n = 复用的 token 数，prompt_n = 本次重算的 token 数。 */
function logTimings(req: CandidateRequest, data: unknown, wallMs: number): void {
  if (app.isPackaged) return
  const t = isObj(data) && isObj(data.timings) ? data.timings : {}
  console.log(
    `[candidates] mode=${req.mode} cache_n=${t.cache_n} prompt_n=${t.prompt_n} ` +
      `prompt_ms=${Math.round(asNum(t.prompt_ms) ?? -1)} total_ms=${wallMs} ` +
      `tail=${JSON.stringify(req.prompt.slice(-30))}`
  )
}

export async function getCandidates(raw: unknown): Promise<Candidate[]> {
  const req = parseRequest(raw)
  if (req.prompt === '') return [] // 空文档时不请求（llama-server 可能拒绝空 prompt）

  const status = backend.getStatus()
  if (status.state !== 'ready') throw new Error('本地模型尚未就绪')

  // 先登记取消令牌，再做任何 await；这样紧随其后的 cancel 一定能找到它
  const controller = new AbortController()
  inflight.set(req.requestId, controller)
  const started = Date.now()
  let diagnosticMeta = EMPTY_META
  let diagnosticBody: Record<string, unknown> | null = null
  const diagnosticAttempts: CandidateDiagnosticAttempt[] = []
  let diagnosticResponse: unknown = null

  try {
    const meta = await getMeta().catch(() => EMPTY_META)
    diagnosticMeta = meta
    if (controller.signal.aborted) return []

    const requestedNProbs = req.topK + EXTRA_PROBS
    // 同一 requestId 的 1→2→3 回退使用同一 seed，确保后一次是在延长同一条 token 序列，
    // 而不是重新抽到另一个首 token。不同候选请求仍有不同 requestId/seed。
    const seed = createHash('sha256').update(req.requestId).digest().readUInt32LE(0) & 0x7fffffff
    const completionBody = {
      prompt: req.prompt, // 前端已按 ModelProfile.template 拼好，原样转发，不再套模板
      n_predict: 1,
      n_probs: requestedNProbs,
      return_tokens: true, // 让回退能把概率记录与实际生成 token 对齐
      seed,
      // llama.cpp b8868 的 speculative sampling 分支尚未填充 token 概率；候选必须拿到分布，所以在此请求中关闭它。
      'speculative.type': 'none',
      cache_prompt: true, // 复用与上一次请求相同的前缀
      id_slot: 0, // 候选固定用槽 0；纠错等后台任务用槽 1（见 llm.ts），互不抢缓存
      temperature: 1.0,
      stream: false
    }
    diagnosticBody = completionBody
    const requestCompletion = async (body: Record<string, unknown>): Promise<unknown> => {
      const attemptStarted = Date.now()
      const res = await fetch(`${status.baseUrl}/completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // 两种情况都会中断请求：被取消，或者超时
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      })
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300)
        diagnosticResponse = { text: detail }
        diagnosticAttempts.push({
          requestBody: body,
          elapsedMs: Date.now() - attemptStarted,
          httpStatus: res.status,
          response: diagnosticResponse
        })
        throw new Error(`llama-server 返回 HTTP ${res.status}：${detail}`)
      }
      const response = await res.json()
      diagnosticResponse = response
      diagnosticAttempts.push({
        requestBody: body,
        elapsedMs: Date.now() - attemptStarted,
        httpStatus: res.status,
        response
      })
      return response
    }

    let data: unknown = null
    let candidates: Candidate[] | null = null
    let sawProbabilityArray = false

    for (const nPredict of [1, 2, 3]) {
      const attemptBody: Record<string, unknown> = { ...completionBody, n_predict: nPredict }
      diagnosticBody = attemptBody
      data = await requestCompletion(attemptBody)
      if (controller.signal.aborted) return []

      if (isObj(data) && !Array.isArray(data.completion_probabilities)) {
        const stoppedAtEos = data.stopped_eos === true || asStr(data.stop_type) === 'eos'
        const content = asStr(data.content)
        const hasServerError = typeof data.error === 'string'
        // 保留既有 EOS/空输出重试；之后仍可继续 1→2→3 的 UTF-8 缓冲回退。
        if (!hasServerError && (stoppedAtEos || content === '' || content === undefined)) {
          if (!app.isPackaged) {
            const timings = isObj(data.timings) ? data.timings : {}
            const generation = isObj(data.generation_settings) ? data.generation_settings : {}
            console.warn(
              `[candidates] n_predict=${nPredict} 没有候选分布，按 ignore_eos=true 重试；` +
                `keys=[${Object.keys(data).slice(0, 16).join(',')}] ` +
                `stop_type=${asStr(data.stop_type) ?? 'unknown'} stopped_eos=${data.stopped_eos === true} ` +
                `predicted_n=${asNum(timings.predicted_n) ?? 'unknown'} ` +
                `requested_n_probs=${requestedNProbs} generation_settings.n_probs=${asNum(generation.n_probs) ?? 'missing'} ` +
                `generation_settings.n_predict=${asNum(generation.n_predict) ?? asNum(generation.max_tokens) ?? 'missing'} ` +
                `content_length=${content?.length ?? -1}`
            )
          }
          const retryBody = { ...attemptBody, ignore_eos: true }
          diagnosticBody = retryBody
          data = await requestCompletion(retryBody)
          if (controller.signal.aborted) return []
        }
      }

      const probs = probabilityRecords(data)
      if (!probs) continue
      sawProbabilityArray = true
      if (probs.length === 0) continue

      const rawTokens = isObj(data) && Array.isArray(data.tokens) ? data.tokens : []
      const tokenIds = rawTokens.map(asNum)
      const aligned = tokenIds.length === probs.length &&
        tokenIds.every((id, i) => id !== undefined && isObj(probs[i]) && asNum(probs[i].id) === id)

      // 完整对齐时第一条记录仍是光标处的分布，可直接使用。
      if (nPredict === 1 || aligned) {
        const direct = mapCandidates(data, meta, req.topK, requestedNProbs)
        if (direct.length > 0) {
          candidates = direct
          break
        }
      }

      // 旧服务端会漏掉 UTF-8 前缀 token 的概率记录。若末条记录能与输出末尾对齐，
      // 将已采样前缀的原始字节拼到该步的每个候选前，再只保留完整 UTF-8 字符串。
      const buffered = mapBufferedCandidates(data, meta, req.topK)
      if (buffered && buffered.length > 0) {
        candidates = buffered
        if (!app.isPackaged) {
          console.warn(`[candidates] 使用 UTF-8 缓冲回退：n_predict=${nPredict}，候选已拼接隐藏采样前缀`)
        }
        break
      }
    }

    if (candidates === null) {
      // 概率数组存在但回退后仍没有可显示的完整 UTF-8 候选：按“无候选”处理。
      // 若三次响应都缺少整个字段，则保留原有诊断错误，方便用户点击保存错误信息。
      if (sawProbabilityArray) candidates = []
      else candidates = mapCandidates(data, meta, req.topK, requestedNProbs)
    }
    logTimings(req, data, Date.now() - started)
    // 顺手把这次的 prefill 速度喂给 backend，供「重算上下文大约要多久」使用。
    // 只在 prompt_n 足够大时才采信，避免单 token 续写（prompt_n=1）的噪声估计污染这个值。
    const t = isObj(data) && isObj(data.timings) ? data.timings : {}
    const promptN = asNum(t.prompt_n)
    const pps = asNum(t.prompt_per_second)
    if (pps && promptN && promptN >= 20) backend.reportPrefillSpeed(pps)
    return candidates
  } catch (err) {
    // 被取消时返回空数组而不是报错：renderer 自己知道这次请求已取消，会把结果丢掉。
    // 如果这里抛错，前端可能把一次正常的取消当成故障显示出来。
    if (controller.signal.aborted) return []
    if (diagnosticBody) {
      rememberCandidateFailure(
        req,
        status,
        diagnosticMeta.profile,
        diagnosticMeta.serverProps,
        diagnosticBody,
        diagnosticAttempts,
        diagnosticResponse,
        err
      )
    }
    throw err
  } finally {
    if (inflight.get(req.requestId) === controller) inflight.delete(req.requestId)
  }
}

export function cancelCandidates(requestId: unknown): void {
  if (typeof requestId !== 'string') return
  // abort 会断开 HTTP 连接；llama-server 发现连接断开后会放弃这个任务
  inflight.get(requestId)?.abort()
}
