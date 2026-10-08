/**
 * 候选词：把 renderer 的请求转发给 llama-server 的 /completion，
 * 再把返回的 top-N 概率整理成前端要的 Candidate[]。
 *
 * 用 Python 类比：这个文件相当于一个模块，对外只有三个函数：
 *   getCandidates()    处理一次请求
 *   cancelCandidates() 取消一次请求
 *   getModelInfo()     查询模型上下文长度等信息
 */
import { app } from 'electron'
import { backend, loadConfig } from './backend'
import type { Candidate, CandidateRequest, ModelInfo, PromptMode } from '../shared/ipc'

const MAX_TOP_K = 200
/** 多要几个：过滤掉字节碎片、特殊标记之后，仍然能凑够 topK 个。 */
const EXTRA_PROBS = 16
/** 单次请求最长等待时间。纯 CPU 下全量 prefill 一万多 token 可能要一两分钟。 */
const REQUEST_TIMEOUT_MS = 180_000
const META_TIMEOUT_MS = 5_000

/** 可能代表「文本结束」的标记。哪些真的是单个 token，启动后用 /tokenize 查询确认。 */
const EOS_STRINGS = ['<|im_end|>', '<|endoftext|>', '<|eot_id|>', '<end_of_turn>', '<eos>', '</s>', '<|end|>']
/** 不是结束符、但也不该出现在候选里的特殊标记（Qwen3 系列的思考标记等）。 */
const HIDDEN_STRINGS = ['<think>', '</think>', '<|im_start|>']
const PROMPT_MODES: readonly PromptMode[] = ['plain', 'outline', 'style', 'full']

/* ───────── 处理「来路不明的 JSON」的小工具 ─────────
 * 从网络或 IPC 收到的数据在 TypeScript 里是 unknown（相当于「什么都可能」）。
 * 先用这些函数确认类型再使用，可以避免 any，也能防止格式变化时程序崩溃。 */
type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/* ───────── 模型信息与特殊 token（每次后端启动后查一次） ───────── */

interface TokenMeta {
  eosIds: Set<number>
  hiddenIds: Set<number>
  eosTexts: Set<string>
  info: ModelInfo
}

const EMPTY_META: TokenMeta = {
  eosIds: new Set(),
  hiddenIds: new Set(),
  eosTexts: new Set(EOS_STRINGS),
  info: { contextLength: null, modelName: '' }
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

/** 备用方案：从 backend.json 的启动参数里找 -c / --ctx-size。 */
function contextLengthFromArgs(): number | null {
  try {
    const args = loadConfig().args
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-c' || args[i] === '--ctx-size') {
        const n = Number(args[i + 1])
        if (Number.isInteger(n) && n > 0) return n
      }
    }
  } catch {
    // 配置读不到
  }
  return null
}

async function discoverMeta(baseUrl: string): Promise<TokenMeta> {
  // /props 是 llama-server 的「服务器属性」接口，包含实际生效的上下文长度、模型路径等。
  let props: unknown = null
  try {
    props = await requestJson(`${baseUrl}/props`)
  } catch {
    // 老版本可能没有这个接口
  }
  const p = isObj(props) ? props : {}
  const gen = isObj(p.default_generation_settings) ? p.default_generation_settings : {}
  const fromServer = asNum(gen.n_ctx) ?? asNum(p.n_ctx)
  const contextLength = fromServer && fromServer > 0 ? fromServer : contextLengthFromArgs()
  const modelName = (asStr(p.model_path) ?? '').split(/[\\/]/).pop() ?? ''

  const eosTexts = new Set(EOS_STRINGS)
  const serverEos = asStr(p.eos_token)
  if (serverEos) eosTexts.add(serverEos)

  const eosIds = new Set<number>()
  for (const text of eosTexts) {
    const id = await singleTokenId(baseUrl, text)
    if (id !== null) eosIds.add(id)
  }
  const hiddenIds = new Set<number>()
  for (const text of HIDDEN_STRINGS) {
    const id = await singleTokenId(baseUrl, text)
    if (id !== null && !eosIds.has(id)) hiddenIds.add(id)
  }

  if (!app.isPackaged) {
    console.log(`[candidates] 模型=${modelName} n_ctx=${contextLength} EOS ids=[${[...eosIds]}]`)
  }
  return { eosIds, hiddenIds, eosTexts, info: { contextLength, modelName } }
}

/** 缓存：同一次后端启动只查一次；后端重启（generation 变化）后重新查。 */
let metaCache: { generation: number; promise: Promise<TokenMeta> } | null = null

function getMeta(): Promise<TokenMeta> {
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

export async function getModelInfo(): Promise<ModelInfo | null> {
  if (backend.getStatus().state !== 'ready') return null
  try {
    return (await getMeta()).info
  } catch {
    return null
  }
}

/* ───────── 候选请求 ───────── */

/** requestId → 用来中断该次 HTTP 请求的「取消令牌」。 */
const inflight = new Map<string, AbortController>()

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

/** 把 llama-server 的响应整理成 Candidate[]。新旧两种响应格式都兼容。 */
function mapCandidates(data: unknown, meta: TokenMeta, topK: number): Candidate[] {
  const probsList = isObj(data) ? data.completion_probabilities : undefined
  const first = Array.isArray(probsList) ? probsList[0] : undefined
  if (!isObj(first)) {
    throw new Error('llama-server 响应中没有 completion_probabilities，请确认 n_probs 生效')
  }
  const list: unknown[] = Array.isArray(first.top_logprobs)
    ? first.top_logprobs // 新版格式
    : Array.isArray(first.probs)
      ? first.probs // 旧版格式
      : []

  // 用 Map 按文字去重：极少数情况下不同 id 解码出同样的文字，保留概率更高的那个
  const byText = new Map<string, Candidate>()

  for (const item of list) {
    if (!isObj(item)) continue
    const id = asNum(item.id)
    const tokenStr = asStr(item.token) ?? asStr(item.tok_str) ?? ''
    const prob = asNum(item.prob)
    const logprob = asNum(item.logprob) ?? (prob !== undefined && prob > 0 ? Math.log(prob) : undefined)
    if (logprob === undefined) continue

    const isEos = (id !== undefined && meta.eosIds.has(id)) || meta.eosTexts.has(tokenStr.trim())
    if (!isEos) {
      if (id !== undefined && meta.hiddenIds.has(id)) continue
      if (/^<\|[^|]*\|>$/.test(tokenStr) || /^<\/?think>$/.test(tokenStr)) continue
    }

    // EOS 保留（前端要拿它计数，再自己从列表里滤掉）；它的字节可能为空，所以单独处理
    const text = isEos ? tokenStr || '<|im_end|>' : tokenText(item, tokenStr)
    if (text === null || text === '') continue

    const prev = byText.get(text)
    if (prev && (prev.logit ?? -Infinity) >= logprob) continue
    byText.set(text, { text, prob: Math.exp(logprob), logit: logprob, tokenId: id, isEos })
  }

  return [...byText.values()]
    .sort((a, b) => (b.logit ?? -Infinity) - (a.logit ?? -Infinity))
    .slice(0, topK)
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

  try {
    const meta = await getMeta().catch(() => EMPTY_META)
    if (controller.signal.aborted) return []

    const res = await fetch(`${status.baseUrl}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: req.prompt, // 前端已拼好（纯文本或 ChatML），原样转发，不再套模板
        n_predict: 1, // 只要「下一个 token」的分布
        n_probs: req.topK + EXTRA_PROBS,
        cache_prompt: true, // 复用与上一次请求相同的前缀
        id_slot: 0, // 固定一个 slot，配合 --parallel 1
        temperature: 1.0,
        stream: false
      }),
      // 两种情况都会中断请求：被取消，或者超时
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300)
      throw new Error(`llama-server 返回 HTTP ${res.status}：${detail}`)
    }
    const data: unknown = await res.json()
    logTimings(req, data, Date.now() - started)
    // 顺手把这次的 prefill 速度喂给 backend，供「重算上下文大约要多久」使用。
    // 只在 prompt_n 足够大时才采信，避免单 token 续写（prompt_n=1）的噪声估计污染这个值。
    const t = isObj(data) && isObj(data.timings) ? data.timings : {}
    const promptN = asNum(t.prompt_n)
    const pps = asNum(t.prompt_per_second)
    if (pps && promptN && promptN >= 20) backend.reportPrefillSpeed(pps)
    return mapCandidates(data, meta, req.topK)
  } catch (err) {
    // 被取消时返回空数组而不是报错：renderer 自己知道这次请求已取消，会把结果丢掉。
    // 如果这里抛错，前端可能把一次正常的取消当成故障显示出来。
    if (controller.signal.aborted) return []
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