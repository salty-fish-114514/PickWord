/**
 * 短句展开：对「候选提示词 + 候选词」继续解码，流式推回 renderer。
 *
 * 与 llm.ts 的区别只有两点：stream: true（边出边显示，按数字键可取已出的部分）、
 * 走槽 0（与候选共用前缀，llama.cpp 截回公共前缀后只解码，零额外 prefill）。
 * 停止符由 renderer 指定（短句：`，。！？；…\n`）。
 */
import { app } from 'electron'
import { backend, pushToWindows } from './backend'
import { getMeta } from './candidates'
import { isObj, asNum, asStr } from './ioUtils'
import { readSseStream } from './sse'
import type { ExpandRequest, ExpandResult } from '../shared/ipc'

const REQUEST_TIMEOUT_MS = 60_000
const MAX_PREDICT = 64

const inflight = new Map<string, AbortController>()

function parseRequest(raw: unknown): ExpandRequest {
  if (!isObj(raw)) throw new Error('展开请求格式错误')
  const { requestId, prompt, idSlot, nPredict, temperature, topP, repeatPenalty, stop } = raw
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 100) throw new Error('展开请求缺少 requestId')
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 2_000_000) throw new Error('prompt 为空或过长')
  const slot = Math.round(asNum(idSlot) ?? 0)
  if (slot < 0 || slot > 8) throw new Error('槽位编号无效')
  return {
    requestId,
    prompt,
    idSlot: slot,
    nPredict: Math.min(MAX_PREDICT, Math.max(1, Math.round(asNum(nPredict) ?? 24))),
    temperature: asNum(temperature),
    topP: asNum(topP),
    repeatPenalty: asNum(repeatPenalty),
    stop: Array.isArray(stop) ? stop.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 16) : undefined
  }
}

export async function expand(raw: unknown): Promise<ExpandResult> {
  const req = parseRequest(raw)
  const status = backend.getStatus()
  if (status.state !== 'ready') throw new Error('本地模型尚未就绪')

  const controller = new AbortController()
  inflight.set(req.requestId, controller)
  const cancelled = (): ExpandResult => ({ requestId: req.requestId, text: '', stopType: 'cancelled' })
  const started = Date.now()
  let text = ''
  try {
    const meta = await getMeta().catch(() => null)
    const slots = meta?.profile.slots ?? 1
    if (req.idSlot >= slots) throw new Error(`当前 llama-server 只开了 ${slots} 个槽位`)
    if (controller.signal.aborted) return cancelled()

    const body: Record<string, unknown> = {
      prompt: req.prompt,
      n_predict: req.nPredict,
      cache_prompt: true,
      id_slot: req.idSlot,
      temperature: req.temperature ?? 0.6,
      top_p: req.topP ?? 0.9,
      repeat_penalty: req.repeatPenalty ?? 1.1,
      n_probs: 0,
      stream: true
    }
    if (req.stop && req.stop.length > 0) body.stop = req.stop

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

    let stopType: ExpandResult['stopType'] = 'eos'
    let stopWord: string | undefined
    let timings: Record<string, unknown> = {}
    await readSseStream(res.body, (data) => {
      const chunk = asStr(data.content)
      if (chunk) {
        text += chunk
        pushToWindows('expand:chunk', { requestId: req.requestId, text: chunk })
      }
      if (data.stop === true) {
        const type = asStr(data.stop_type)
        if (type === 'eos' || type === 'limit' || type === 'word') stopType = type
        stopWord = asStr(data.stopping_word) || undefined
        if (isObj(data.timings)) timings = data.timings
      }
    })
    if (controller.signal.aborted) return cancelled()
    if (!app.isPackaged) {
      console.log(
        `[expand] slot=${req.idSlot} cache_n=${timings.cache_n} prompt_n=${timings.prompt_n} predicted_n=${timings.predicted_n} ` +
          `total_ms=${Date.now() - started} stop=${stopType}${stopWord ? `(${JSON.stringify(stopWord)})` : ''} text=${JSON.stringify(text)}`
      )
    }
    return { requestId: req.requestId, text, stopType, stopWord }
  } catch (err) {
    if (controller.signal.aborted) return cancelled()
    throw err
  } finally {
    if (inflight.get(req.requestId) === controller) inflight.delete(req.requestId)
  }
}

export function cancelExpand(requestId: unknown): void {
  if (typeof requestId !== 'string') return
  inflight.get(requestId)?.abort()
}
