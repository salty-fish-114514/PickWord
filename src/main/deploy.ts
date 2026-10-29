/**
 * 一键部署：下载引擎（多镜像）、下载 / 复用模型、写入 backend.json。
 * 下载清单来自 catalog.ts；配置写入走 backendConfig.ts；是否重启后端由调用方（index.ts）决定。
 */
import { net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { BackendConfig, DeployConfig } from '../shared/ipc'
import {
  buildDefaultArgs,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_PORT,
  DEFAULT_STARTUP_TIMEOUT_SEC
} from '../shared/backendArgs'
import { writeBackendConfig } from './backendConfig'
import { engineAssetsFor, isOfficialBase, MIRROR_BASES } from './catalog'
import { broadcast, cleanupPartialDownload, downloadFile, extractZip } from './downloader'
import { isObj } from './ioUtils'

/* ───────── 入参校验（主进程不信任页面数据） ───────── */

const BACKEND_KINDS = ['cuda', 'rocm', 'vulkan', 'cpu'] as const

export function parseDeployConfig(raw: unknown): DeployConfig {
  if (!isObj(raw)) throw new Error('部署参数格式错误')
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

  const backendKind = str(raw.backendKind)
  if (!(BACKEND_KINDS as readonly string[]).includes(backendKind)) throw new Error('未知的后端类型')

  const threads = Math.round(Number(raw.threads))
  if (!Number.isInteger(threads) || threads < 1 || threads > 512) throw new Error('线程数必须是 1～512 的整数')

  const ctxRaw = raw.contextLength === undefined ? DEFAULT_CONTEXT_LENGTH : Math.round(Number(raw.contextLength))
  if (!Number.isInteger(ctxRaw) || ctxRaw < 512) throw new Error('上下文长度无效')

  const modelUrl = str(raw.modelUrl)
  if (modelUrl && !/^https?:\/\//i.test(modelUrl)) throw new Error('模型下载地址必须是 http(s) 链接')

  const localExePath = str(raw.localExePath)
  const localModelPath = str(raw.localModelPath)
  const targetDir = str(raw.targetDir)
  if (!localExePath && !targetDir) throw new Error('请指定文件存放目录')
  if (modelUrl && !targetDir) throw new Error('下载模型需要指定文件存放目录')
  if (!modelUrl && !localModelPath) throw new Error('请选择一个模型')

  return {
    targetDir,
    backendKind: backendKind as DeployConfig['backendKind'],
    cudaVersion: raw.cudaVersion === '13.x' ? '13.x' : raw.cudaVersion === '12.4' ? '12.4' : undefined,
    modelUrl,
    localModelPath: localModelPath || undefined,
    localExePath: localExePath || undefined,
    threads,
    contextLength: ctxRaw
  }
}

/* ───────── 多镜像下载 ───────── */

type SourceState = {
  preferredBase: string | null
  officialProbe: 'unknown' | 'available' | 'unavailable'
}

// 每次部署独立状态：以这次部署的 AbortSignal 为键
const sourceStates = new WeakMap<AbortSignal, SourceState>()
const OFFICIAL_PROBE_TIMEOUT_MS = 5_000

/** 5 秒内能读到第一个字节，才视为 GitHub 官方源可用。 */
async function probeOfficialUrl(url: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new Error('用户取消了部署')
  const probe = new AbortController()
  const forwardAbort = (): void => probe.abort()
  signal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => probe.abort(), OFFICIAL_PROBE_TIMEOUT_MS)
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    response = await net.fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      cache: 'no-store',
      signal: probe.signal
    })
    if (!response.ok || !response.body) return false
    reader = response.body.getReader()
    const { done, value } = await reader.read()
    return !done && (value?.byteLength ?? 0) > 0
  } catch {
    if (signal.aborted) throw new Error('用户取消了部署')
    return false
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forwardAbort)
    try {
      if (reader) void reader.cancel().catch(() => {})
      else if (response?.body) void response.body.cancel().catch(() => {})
    } catch {
      /* ignore */
    }
  }
}

/**
 * 依次尝试多个镜像源下载，全部失败才报错。
 * 先探测官方源，再依次尝试镜像；换源时从已下载的位置续传；全部失败或取消时删除临时文件。
 */
export async function downloadWithMirrors(
  mirrors: readonly string[],
  filename: string,
  destPath: string,
  uiLabel: string,
  signal: AbortSignal,
  fractionBase: number,
  fractionWeight: number
): Promise<void> {
  const errors: string[] = []
  let state = sourceStates.get(signal)
  if (!state) {
    state = { preferredBase: null, officialProbe: 'unknown' }
    sourceStates.set(signal, state)
  }

  // 清理上次程序崩溃可能留下的临时文件，本次从头下载
  await cleanupPartialDownload(destPath)

  try {
    const uniqueBases = [...new Set(mirrors)]
    const officialBase = uniqueBases.find(isOfficialBase)
    const proxyBases = uniqueBases.filter((b) => b !== officialBase)

    if (officialBase && !state.preferredBase && state.officialProbe === 'unknown') {
      broadcast('setup:progress', {
        filename: `正在检测 GitHub 官方源：${filename}`,
        receivedBytes: 0,
        totalBytes: 0,
        overallFraction: fractionBase
      })
      const reachable = await probeOfficialUrl(officialBase + filename, signal)
      if (signal.aborted) throw new Error('用户取消了部署')
      state.officialProbe = reachable ? 'available' : 'unavailable'
      if (!reachable) errors.push(`${officialBase}${filename} → 官方源探测未通过，跳过直连`)
    }

    const sources: Array<{ base: string; label: string; official: boolean }> = []
    const added = new Set<string>()
    const addSource = (base: string, label: string, official: boolean): void => {
      if (added.has(base)) return
      added.add(base)
      sources.push({ base, label, official })
    }
    // 后续文件优先复用上一个文件下载成功的源
    if (state.preferredBase) {
      const official = state.preferredBase === officialBase
      addSource(state.preferredBase, official ? '（GitHub 直连，复用）' : '（上次成功源，复用）', official)
    }
    if (officialBase && state.officialProbe === 'available') addSource(officialBase, '（GitHub 直连）', true)
    proxyBases.forEach((base, i) => addSource(base, `（镜像 ${i + 1}/${proxyBases.length}）`, false))

    for (const source of sources) {
      if (signal.aborted) throw new Error('用户取消了部署')
      const url = source.base + filename
      try {
        await downloadFile(
          url,
          destPath,
          `${uiLabel} ${source.label}`,
          signal,
          fractionBase,
          fractionWeight,
          undefined, // stallTimeoutMs：默认 15 秒
          undefined, // maxRetries：默认 3 次
          undefined, // connectTimeoutMs：默认 10 秒
          true // 失败时保留临时文件，交给下一个源续传
        )
        state.preferredBase = source.base
        return
      } catch (err) {
        if (signal.aborted) throw new Error('用户取消了部署')
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${url} → ${msg}`)
        console.warn(`[下载源失败] ${source.label} ${msg}`)
        if (source.official) state.officialProbe = 'unavailable'
        if (state.preferredBase === source.base) state.preferredBase = null
      }
    }
    throw new Error(`所有下载源均失败：\n${errors.join('\n')}`)
  } catch (err) {
    await cleanupPartialDownload(destPath)
    if (signal.aborted) throw new Error('用户取消了部署')
    throw err
  }
}

/* ───────── 部署主流程 ───────── */

/** 执行部署：下载引擎、模型，写入配置。返回写入的配置。 */
export async function executeDeploy(config: DeployConfig, signal: AbortSignal): Promise<BackendConfig> {
  const { targetDir, backendKind, cudaVersion, modelUrl, localModelPath, localExePath, threads } = config

  if (targetDir) fs.mkdirSync(targetDir, { recursive: true })

  let exePath: string
  if (localExePath) {
    if (!fs.existsSync(localExePath)) throw new Error(`找不到指定的后端程序：${localExePath}`)
    exePath = localExePath
  } else {
    const assets = engineAssetsFor(backendKind, cudaVersion)
    // 每种引擎一个目录：换引擎时两套 DLL 不会混在一起（HIP 的 ggml-hip.dll 解压后 567 MB，
    // 留在同目录里会被 GGML_BACKEND_DL 反复尝试加载）。
    const exeDir = path.join(targetDir, `llama-cpp-${backendKind}`)
    fs.mkdirSync(exeDir, { recursive: true })

    const llamaZip = path.join(targetDir, assets.llama)
    if (!fs.existsSync(llamaZip)) {
      await downloadWithMirrors(MIRROR_BASES, assets.llama, llamaZip, `引擎: ${assets.llama}`, signal, 0.0, 0.12)
    }
    broadcast('setup:progress', { filename: '正在解压引擎…', receivedBytes: 0, totalBytes: 0, overallFraction: 0.13 })
    await extractZip(llamaZip, exeDir, signal)

    if (assets.cudart) {
      const cudartZip = path.join(targetDir, assets.cudart)
      if (!fs.existsSync(cudartZip)) {
        await downloadWithMirrors(MIRROR_BASES, assets.cudart, cudartZip, `CUDA 运行时: ${assets.cudart}`, signal, 0.15, 0.05)
      }
      broadcast('setup:progress', { filename: '正在解压 CUDA 运行时…', receivedBytes: 0, totalBytes: 0, overallFraction: 0.21 })
      await extractZip(cudartZip, exeDir, signal)
    }

    exePath = path.join(exeDir, 'llama-server.exe')
    if (!fs.existsSync(exePath)) throw new Error(`解压后找不到 llama-server.exe，请检查 ${exeDir} 目录结构`)
  }

  let modelPath: string
  if (modelUrl) {
    const filename = decodeURIComponent(new URL(modelUrl).pathname.split('/').pop() || 'model.gguf')
    modelPath = path.join(targetDir, filename)
    if (!fs.existsSync(modelPath)) {
      await downloadFile(modelUrl, modelPath, `模型: ${filename}`, signal, 0.22, 0.73)
    }
  } else if (localModelPath) {
    if (!fs.existsSync(localModelPath)) throw new Error(`找不到指定的模型文件：${localModelPath}`)
    modelPath = localModelPath
    broadcast('setup:progress', { filename: '使用已有本地模型', receivedBytes: 0, totalBytes: 0, overallFraction: 0.95 })
  } else {
    throw new Error('请选择一个模型')
  }

  // 不在此处写 --device：设备名取决于 llama.cpp 编译后端，部署后用 --list-devices 让用户选。
  const written = await writeBackendConfig({
    exe: exePath,
    model: modelPath,
    port: DEFAULT_PORT,
    args: buildDefaultArgs(threads, config.contextLength ?? DEFAULT_CONTEXT_LENGTH),
    startupTimeoutSec: DEFAULT_STARTUP_TIMEOUT_SEC,
    kind: backendKind
  })

  broadcast('setup:progress', { filename: '配置完成！', receivedBytes: 0, totalBytes: 0, overallFraction: 1.0 })
  return written
}
