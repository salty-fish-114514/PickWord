/**
 * llama-server 进程看护：启动、/health 轮询、残留进程清理、日志落盘与隐私过滤、状态广播。
 * 配置读取在 backendConfig.ts，进度估算在 loadProgress.ts，设备列表在 devices.ts。
 */
import { app, BrowserWindow } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { BackendConfig, BackendProgress, BackendState, BackendStatus, IpcPushMap } from '../shared/ipc'
import { readBackendConfig, resolveConfigPath } from './backendConfig'
import { LoadProgressTracker } from './loadProgress'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 就绪多久后停止写磁盘日志：既能看到启动与首次推理耗时，又不让长时间写作的内容进日志。 */
const DISK_LOG_GRACE_MS = 60_000

export function pushToWindows<C extends keyof IpcPushMap>(channel: C, payload: IpcPushMap[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
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
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const m = stdout.match(/^"([^"]+)"/m)
      resolve(m ? m[1] : null)
    })
  })
}

class LlamaBackend {
  /** 每次 start() +1；candidates.ts 用它判断模型画像缓存是否过期。 */
  generation = 0

  private child: ChildProcess | null = null
  /** 上一个子进程的退出信号：重启时先等它真正退出，端口才会释放。 */
  private lastExit: Promise<void> | null = null
  private log: fs.WriteStream | null = null
  private allowDiskLogging = true
  private diskLogTimer: NodeJS.Timeout | null = null
  private stopping = false
  private status: BackendStatus = { state: 'stopped', message: '尚未启动', baseUrl: '' }

  private stdoutBuf = ''
  private stderrBuf = ''
  private progressTimer: NodeJS.Timeout | null = null
  private readonly progress = new LoadProgressTracker(this.statsFile)
  private lastProgress: BackendProgress = { fraction: 0, summary: '尚未启动' }

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
    return this.lastProgress
  }

  reportPrefillSpeed(tokensPerSecond: number): void {
    this.progress.reportPrefillSpeed(tokensPerSecond)
  }

  private setStatus(state: BackendState, message: string): void {
    this.status = { ...this.status, state, message }
    pushToWindows('backend:status', this.status)
  }

  private pushProgress(): void {
    this.lastProgress = this.progress.snapshot(this.status.state === 'ready')
    pushToWindows('backend:progress', this.lastProgress)
  }

  /** stdout/stderr 的字节流拆成行：写日志（隐私过滤）+ 喂给进度估算。 */
  private feedOutput(chunk: string, which: 'stdoutBuf' | 'stderrBuf'): void {
    this[which] += chunk
    const lines = this[which].split('\n')
    this[which] = lines.pop() ?? ''
    for (const line of lines) {
      // llama-server 打印 prompt 片段时通常带 slot / prompt / token 关键字，不落盘
      const sensitive = /slot|prompt|token/i.test(line)
      if (this.allowDiskLogging && !sensitive) this.log?.write(line + '\n')
      if (this.progress.feedLine(line)) this.pushProgress()
    }
  }

  /** 配置无效 / 文件缺失时不把「首次设置」当成进程错误；返回 null 表示不该启动。 */
  private loadStartableConfig(): BackendConfig | null {
    const result = readBackendConfig()
    if (!result.ok) {
      this.setStatus('stopped', result.message)
      return null
    }
    return {
      ...result.config,
      exe: resolveConfigPath(result.config.exe),
      model: resolveConfigPath(result.config.model)
    }
  }

  async start(): Promise<void> {
    if (this.child) return
    const cfg = this.loadStartableConfig()
    if (!cfg) return

    this.generation += 1
    this.stopping = false
    fs.mkdirSync(this.dataDir, { recursive: true })
    this.progress.begin()
    this.lastProgress = this.progress.snapshot(false)

    try {
      this.status.baseUrl = `http://127.0.0.1:${cfg.port}`
      this.setStatus('starting', '正在启动模型后端……')

      if (!fs.existsSync(cfg.exe)) throw new Error(`找不到后端程序：${cfg.exe}`)
      if (!fs.existsSync(cfg.model)) throw new Error(`找不到模型文件：${cfg.model}`)

      if (this.lastExit) await Promise.race([this.lastExit, sleep(8000)])
      await this.killStaleProcess()
      if (!(await isPortFree(cfg.port))) {
        throw new Error(`端口 ${cfg.port} 被其他程序占用，请在「模型与推理」里换一个端口`)
      }

      if (fs.existsSync(this.logFile)) fs.renameSync(this.logFile, this.logFile + '.prev')
      this.log = fs.createWriteStream(this.logFile)

      // -m / --host / --port 由这里拼；--parallel 等在 cfg.args 里（部署时写入）
      const args = ['-m', cfg.model, '--host', '127.0.0.1', '--port', String(cfg.port), ...cfg.args]
      this.log.write(`[launcher] ${cfg.exe} ${args.join(' ')}\n`)

      const child = spawn(cfg.exe, args, {
        cwd: path.dirname(cfg.exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      })
      this.child = child
      // exit 与 error 都要接：启动就失败（比如 exe 没有执行权限）时只会触发 error，
      // 只等 exit 会让下一次重启白等满 8 秒才把错误报给用户看。
      this.lastExit = new Promise((resolve) => {
        child.once('exit', () => resolve())
        child.once('error', () => resolve())
      })
      child.stdout?.on('data', (chunk: Buffer) => this.feedOutput(chunk.toString('utf8'), 'stdoutBuf'))
      child.stderr?.on('data', (chunk: Buffer) => this.feedOutput(chunk.toString('utf8'), 'stderrBuf'))
      fs.writeFileSync(this.pidFile, String(child.pid))

      child.on('error', (err) => {
        if (this.child === child) this.setStatus('error', `无法启动后端：${err.message}`)
      })
      child.on('exit', (code, signal) => {
        if (this.child !== child) return // 已被 stop() 结束或被新一轮 start() 替换
        this.child = null
        this.setStatus('error', `模型后端意外退出（code=${code}, signal=${signal}）。日志：${this.logFile}`)
      })

      this.setStatus('loading', '正在加载模型，大模型首次加载可能需要几分钟……')
      // 每 400ms 刷新一次：即使两条日志之间隔很久，进度条也能靠历史耗时平滑前进
      this.progressTimer = setInterval(() => {
        if (this.status.state === 'loading' || this.status.state === 'starting') this.pushProgress()
      }, 400)

      await this.waitUntilReady(cfg)
      this.progress.finish()
      this.pushProgress() // state 已是 ready，fraction=1
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
          if (this.diskLogTimer) clearTimeout(this.diskLogTimer)
          this.diskLogTimer = setTimeout(() => {
            this.allowDiskLogging = false
            this.log?.write('\n[launcher] 已进入就绪状态超过 60s，为保护隐私已停止磁盘日志记录。\n')
          }, DISK_LOG_GRACE_MS)
          return
        }
      } catch {
        // 服务尚未监听，继续等
      }
      await sleep(1000)
    }
    throw new Error(`等待模型加载超时（${cfg.startupTimeoutSec} 秒）`)
  }

  /** 上次崩溃可能留下的 llama-server：按 pid 文件找到并结束，避免端口被占。 */
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
    this.allowDiskLogging = true
    if (this.diskLogTimer) {
      clearTimeout(this.diskLogTimer)
      this.diskLogTimer = null
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

  /** 配置改动后的统一入口：谁写了 backend.json 谁调用它。 */
  restart(): Promise<void> {
    this.stop()
    return this.start()
  }
}

export const backend = new LlamaBackend()
