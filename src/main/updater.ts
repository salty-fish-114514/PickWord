/**
 * 检查更新与自动覆盖安装（源 = GitHub Release，仓库公开、作者手动发包）。
 *
 * 流程：
 *   update:check    → GET api.github.com/repos/<owner>/<repo>/releases/latest，semver 比 tag；
 *   update:download → 安装包资产按「镜像逐个试 → 官方直链兜底」下载（与 llama.cpp 组件同一批镜像），
 *                     进度经 update:progress 推给 renderer；全部失败 = 降级为「只提示有新版本」；
 *   update:install  → 静默跑 NSIS 安装包（/S）并退出自己；按用户安装覆盖userData 之外的一切，
 *                     设置 / 文库 / backend.json / 部署目录都在 userData 或用户自选目录，不受影响。
 *
 * 提示策略在 renderer：每个版本只弹一次，「忽略此版本」记下 tag 后该版本永不再弹；
 * 设置里的「检查更新」是手动入口，任何时候都给明确结果。
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

import type { UpdateInfo } from '../shared/ipc'
import { withGhMirrors } from './catalog'
import { broadcast } from './downloader'

const OWNER_REPO = 'salty-fish-114514/PickWord'
const RELEASE_API = `https://api.github.com/repos/${OWNER_REPO}/releases/latest`
const FETCH_TIMEOUT_MS = 15_000

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

/** 查一次。没有 release / 网络不通 / 未打包都返回 available: false（带 reason），不抛。 */
export async function checkUpdate(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()
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
      tag_name?: string
      body?: string
      assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>
    }
    const tag = (data.tag_name ?? '').replace(/^v/i, '')
    const asset = (data.assets ?? []).find((item) => /\.exe$/i.test(item.name ?? ''))
    if (!tag || !asset?.browser_download_url) return { supported: true, currentVersion, available: false }
    return {
      supported: true,
      currentVersion,
      available: compareVersions(tag, currentVersion) > 0,
      latest: tag,
      notes: (data.body ?? '').trim().slice(0, 2000),
      assetSize: asset.size,
      url: asset.browser_download_url
    }
  } catch (error) {
    return { supported: true, currentVersion, available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 下载安装包到 userData/update/。镜像逐个试（与组件下载同序），成功返回落盘路径。
 * 全部失败才抛——调用方据此降级为「只提示」。
 */
export async function downloadUpdate(info: UpdateInfo): Promise<string> {
  const url = info.url
  if (!info.latest || !url) throw new Error('没有可用的下载链接')
  await mkdir(updateDir(), { recursive: true })
  const dest = path.join(updateDir(), `PickWord-Setup-${info.latest}.exe`)
  const sources = withGhMirrors(url)

  let lastError: unknown = null
  for (let index = 0; index < sources.length; index += 1) {
    try {
      const response = await fetch(sources[index], { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length') ?? 0)
      let received = 0
      const file = createWriteStream(dest)
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          received += value.length
          broadcast('update:progress', { received, total, source: index })
          file.write(Buffer.from(value))
        }
      }
      await new Promise<void>((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())))
      if (received === 0) throw new Error('空文件')
      return dest
    } catch (error) {
      lastError = error
      await rm(dest, { force: true }).catch(() => undefined)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有下载源都失败')
}

/** 静默覆盖安装：拉起 NSIS 安装包（/S）后退出自己；安装器只碰安装目录，userData 不受影响。 */
export function installUpdate(exePath: string): void {
  const child = spawn(exePath, ['/S'], { detached: true, stdio: 'ignore' })
  child.unref()
  // 给 IPC 应答和窗口关闭一点时间；安装器初始化时本进程已经退出，文件不被占用。
  setTimeout(() => app.exit(0), 400)
}
