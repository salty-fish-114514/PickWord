/**
 * 通用补全：纠错等后台任务共用的单一接口，使用 SSE 累积模型生成文本。
 *
 * 与 candidates.ts 的区别：这里要的是模型「写出来的文字」而不是下一个 token 的分布；
 * 请求可以带 GBNF 文法把输出锁成可解析的行格式，并指定槽位（默认槽 1，不碰候选的 KV cache）。纠错版本还启用重复输出保护。
 * prompt 由 renderer 按 ModelProfile.template 拼好，这里原样转发。
 *
 * ★ dev 日志会打印 predicted_n 与模型原话前 200 字：2026-10-14 的「纠错一律回无」事故就是靠
 *   `predicted_n=2 stop=eos` 定位的——文法与 Qwen3.5 的回合格式撞车（prompt 缺空思考块），
 *   模型在第一个 token 就坍缩成「无」。排查这类问题先看这行日志，再怀疑模型能力。详见 structure.md 开头。
 */
import { app } from 'electron'
import { backend } from './backend'
import { getMeta } from './candidates'
import { isObj, asNum, asStr } from './ioUtils'
import { readSseStream } from './sse'
import { detectProofreadLoop } from './proofreadGuard'
import type { CompletionRequest, CompletionResult } from '../shared/ipc'

const REQUEST_TIMEOUT_MS = 300_000
const MAX_PREDICT = 2048
const MAX_SLOT = 8

const inflight = new Map<string, AbortController>()

function parseRequest(raw: unknown): CompletionRequest {
  if (!isObj(raw)) throw new Error('补全请求格式错误')
  const { requestId, prompt, idSlot, nPredict, temperature, topP, stop, grammar, promptVersion } = raw
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 100) {
    throw new Error('补全请求缺少有效的 requestId')
  }
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 2_000_000) {
    throw new Error('prompt 为空或过长')
  }
  const slot = Math.round(asNum(idSlot) ?? 1)
  if (slot < 0 || slot > MAX_SLOT) throw new Error('槽位编号无效')
  return {
    requestId,
    prompt,
    idSlot: slot,
    nPredict: Math.min(MAX_PREDICT, Math.max(1, Math.round(asNum(nPredict) ?? 256))),
    temperature: asNum(temperature),
    topP: asNum(topP),
    stop: Array.isArray(stop) ? stop.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 16) : undefined,
    grammar: typeof grammar === 'string' && grammar.length > 0 && grammar.length < 20_000 ? grammar : undefined,
    promptVersion: typeof promptVersion === 'string' && promptVersion.length > 0 && promptVersion.length < 100 ? promptVersion : undefined
  }
}

export async function complete(raw: unknown): Promise<CompletionResult> {
  const req = parseRequest(raw)
  const status = backend.getStatus()
  if (status.state !== 'ready') throw new Error('本地模型尚未就绪')

  const controller = new AbortController()
  inflight.set(req.requestId, controller)
  const started = Date.now()
  try {
    const meta = await getMeta().catch(() => null)
    const slots = meta?.profile.slots ?? 1
    if (req.idSlot >= slots) {
      throw new Error(`当前 llama-server 只开了 ${slots} 个槽位，无法把任务放到槽 ${req.idSlot}；请在「模型与推理」里把并行槽位设为 ${req.idSlot + 1} 以上`)
    }
    if (controller.signal.aborted) return { text: '', stopType: 'cancelled' }

    const body: Record<string, unknown> = {
      prompt: req.prompt,
      n_predict: req.nPredict,
      cache_prompt: true,
      id_slot: req.idSlot,
      temperature: req.temperature ?? 0.2,
      top_p: req.topP ?? 0.9,
      n_probs: 0,
      stream: true
    }
    if (req.stop && req.stop.length > 0) body.stop = req.stop
    if (req.grammar) body.grammar = req.grammar

    const res = await fetch(`${status.baseUrl}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`llama-server 返回 HTTP ${res.status}：${detail}`)
    }

    let text = ''
    let stopType: CompletionResult['stopType'] = 'eos'
    let stopWord: string | undefined
    let timings: Record<string, unknown> = {}
    let guardReason: string | null = null
    let stopSeen = false
    try {
      await readSseStream(res.body, (data) => {
        if (guardReason) return
        const chunk = asStr(data.content)
        if (chunk) {
          text += chunk
          if (req.promptVersion?.startsWith('proofread-')) {
            guardReason = detectProofreadLoop(text)
            if (guardReason) {
              stopType = 'limit'
              stopWord = `proofread_guard:${guardReason}`
              controller.abort()
            }
          }
        }
        if (data.stop === true) {
          stopSeen = true
          const type = asStr(data.stop_type)
          if (type === 'eos' || type === 'limit' || type === 'word') stopType = type
          stopWord = asStr(data.stopping_word) || stopWord
          if (isObj(data.timings)) timings = data.timings
        }
      })
    } catch (err) {
      if (!guardReason) throw err
    }
    if (guardReason) {
      stopType = 'limit'
      stopWord = `proofread_guard:${guardReason}`
    } else if (controller.signal.aborted) {
      return { text: '', stopType: 'cancelled' }
    } else if (!stopSeen) {
      // Unexpected stream end is partial, not a successful EOS.
      stopType = 'limit'
      stopWord = 'stream_incomplete'
    }

    const promptN = asNum(timings.prompt_n)
    const pps = asNum(timings.prompt_per_second)
    if (pps && promptN && promptN >= 20) backend.reportPrefillSpeed(pps)
    if (!app.isPackaged) {
      const preview = text.slice(0, 200).replace(/\n/g, '⏎')
      console.log(
        `[llm] slot=${req.idSlot} prompt_version=${req.promptVersion ?? 'unspecified'} cache_n=${timings.cache_n} prompt_n=${timings.prompt_n} predicted_n=${timings.predicted_n} ` +
          `prompt_ms=${Math.round(asNum(timings.prompt_ms) ?? -1)} total_ms=${Date.now() - started} stop=${stopType}${stopWord ? `(${stopWord})` : ''} ` +
          `grammar=${req.grammar ? 'on' : 'off'} content=${JSON.stringify(preview)}`
      )
    }
    return {
      text,
      stopType,
      stopWord,
      timings: {
        cacheN: asNum(timings.cache_n),
        promptN,
        promptMs: asNum(timings.prompt_ms),
        predictedN: asNum(timings.predicted_n),
        predictedMs: asNum(timings.predicted_ms)
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return { text: '', stopType: 'cancelled' }
    throw err
  } finally {
    if (inflight.get(req.requestId) === controller) inflight.delete(req.requestId)
  }
}

export function cancelCompletion(requestId: unknown): void {
  if (typeof requestId !== 'string') return
  inflight.get(requestId)?.abort()
}
