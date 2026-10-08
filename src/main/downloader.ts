import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile, type ChildProcess } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { DownloadProgress } from '../shared/ipc'

export function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
}

/**
 * 下载大文件，支持取消。
 *
 * 取消时会清理临时文件，并抛出包含 'aborted' 的错误。
 */
export async function downloadFile(
  url: string,
  destPath: string,
  filenameForUi: string,
  signal: AbortSignal,
  overallFractionBase = 0,
  overallFractionWeight = 0.5
): Promise<void> {
  const tempPath = destPath + '.downloading'

  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('服务器返回了空的响应体')
  }

  const totalBytes = Number(response.headers.get('content-length') ?? -1)
  let receivedBytes = 0
  let lastReportTime = 0

  const nodeStream = Readable.fromWeb(response.body as any)

  // 取消时主动销毁流，避免继续写入磁盘
  const onAbort = (): void => { nodeStream.destroy() }
  signal.addEventListener('abort', onAbort, { once: true })

  const fileStream = fs.createWriteStream(tempPath)

  nodeStream.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
    const now = Date.now()
    if (now - lastReportTime > 250 || receivedBytes === totalBytes) {
      lastReportTime = now
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
  })

  try {
    await pipeline(nodeStream, fileStream)
  } catch (err) {
    // 清理临时文件
    try { fs.unlinkSync(tempPath) } catch { /* 可能还没创建 */ }
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
  }

  // 下载完整，原子重命名
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