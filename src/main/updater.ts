/**
 * 检查更新与自动覆盖安装（源 = GitHub Release，仓库公开、作者手动发包）。
 *
 * 更新检查/镜像顺序/弹窗策略保持不变。安全边界：下载信息与可安装文件只由主进程保存，
 * renderer 只能请求“下载刚检查到的更新”或“安装刚由主进程下载的更新”，不能提交 URL 或 EXE 路径。
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { app } from 'electron'

import type { UpdateInfo } from '../shared/ipc'
import { withGhMirrors } from './catalog'
import { broadcast } from './downloader'

const OWNER_REPO = 'salty-fish-114514/PickWord'
const RELEASE_API = `https://api.github.com/repos/${OWNER_REPO}/releases/latest`
const FETCH_TIMEOUT_MS = 15_000
const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000

interface VerifiedRelease {
  tag: string
  version: string
  filename: string
  url: string
  size?: number
  sha256?: string
}

let availableRelease: VerifiedRelease | null = null
let readyInstallerPath: string | null = null
let readyInstallerRelease: VerifiedRelease | null = null
let pendingDownload: Promise<string> | null = null

/** v1.2.3 / 1.2.3 → [1,2,3]；比不了的就原样返回 NaN 段。 */
function parseVersion(raw: string): number[] {
  return raw
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
}

/** a > b = 1，a = b = 0，a < b = -1。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

function updateDir(): string {
  return path.join(app.getPath('userData'), 'update')
}

function isSafeVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
}

function parseRelease(raw: unknown): VerifiedRelease | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as {
    tag_name?: unknown
    assets?: unknown
  }
  if (typeof data.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.tag_name)) return null
  const version = data.tag_name.replace(/^v/i, '')
  if (!isSafeVersion(version) || !Array.isArray(data.assets)) return null

  const filename = `PickWord-${version}-win-x64-setup.exe`
  const asset = data.assets.find((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as { name?: unknown }
    return candidate.name === filename
  }) as { name?: unknown; size?: unknown; browser_download_url?: unknown; digest?: unknown } | undefined
  if (!asset || typeof asset.browser_download_url !== 'string') return null

  let assetUrl: URL
  try {
    assetUrl = new URL(asset.browser_download_url)
  } catch {
    return null
  }
  const expectedPath = `/${OWNER_REPO}/releases/download/${data.tag_name}/${filename}`
  if (assetUrl.protocol !== 'https:' || assetUrl.hostname !== 'github.com' || assetUrl.pathname !== expectedPath) return null

  const digest = typeof asset.digest === 'string' ? /^sha256:([a-f\d]{64})$/i.exec(asset.digest)?.[1] : undefined
  return {
    tag: data.tag_name,
    version,
    filename,
    url: assetUrl.toString(),
    ...(typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0 ? { size: asset.size } : {}),
    ...(digest ? { sha256: digest.toLowerCase() } : {})
  }
}

/** 查一次。没有 release / 网络不通 / 未打包都返回 available: false（带 reason），不抛。 */
export async function checkUpdate(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()
  availableRelease = null
  readyInstallerPath = null
  if (!app.isPackaged) {
    return { supported: false, currentVersion, available: false, reason: '开发模式不检查更新' }
  }
  try {
    const response = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PickWord-Updater' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (response.status === 404) return { supported: true, currentVersion, available: false }
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
    const data = (await response.json()) as {
      body?: string
      assets?: Array<{ name?: string; size?: number; browser_download_url?: string; digest?: string }>
    }
    const release = parseRelease(data)
    if (!release) return { supported: true, currentVersion, available: false, reason: 'Release 缺少有效的 Windows x64 安装包' }
    const available = compareVersions(release.version, currentVersion) > 0
    if (available) availableRelease = release
    return {
      supported: true,
      currentVersion,
      available,
      latest: release.version,
      notes: (data.body ?? '').trim().slice(0, 2000),
      assetSize: release.size,
      url: release.url
    }
  } catch (error) {
    return { supported: true, currentVersion, available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function downloadVerifiedRelease(release: VerifiedRelease): Promise<string> {
  await mkdir(updateDir(), { recursive: true })
  const dir = await realpath(updateDir())
  const dest = path.join(dir, release.filename)
  const temp = `${dest}.downloading`
  const relative = path.relative(dir, dest)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('更新包路径无效')
  const sources = withGhMirrors(release.url)

  let lastError: unknown = null
  for (let index = 0; index < sources.length; index += 1) {
    let file: ReturnType<typeof createWriteStream> | null = null
    try {
      const response = await fetch(sources[index], {
        signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
        redirect: 'follow'
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const total = release.size ?? Number(response.headers.get('content-length') ?? 0)
      let received = 0
      const hash = createHash('sha256')
      file = createWriteStream(temp, { flags: 'w' })
      // Always install an error listener; events.once below additionally rejects while awaiting drain/finish.
      file.on('error', () => undefined)
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const chunk = Buffer.from(value)
        received += chunk.length
        hash.update(chunk)
        broadcast('update:progress', { received, total, source: index })
        if (!file.write(chunk)) await once(file, 'drain')
      }
      file.end()
      await once(file, 'finish')
      file = null

      if (received === 0) throw new Error('空文件')
      if (release.size !== undefined && received !== release.size) {
        throw new Error(`更新包大小不符：${received}/${release.size} 字节`)
      }
      const actualHash = hash.digest('hex')
      if (release.sha256 && actualHash !== release.sha256) throw new Error('更新包 SHA-256 校验失败')

      // Windows 上替换已存在目标前先删除旧文件；只有完整性检查通过才进入最终文件名。
      await rm(dest, { force: true })
      await rename(temp, dest)
      const finalPath = await realpath(dest)
      const finalRelative = path.relative(dir, finalPath)
      if (!finalRelative || finalRelative.startsWith('..') || path.isAbsolute(finalRelative)) {
        throw new Error('更新包落盘位置超出更新目录')
      }
      return finalPath
    } catch (error) {
      file?.destroy()
      lastError = error
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有下载源都失败')
}

/** 只下载主进程最近一次检查确认的 GitHub Release；renderer 不能传入 URL / 版本号。 */
export function downloadUpdate(): Promise<string> {
  if (readyInstallerPath) return Promise.resolve(readyInstallerPath)
  if (pendingDownload) return pendingDownload
  const release = availableRelease
  if (!release) return Promise.reject(new Error('没有经主进程确认的可用更新，请重新检查更新'))

  const task = downloadVerifiedRelease(release).then((file) => {
    readyInstallerPath = file
    readyInstallerRelease = release
    return file
  })
  pendingDownload = task
  return task.finally(() => {
    if (pendingDownload === task) pendingDownload = null
  })
}

/** 仅安装主进程刚下载并验证过的文件；不接受 renderer 提交的本地路径。 */
export async function installUpdate(): Promise<void> {
  if (!readyInstallerPath) throw new Error('没有已验证的更新包，请先下载更新')
  const dir = await realpath(updateDir())
  const exePath = await realpath(readyInstallerPath)
  const relative = path.relative(dir, exePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝运行更新目录之外的程序')
  const fileStat = await stat(exePath)
  if (!fileStat.isFile() || path.basename(exePath) !== readyInstallerRelease?.filename) throw new Error('更新安装包无效')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(exePath, ['/S'], { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      // 给 IPC 应答和窗口关闭一点时间；安装器初始化时本进程已经退出，文件不被占用。
      setTimeout(() => app.exit(0), 400)
      resolve()
    })
  })
}
