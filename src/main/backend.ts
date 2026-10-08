import { app, BrowserWindow } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { BackendProgress, BackendState, BackendStatus } from '../shared/types'
import { getBackendConfigDir, getSetupState } from './setup'

interface BackendConfig {
  exe: string
  model: string
  port: number
  args: string[]
  startupTimeoutSec: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function configDir(): string {
  return getBackendConfigDir()
}

export function loadConfig(): BackendConfig {
  const dir = configDir()
  const file = path.join(dir, 'backend.json')
  if (!fs.existsSync(file)) throw new Error(`找不到后端配置文件：${file}`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(dir, p))
  return {
    exe: abs(raw.exe),
    model: abs(raw.model),
    port: Number(raw.port ?? 18765),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    startupTimeoutSec: Number(raw.startupTimeoutSec ?? 600)
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function imageNameOfPid(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const m = stdout.match(/^"([^"]+)"/m)
        resolve(m ? m[1] : null)
      }
    )
  })
}

/**
 * 根据 llama-server 日志里的关键字推断加载阶段。
 * ⚠ 这些是 b8868 这个版本实测的真实输出字符串；换 llama.cpp 版本后措辞可能变化。
 * 设计上允许「一个标记都没匹配到」——此时 fraction 停在 0，只显示通用提示，不会报错。
 * fraction 是「这个阶段大概到了百分之几」的粗略标尺，仅用于安抚用户，不代表精确进度。
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

class LlamaBackend {
  generation = 0

  private allowDiskLogging = true;
  private diskLogTimer: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null
  private log: fs.WriteStream | null = null
  private stopping = false
  private status: BackendStatus = { state: 'stopped', message: '尚未启动', baseUrl: '' }

  // ─── 加载进度相关状态 ───────────────────────────────────────────
  private stdoutBuf = ''
  private stderrBuf = ''
  private markerIndex = 0
  private markerFloor = 0
  private modelSizeText: string | undefined
  private loadStartedAt = 0
  private progressTimer: NodeJS.Timeout | null = null
  private lastPrefillTps: number | undefined
  private loadStats: { lastDurationMs: number } | null = null
  private progress: BackendProgress = { fraction: 0, summary: '尚未启动' }

  private get dataDir(): string {
    return path.join(app.getPath('userData'), 'backend')
  }
  private get pidFile(): string {
    return path.join(this.dataDir, 'llama-server.pid')
  }
  private get statsFile(): string {
    return path.join(this.dataDir, 'load-stats.json')
  }
  get logFile(): string {
    return path.join(this.dataDir, 'llama-server.log')
  }

  getStatus(): BackendStatus {
    return this.status
  }

  getProgress(): BackendProgress {
    return this.progress
  }

  /** 候选请求拿到 timings.prompt_per_second 后调用这个，更新「重算上下文大约要多久」的估算依据。 */
  reportPrefillSpeed(tokensPerSecond: number): void {
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return
    this.lastPrefillTps = tokensPerSecond
  }

  private setStatus(state: BackendState, message: string): void {
    this.status = { ...this.status, state, message }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('backend:status', this.status)
    }
  }

  // ─── 读写「上次加载花了多久」，用来把本次进度条走得更顺滑 ──────────
  private readStats(): void {
    try {
      const raw = fs.readFileSync(this.statsFile, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { lastDurationMs?: unknown }).lastDurationMs === 'number' &&
        (parsed as { lastDurationMs: number }).lastDurationMs > 0
      ) {
        this.loadStats = { lastDurationMs: (parsed as { lastDurationMs: number }).lastDurationMs }
      }
    } catch {
      this.loadStats = null // 第一次启动，还没有历史数据
    }
  }

  private writeStats(durationMs: number): void {
    // 新旧各半的滑动平均，避免某次系统卡顿（比如后台在装更新）把下次估计拉偏太多
    const next = this.loadStats ? Math.round(this.loadStats.lastDurationMs * 0.5 + durationMs * 0.5) : durationMs
    this.loadStats = { lastDurationMs: next }
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.loadStats))
    } catch {
      // 写失败不影响功能，只是下次没有参考基准
    }
  }

  // ─── 日志解析：把 stdout/stderr 的字节流拆成一行一行来识别阶段 ────
  private feedOutput(chunk: string, which: 'stdoutBuf' | 'stderrBuf'): void {
    this[which] += chunk;
    const lines = this[which].split('\n');
    this[which] = lines.pop() ?? ''; 

    for (const line of lines) {
      // ─── 隐私过滤：如果包含敏感词，不写入磁盘日志 ───
      // llama-server 打印 Prompt 时通常带有 "slot" 关键字
      const isSensitive = /slot|prompt|token/i.test(line);

      if (this.allowDiskLogging && !isSensitive) {
        this.log?.write(line + '\n');
      }

      this.handleLogLine(line);
    }
  }

  private handleLogLine(line: string): void {
    const sizeMatch = line.match(/file size\s*=\s*([\d.]+\s*\w+)/)
    if (sizeMatch) this.modelSizeText = sizeMatch[1]

    // 阶段只允许前进：避免某一行意外同时包含更早阶段的关键字导致进度倒退
    for (let i = this.markerIndex; i < PHASE_MARKERS.length; i++) {
      if (line.includes(PHASE_MARKERS[i].includes)) {
        this.markerIndex = i + 1
        let summary = PHASE_MARKERS[i].summary
        if (PHASE_MARKERS[i].includes.includes('loading model tensors') && this.modelSizeText) {
          summary = `正在加载模型权重（共 ${this.modelSizeText}）…`
        }
        this.markerFloor = Math.max(this.markerFloor, PHASE_MARKERS[i].fraction)
        this.progress = { ...this.progress, summary }
        this.pushProgressNow()
        break
      }
    }
  }

  /**
   * 融合两种信号算出当前 fraction：
   *   - markerFloor：日志文字标记给出的「下限」，一旦到达某阶段就不会倒退；
   *   - 历史耗时比例：有上次成功启动的耗时数据时，用「已用时间 / 上次总耗时」平滑推进，
   *     这样即使两条日志之间隔了很久没输出，进度条也不会呆住不动。
   * 没有历史数据（例如第一次启动）时，只能靠 markerFloor 跳着走，不显示 ETA。
   */
  private computeFraction(): number {
    if (this.loadStats && this.loadStartedAt) {
      const elapsed = Date.now() - this.loadStartedAt
      const ratio = elapsed / this.loadStats.lastDurationMs
      return Math.min(0.97, Math.max(this.markerFloor, ratio))
    }
    return this.markerFloor
  }

  private pushProgressNow(): void {
    const snapshot: BackendProgress = {
      fraction: this.status.state === 'ready' ? 1 : this.computeFraction(),
      summary: this.progress.summary,
      prefillTokensPerSecond: this.lastPrefillTps
    }
    if (this.loadStats && this.loadStartedAt && this.status.state !== 'ready') {
      const remainMs = this.loadStats.lastDurationMs - (Date.now() - this.loadStartedAt)
      if (remainMs > 0) snapshot.etaSeconds = Math.round(remainMs / 1000)
    }
    this.progress = snapshot
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('backend:progress', snapshot)
    }
  }

  async start(): Promise<void> {
    if (this.child) return

    // 缺配置或后端文件被移动时，不把正常的首次设置状态当成进程启动错误。
    const setup = getSetupState()
    if (!setup.configured) {
      this.setStatus('stopped', setup.message)
      return
    }

    this.generation += 1
    this.stopping = false
    fs.mkdirSync(this.dataDir, { recursive: true })

    // 重置本次加载的进度状态
    this.readStats()
    this.markerIndex = 0
    this.markerFloor = 0
    this.modelSizeText = undefined
    this.lastPrefillTps = undefined
    this.progress = { fraction: 0, summary: '正在启动模型后端…' }

    try {
      const cfg = loadConfig()
      this.status.baseUrl = `http://127.0.0.1:${cfg.port}`
      this.setStatus('starting', '正在启动模型后端……')

      if (!fs.existsSync(cfg.exe)) throw new Error(`找不到后端程序：${cfg.exe}`)
      if (!fs.existsSync(cfg.model)) throw new Error(`找不到模型文件：${cfg.model}`)

      await this.killStaleProcess()
      if (!(await isPortFree(cfg.port))) {
        throw new Error(`端口 ${cfg.port} 被其他程序占用，请在 backend.json 里换一个端口`)
      }

      if (fs.existsSync(this.logFile)) fs.renameSync(this.logFile, this.logFile + '.prev')
      this.log = fs.createWriteStream(this.logFile)

      const args = ['-m', cfg.model, '--host', '127.0.0.1', '--port', String(cfg.port), '--parallel', '1', ...cfg.args]
      this.log.write(`[launcher] ${cfg.exe} ${args.join(' ')}\n`)

      this.child = spawn(cfg.exe, args, {
        cwd: path.dirname(cfg.exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      })

      // 原来是直接 .pipe(this.log)；现在要同时写日志文件和解析进度，所以改成手动监听 data 事件
      // 修改后的监听逻辑：统一交给 feedOutput，由它负责过滤并写入磁盘
      this.child.stdout?.on('data', (chunk: Buffer) => {
        this.feedOutput(chunk.toString('utf8'), 'stdoutBuf');
      });
      this.child.stderr?.on('data', (chunk: Buffer) => {
        this.feedOutput(chunk.toString('utf8'), 'stderrBuf');
      });
      fs.writeFileSync(this.pidFile, String(this.child.pid))

      this.child.on('error', (err) => this.setStatus('error', `无法启动后端：${err.message}`))
      this.child.on('exit', (code, signal) => {
        this.child = null
        if (!this.stopping) {
          this.setStatus('error', `模型后端意外退出（code=${code}, signal=${signal}）。日志：${this.logFile}`)
        }
      })

      this.loadStartedAt = Date.now()
      this.setStatus('loading', '正在加载模型，大模型首次加载可能需要几分钟……')

      // 每 400ms 刷新一次进度：即使两条日志之间隔了很久，进度条也能靠历史耗时平滑往前走
      this.progressTimer = setInterval(() => {
        if (this.status.state === 'loading' || this.status.state === 'starting') this.pushProgressNow()
      }, 400)

      await this.waitUntilReady(cfg)

      const durationMs = Date.now() - this.loadStartedAt
      this.writeStats(durationMs)
      this.pushProgressNow() // fraction 会在这里被置为 1（因为 status.state 已经是 ready）
    } catch (err) {
      this.setStatus('error', (err as Error).message)
      this.stop(true)
    } finally {
      if (this.progressTimer) {
        clearInterval(this.progressTimer)
        this.progressTimer = null
      }
    }
  }

  private async waitUntilReady(cfg: BackendConfig): Promise<void> {
    const deadline = Date.now() + cfg.startupTimeoutSec * 1000
    while (Date.now() < deadline) {
      if (this.stopping || this.status.state === 'error') return
      try {
        const res = await fetch(`${this.status.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.status === 200) {
          this.setStatus('ready', '模型已就绪')
          
          // ─── 关键改动：就绪后 60 秒关闭磁盘日志 ───
          // 这保证了你能看到启动过程和第一次推理的耗时日志，
          // 但之后长时间写作的隐私和存储压力都被消灭了。
          if (this.diskLogTimer) clearTimeout(this.diskLogTimer);
          this.diskLogTimer = setTimeout(() => {
            this.allowDiskLogging = false;
            this.log?.write('\n[launcher] 已进入就绪状态超过 60s，为保护隐私已停止磁盘日志记录。\n');
            // 注意：不建议直接关闭 this.log 句柄，只需停止写入即可，防止后续误调用
          }, 60000);

          return
        }
      } catch {
        // 服务尚未监听，继续等
      }
      await sleep(1000)
    }
    throw new Error(`等待模型加载超时（${cfg.startupTimeoutSec} 秒）`)
  }

  private async killStaleProcess(): Promise<void> {
    if (!fs.existsSync(this.pidFile)) return
    const pid = Number(fs.readFileSync(this.pidFile, 'utf8'))
    fs.unlinkSync(this.pidFile)
    if (!pid) return
    const name = await imageNameOfPid(pid)
    if (name?.toLowerCase() === 'llama-server.exe') {
      try {
        process.kill(pid)
      } catch {
        // 已经不在了
      }
      await sleep(1500)
    }
  }

  stop(keepStatus = false): void {
    this.stopping = true
    this.allowDiskLogging = true; // 重置开关
    if (this.diskLogTimer) {
      clearTimeout(this.diskLogTimer);
      this.diskLogTimer = null;
    }
    if (this.child && this.child.exitCode === null) this.child.kill()
    this.child = null
    this.log?.end()
    this.log = null
    try {
      fs.unlinkSync(this.pidFile)
    } catch {
      // ignore
    }
    if (!keepStatus) this.setStatus('stopped', '后端已停止')
  }
}

export const backend = new LlamaBackend()