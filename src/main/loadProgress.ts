/**
 * 模型加载进度估算：日志阶段标记 + 历史耗时比例。
 *
 * 与进程看护分开放：换 llama.cpp 版本时只需要复核这里的 PHASE_MARKERS，
 * backend.ts 完全不用动。
 */
import fs from 'node:fs'
import type { BackendProgress } from '../shared/ipc'

/**
 * 根据 llama-server 日志里的关键字推断加载阶段。
 * ⚠ 这些是 b8868 实测的输出字符串；换版本后措辞可能变化。
 * 允许「一个标记都没匹配到」——此时 fraction 停在 0，只显示通用提示，不会报错。
 */
const PHASE_MARKERS: ReadonlyArray<{ includes: string; fraction: number; summary: string }> = [
  { includes: 'main: loading model', fraction: 0.03, summary: '正在读取模型文件…' },
  { includes: 'llama_model_loader: loaded meta data', fraction: 0.08, summary: '已读取模型元数据…' },
  { includes: 'load_tensors: loading model tensors', fraction: 0.15, summary: '正在加载模型权重…' },
  { includes: 'llama_context: constructing llama_context', fraction: 0.75, summary: '正在初始化推理上下文…' },
  { includes: 'llama_kv_cache: size', fraction: 0.85, summary: '正在分配显存缓存…' },
  { includes: 'warming up the model', fraction: 0.92, summary: '正在预热模型…' },
  { includes: 'load_model: initializing slots', fraction: 0.96, summary: '正在初始化推理槽位…' },
  { includes: 'main: model loaded', fraction: 0.99, summary: '模型已加载，等待服务启动…' }
]

export class LoadProgressTracker {
  private markerIndex = 0
  private markerFloor = 0
  private modelSizeText: string | undefined
  private startedAt = 0
  private lastDurationMs: number | null = null
  private summary = '尚未启动'
  private prefillTps: number | undefined

  /** statsFile 记录上次成功加载耗时，用来把这次进度条走得更顺滑。 */
  constructor(private readonly statsFile: string) {}

  /** 新一轮加载开始：读历史耗时，清零阶段。 */
  begin(): void {
    this.readStats()
    this.markerIndex = 0
    this.markerFloor = 0
    this.modelSizeText = undefined
    this.prefillTps = undefined
    this.startedAt = Date.now()
    this.summary = '正在启动模型后端…'
  }

  /** 加载成功：记录耗时（新旧各半平滑，避免一次系统卡顿把估计拉偏）。 */
  finish(): void {
    if (!this.startedAt) return
    const durationMs = Date.now() - this.startedAt
    const next = this.lastDurationMs ? Math.round(this.lastDurationMs * 0.5 + durationMs * 0.5) : durationMs
    this.lastDurationMs = next
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify({ lastDurationMs: next }))
    } catch {
      // 写失败不影响功能，只是下次没有参考基准
    }
  }

  /** 候选请求拿到 timings.prompt_per_second 后调用，供「重算上下文大约要多久」估算。 */
  reportPrefillSpeed(tokensPerSecond: number): void {
    if (Number.isFinite(tokensPerSecond) && tokensPerSecond > 0) this.prefillTps = tokensPerSecond
  }

  /** 喂一行日志；命中新阶段返回 true（调用方据此立即推送一次）。阶段只前进不后退。 */
  feedLine(line: string): boolean {
    const size = line.match(/file size\s*=\s*([\d.]+\s*\w+)/)
    if (size) this.modelSizeText = size[1]

    for (let i = this.markerIndex; i < PHASE_MARKERS.length; i++) {
      const marker = PHASE_MARKERS[i]
      if (!line.includes(marker.includes)) continue
      this.markerIndex = i + 1
      this.markerFloor = Math.max(this.markerFloor, marker.fraction)
      this.summary =
        marker.includes.includes('loading model tensors') && this.modelSizeText
          ? `正在加载模型权重（共 ${this.modelSizeText}）…`
          : marker.summary
      return true
    }
    return false
  }

  /**
   * 当前快照。fraction 取「日志标记下限」与「已用时间 / 上次总耗时」的较大者（封顶 0.97），
   * 这样两条日志之间隔很久时进度条也不会呆住；没有历史数据时只能按标记跳着走，不显示 ETA。
   */
  snapshot(ready: boolean): BackendProgress {
    const out: BackendProgress = {
      fraction: ready ? 1 : this.computeFraction(),
      summary: this.summary,
      prefillTokensPerSecond: this.prefillTps
    }
    if (!ready && this.lastDurationMs && this.startedAt) {
      const remainMs = this.lastDurationMs - (Date.now() - this.startedAt)
      if (remainMs > 0) out.etaSeconds = Math.round(remainMs / 1000)
    }
    return out
  }

  private computeFraction(): number {
    if (this.lastDurationMs && this.startedAt) {
      const ratio = (Date.now() - this.startedAt) / this.lastDurationMs
      return Math.min(0.97, Math.max(this.markerFloor, ratio))
    }
    return this.markerFloor
  }

  private readStats(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'))
      const ms = (parsed as { lastDurationMs?: unknown } | null)?.lastDurationMs
      this.lastDurationMs = typeof ms === 'number' && ms > 0 ? ms : null
    } catch {
      this.lastDurationMs = null // 第一次启动，还没有历史数据
    }
  }
}
