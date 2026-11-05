/**
 * 通用一次性补全：纠错、人设校验等后台任务共用的单一接口。
 *
 * 与 candidates.ts 的区别：这里要的是模型「写出来的文字」而不是下一个 token 的分布；
 * 请求可以带 GBNF 文法把输出锁成可解析的行格式，并指定槽位（默认槽 1，不碰候选的 KV cache）。
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
import type { CompletionRequest, CompletionResult } from '../shared/ipc'

const REQUEST_TIMEOUT_MS = 300_000
const MAX_PREDICT = 2048
const MAX_SLOT = 8

const inflight = new Map<string, AbortController>()

function parseRequest(raw: unknown): CompletionRequest {
  if (!isObj(raw)) throw new Error('补全请求格式错误')
  const { requestId, prompt, idSlot, nPredict, temperature, topP, stop, grammar } = raw
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
    grammar: typeof grammar === 'string' && grammar.length > 0 && grammar.length < 20_000 ? grammar : undefined
  }
}

function mapStopType(data: Record<string, unknown>): CompletionResult['stopType'] {
  const type = asStr(data.stop_type)
  if (type === 'eos' || type === 'limit' || type === 'word') return type
  // 旧版字段
  if (data.stopped_eos === true) return 'eos'
  if (data.stopped_word === true) return 'word'
  if (data.stopped_limit === true) return 'limit'
  return 'eos'
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
      stream: false
    }
    if (req.stop && req.stop.length > 0) body.stop = req.stop
    if (req.grammar) body.grammar = req.grammar

    const res = await fetch(`${status.baseUrl}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300)
      throw new Error(`llama-server 返回 HTTP ${res.status}：${detail}`)
    }
    const data: unknown = await res.json()
    const d = isObj(data) ? data : {}
    const t = isObj(d.timings) ? d.timings : {}
    const promptN = asNum(t.prompt_n)
    const pps = asNum(t.prompt_per_second)
    if (pps && promptN && promptN >= 20) backend.reportPrefillSpeed(pps)
    if (!app.isPackaged) {
      const preview = (asStr(d.content) ?? '').slice(0, 200).replace(/\n/g, '⏎')
      console.log(
        `[llm] slot=${req.idSlot} cache_n=${t.cache_n} prompt_n=${t.prompt_n} predicted_n=${t.predicted_n} ` +
          `prompt_ms=${Math.round(asNum(t.prompt_ms) ?? -1)} total_ms=${Date.now() - started} stop=${asStr(d.stop_type)} ` +
          `grammar=${req.grammar ? 'on' : 'off'} content=${JSON.stringify(preview)}`
      )
    }
    return {
      text: asStr(d.content) ?? '',
      stopType: mapStopType(d),
      stopWord: asStr(d.stopping_word) || undefined,
      timings: {
        cacheN: asNum(t.cache_n),
        promptN,
        promptMs: asNum(t.prompt_ms),
        predictedN: asNum(t.predicted_n),
        predictedMs: asNum(t.predicted_ms)
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
