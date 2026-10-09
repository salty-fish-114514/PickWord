import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile, type ChildProcess } from 'node:child_process'
import { BrowserWindow, net } from 'electron'
import type { DownloadProgress } from '../shared/ipc'

export function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
}

const PARTIAL_SUFFIX = '.downloading'

/**
 * 删除某个目标文件对应的下载临时文件。
 * Windows 下文件句柄可能稍晚才释放，所以 rm 会自动重试几次。
 */
export async function cleanupPartialDownload(destPath: string): Promise<void> {
  try {
    await fs.promises.rm(destPath + PARTIAL_SUFFIX, {
      force: true,
      maxRetries: 5,
      retryDelay: 200
    })
  } catch {
    // 清理失败不覆盖原始错误
  }
}

/** 可重试的错误：网络抖动、停滞、5xx 等 */
function retryableError(message: string): Error {
  const err = new Error(message)
  ;(err as { retryable?: boolean }).retryable = true
  return err
}

/** 不可重试的错误：404/403 等，应换下一个源 */
function fatalError(message: string): Error {
  const err = new Error(message)
  ;(err as { retryable?: boolean }).retryable = false
  return err
}

function isRetryable(err: unknown): boolean {
  const flag = (err as { retryable?: boolean })?.retryable
  if (typeof flag === 'boolean') return flag
  // 没有显式标记的错误多数是底层网络错误，默认可以重试
  return true
}

/** 可被取消打断的延时 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 从 "bytes 0-1023/2048" 中解析总大小 */
function parseTotalFromContentRange(header: string | null): number {
  if (!header) return -1
  const match = /\/(\d+)\s*$/.exec(header)
  return match ? Number(match[1]) : -1
}

/**
 * 下载大文件，支持取消、断点续传和同一个源的自动重试。
 *
 * - 用户取消时删除临时文件，并抛出包含 'aborted' 的错误。
 * - 网络抖动、停滞、5xx、429 时在同一个源上续传重试。
 * - 404/403 等错误不重试，直接抛出，由外层切换源。
 * - keepPartialOnFailure = true 时，失败后保留临时文件，供下一个源续传，
 *   最终清理由调用方负责（downloadWithMirrors 使用）。
 *   取消时无论这个参数如何都会删除临时文件。
 */
export async function downloadFile(
  url: string,
  destPath: string,
  filenameForUi: string,
  signal: AbortSignal,
  overallFractionBase = 0,
  overallFractionWeight = 0.5,
  stallTimeoutMs = 15_000,       // 连续多久没有新数据视为卡死
  maxRetries = 3,                // 同一个源最多尝试 3 次（首次 + 重试 2 次）
  connectTimeoutMs = 10_000,     // 等待响应头的超时
  keepPartialOnFailure = false   // 由调用方负责跨源续传和最终清理
): Promise<void> {
  const tempPath = destPath + PARTIAL_SUFFIX

  const isAbort = (err: unknown): boolean =>
    signal.aborted || (err instanceof Error && err.message === 'aborted')

  // 单独调用时不复用上次崩溃残留的临时文件，从头下载
  if (!keepPartialOnFailure) {
    await cleanupPartialDownload(destPath)
  }

  /** 单次尝试：根据临时文件当前大小续传 */
  async function attemptDownload(): Promise<void> {
    if (signal.aborted) throw new Error('aborted')

    let resumeFrom = 0
    try {
      if (fs.existsSync(tempPath)) resumeFrom = fs.statSync(tempPath).size
    } catch {
      resumeFrom = 0
    }

    // 用户取消和连接超时都通过这个控制器中止 fetch
    const attemptController = new AbortController()
    const forwardAbort = (): void => attemptController.abort()
    signal.addEventListener('abort', forwardAbort, { once: true })
    if (signal.aborted) attemptController.abort()

    const connectTimer = setTimeout(() => attemptController.abort(), connectTimeoutMs)

    const headers: Record<string, string> = {}
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`

    let response: Response
    try {
      response = await net.fetch(url, { signal: attemptController.signal, headers })
    } catch (err) {
      clearTimeout(connectTimer)
      signal.removeEventListener('abort', forwardAbort)
      if (signal.aborted) throw new Error('aborted')
      throw retryableError(`连接失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    clearTimeout(connectTimer)

    let writeFlags: 'a' | 'w' = 'a'

    if (resumeFrom > 0 && response.status === 200) {
      // 服务器忽略了 Range，只能从头覆盖写入
      resumeFrom = 0
      writeFlags = 'w'
    } else if (response.status === 416) {
      signal.removeEventListener('abort', forwardAbort)
      try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
      throw retryableError('续传范围无效，已重置并重试')
    }

    if (response.status !== 200 && response.status !== 206) {
      signal.removeEventListener('abort', forwardAbort)
      const transient =
        response.status >= 500 || response.status === 408 || response.status === 429
      const msg = `下载失败: HTTP ${response.status} ${response.statusText}`
      throw transient ? retryableError(msg) : fatalError(msg)
    }

    if (!response.body) {
      signal.removeEventListener('abort', forwardAbort)
      throw retryableError('服务器返回了空的响应体')
    }

    let totalBytes = -1
    if (response.status === 206) {
      totalBytes = parseTotalFromContentRange(response.headers.get('content-range'))
      if (totalBytes < 0) {
        const remaining = Number(response.headers.get('content-length') ?? -1)
        if (remaining >= 0) totalBytes = resumeFrom + remaining
      }
    } else {
      totalBytes = Number(response.headers.get('content-length') ?? -1)
    }

    if (totalBytes > 0 && resumeFrom > totalBytes) {
      signal.removeEventListener('abort', forwardAbort)
      try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
      throw retryableError('本地缓存大于文件总大小，已重置并重试')
    }

    let receivedBytes = resumeFrom
    let lastReportTime = 0

    const reportProgress = (): void => {
      let fraction = overallFractionBase
      if (totalBytes > 0) {
        fraction += (receivedBytes / totalBytes) * overallFractionWeight
      }
      const prog: DownloadProgress = {
        filename: filenameForUi,
        receivedBytes,
        totalBytes,
        overallFraction: fraction
      }
      broadcast('setup:progress', prog)
    }

    const nodeStream = Readable.fromWeb(response.body as any)

    const onAbort = (): void => {
      attemptController.abort()
      nodeStream.destroy()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const resetStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        nodeStream.destroy(
          retryableError(`下载停滞：连续 ${stallTimeoutMs / 1000} 秒未收到新数据`)
        )
      }, stallTimeoutMs)
    }
    resetStallTimer()

    const fileStream = fs.createWriteStream(tempPath, { flags: writeFlags })

    nodeStream.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length
      resetStallTimer()
      const now = Date.now()
      if (now - lastReportTime > 250 || (totalBytes > 0 && receivedBytes === totalBytes)) {
        lastReportTime = now
        reportProgress()
      }
    })

    try {
      await pipeline(nodeStream, fileStream)
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      signal.removeEventListener('abort', onAbort)
      signal.removeEventListener('abort', forwardAbort)
    }

    if (signal.aborted) throw new Error('aborted')

    // 已知总大小时检查字节数，不足则保留进度并重试
    if (totalBytes > 0) {
      let actual = -1
      try { actual = fs.statSync(tempPath).size } catch { /* ignore */ }
      if (actual !== totalBytes) {
        throw retryableError(`下载不完整：${actual}/${totalBytes} 字节`)
      }
    }
  }

  // ── 同一个源的重试循环 ──
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal.aborted) {
      await cleanupPartialDownload(destPath)
      throw new Error('aborted')
    }

    try {
      await attemptDownload()
      break
    } catch (err) {
      if (isAbort(err)) {
        // 取消就是真正取消：不留临时文件
        await cleanupPartialDownload(destPath)
        throw new Error('aborted')
      }

      if (!isRetryable(err) || attempt >= maxRetries) {
        // 单独调用时自己清理；由镜像函数调用时保留，供下一个源续传
        if (!keepPartialOnFailure) await cleanupPartialDownload(destPath)
        throw err
      }

      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8_000)
      const msg = err instanceof Error ? err.message : String(err)
      broadcast('setup:progress', {
        filename: `${filenameForUi}（${msg}，${backoff / 1000}s 后重试 ${attempt}/${maxRetries - 1}）`,
        receivedBytes: 0,
        totalBytes: 0,
        overallFraction: overallFractionBase
      })

      try {
        await delay(backoff, signal)
      } catch {
        await cleanupPartialDownload(destPath)
        throw new Error('aborted')
      }
    }
  }

  // 下载完整后再重命名
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
  fs.renameSync(tempPath, destPath)
}

/**
 * 调用 PowerShell 原生命令解压 ZIP（不引入第三方库）。
 * 支持取消。
 */
export function extractZip(
  zipPath: string,
  destDir: string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null

    const onAbort = (): void => {
      if (child && child.exitCode === null) child.kill()
      reject(new Error('解压已取消'))
    }

    if (signal?.aborted) {
      reject(new Error('解压已取消'))
      return
    }

    child = execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
      ],
      { windowsHide: true, timeout: 300000 },
      (err) => {
        signal?.removeEventListener('abort', onAbort)
        if (err) reject(new Error(`解压失败: ${err.message}`))
        else resolve()
      }
    )

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}