import { net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { BackendKind } from '../shared/ipc'
import { broadcast, cleanupPartialDownload, downloadFile, extractZip } from './downloader'
import { getBackendConfigDir } from './setup'

/** 部署配置的输入参数 */
export interface DeployConfig {
  targetDir: string
  backendKind: BackendKind
  cudaVersion?: '12.4' | '13.x'
  modelUrl: string
  localModelPath?: string
  localExePath?: string
  threads: number
}

/** 下载源状态管理 */
type SetupDownloadSourceState = {
  preferredBase: string | null
  officialProbe: 'unknown' | 'available' | 'unavailable'
}

// 每次部署都有独立状态：以这次部署的 AbortSignal 为键
const downloadSourceStates = new WeakMap<AbortSignal, SetupDownloadSourceState>()

const OFFICIAL_RELEASE_PREFIX =
  'https://github.com/ggml-org/llama.cpp/releases/download/'
const OFFICIAL_PROBE_TIMEOUT_MS = 5_000

/** 5 秒内能读到第一个字节，才视为 GitHub 官方源可用 */
async function probeOfficialUrl(url: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new Error('用户取消了部署')

  const probeController = new AbortController()
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const forwardAbort = (): void => probeController.abort()
  signal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => probeController.abort(), OFFICIAL_PROBE_TIMEOUT_MS)

  try {
    response = await net.fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      cache: 'no-store',
      signal: probeController.signal
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
    } catch { /* ignore */ }
  }
}

/**
 * 依次尝试多个镜像源下载，全部失败才报错。
 * 先探测 GitHub 官方源，再依次尝试镜像。
 * 每个源内部最多尝试 3 次；换源时从已下载的位置续传。
 * 所有源都失败或用户取消时，删除临时文件。
 */
export async function downloadWithMirrors(
  mirrors: string[],
  filename: string,
  destPath: string,
  uiLabel: string,
  signal: AbortSignal,
  fractionBase: number,
  fractionWeight: number
): Promise<void> {
  const errors: string[] = []

  let state = downloadSourceStates.get(signal)
  if (!state) {
    state = { preferredBase: null, officialProbe: 'unknown' }
    downloadSourceStates.set(signal, state)
  }

  // 清理上次程序崩溃可能留下的临时文件，本次从头下载
  await cleanupPartialDownload(destPath)

  try {
    const uniqueBases = [...new Set(mirrors)]
    const officialBase = uniqueBases.find((b) => b.startsWith(OFFICIAL_RELEASE_PREFIX))
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
      if (!reachable) {
        errors.push(`${officialBase}${filename} → 官方源探测未通过，跳过直连`)
        console.warn('[下载源切换] GitHub 官方源探测未通过，改用镜像')
      }
    }

    const sources: Array<{ base: string; label: string; official: boolean }> = []
    const added = new Set<string>()
    const addSource = (base: string, label: string, official: boolean): void => {
      if (added.has(base)) return
      added.add(base)
      sources.push({ base, label, official })
    }

    // CUDA 运行时优先复用主包下载成功的源
    if (state.preferredBase) {
      const isOfficial = state.preferredBase === officialBase
      addSource(
        state.preferredBase,
        isOfficial ? '（GitHub 直连，复用）' : '（上次成功源，复用）',
        isOfficial
      )
    }
    if (officialBase && state.officialProbe === 'available') {
      addSource(officialBase, '（GitHub 直连）', true)
    }
    for (let i = 0; i < proxyBases.length; i++) {
      addSource(proxyBases[i], `（镜像 ${i + 1}/${proxyBases.length}）`, false)
    }

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
          undefined,  // stallTimeoutMs：默认 15 秒
          undefined,  // maxRetries：默认 3 次
          undefined,  // connectTimeoutMs：默认 10 秒
          true        // 失败时保留临时文件，交给下一个源续传
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
    // 所有源都失败或用户取消：不留临时文件
    await cleanupPartialDownload(destPath)
    if (signal.aborted) throw new Error('用户取消了部署')
    throw err
  }
}

/**
 * 执行部署：下载引擎、模型，写入配置。
 * 返回部署结果信息。
 */
export async function executeDeploy(config: DeployConfig, signal: AbortSignal): Promise<void> {
  const { targetDir, backendKind, cudaVersion, modelUrl, localModelPath, localExePath, threads } = config

  fs.mkdirSync(targetDir, { recursive: true })

  let exePath: string

  if (localExePath) {
    // ── 用户自带 llama-server.exe ──
    if (!fs.existsSync(localExePath)) {
      throw new Error(`找不到指定的后端程序：${localExePath}`)
    }
    exePath = localExePath
  } else {
    // ── 下载官方预编译 ──
    const LLAMA_TAG = 'b8868'
    let llamaAsset = `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`
    let cudartAsset: string | null = null

    if (backendKind === 'rocm') {
      llamaAsset = `llama-${LLAMA_TAG}-bin-win-hip-radeon-x64.zip`
    } else if (backendKind === 'vulkan') {
      llamaAsset = `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`
    } else if (backendKind === 'cuda') {
      const ver = cudaVersion === '13.x' ? '13.1' : '12.4'
      llamaAsset = `llama-${LLAMA_TAG}-bin-win-cuda-${ver}-x64.zip`
      cudartAsset = `cudart-llama-bin-win-cuda-${ver}-x64.zip`
    }

    const officialBase =
      `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`

    // 会先探测 officialBase；不通时再按下面的顺序尝试镜像
    const mirrors = [
      `https://gh.llkk.cc/${officialBase}`,
      `https://gh.idayer.com/${officialBase}`,
      `https://ghfast.top/${officialBase}`,
      `https://ghproxy.homeboyc.cn/${officialBase}`,
      `https://ghproxy.net/${officialBase}`,
      `https://gh-proxy.com/${officialBase}`,
      `https://ghp.ci/${officialBase}`,
      `https://github.akams.cn/${officialBase}`,
      `https://moeyy.cn/gh-proxy/${officialBase}`,
      `https://mirror.ghproxy.com/${officialBase}`,
      `https://ghproxy.cxkpro.top/${officialBase}`,
      officialBase,
    ]

    const exeDir = path.join(targetDir, 'llama-cpp')
    fs.mkdirSync(exeDir, { recursive: true })

    // 下载主包（依次尝试多个镜像源）
    const llamaZipPath = path.join(targetDir, llamaAsset)
    if (!fs.existsSync(llamaZipPath)) {
      await downloadWithMirrors(mirrors, llamaAsset, llamaZipPath, `引擎: ${llamaAsset}`, signal, 0.0, 0.12)
    }

    broadcast('setup:progress', { filename: '正在解压引擎…', receivedBytes: 0, totalBytes: 0, overallFraction: 0.13 })
    await extractZip(llamaZipPath, exeDir, signal)

    // CUDA 运行时 DLL
    if (cudartAsset) {
      const cudartZipPath = path.join(targetDir, cudartAsset)
      if (!fs.existsSync(cudartZipPath)) {
        await downloadWithMirrors(mirrors, cudartAsset, cudartZipPath, `CUDA 运行时: ${cudartAsset}`, signal, 0.15, 0.05)
      }
      broadcast('setup:progress', { filename: '正在解压 CUDA 运行时…', receivedBytes: 0, totalBytes: 0, overallFraction: 0.21 })
      await extractZip(cudartZipPath, exeDir, signal)
    }

    exePath = path.join(exeDir, 'llama-server.exe')
    if (!fs.existsSync(exePath)) {
      throw new Error(`解压后找不到 llama-server.exe，请检查 ${exeDir} 目录结构`)
    }
  }

  // ── 模型 ──
  let finalModelPath = ''
  if (modelUrl) {
    const modelFilename = decodeURIComponent(new URL(modelUrl).pathname.split('/').pop() || 'model.gguf')
    finalModelPath = path.join(targetDir, modelFilename)
    if (!fs.existsSync(finalModelPath)) {
      await downloadFile(modelUrl, finalModelPath, `模型: ${modelFilename}`, signal, 0.22, 0.73)
    }
  } else if (localModelPath) {
    if (!fs.existsSync(localModelPath)) {
      throw new Error(`找不到指定的模型文件：${localModelPath}`)
    }
    finalModelPath = localModelPath
    broadcast('setup:progress', { filename: '使用已有本地模型', receivedBytes: 0, totalBytes: 0, overallFraction: 0.95 })
  } else {
    throw new Error('请选择一个模型')
  }

  // ── 写入配置 ──
  // 注意：不在此处自动添加 --device 参数。
  // llama.cpp 的设备名（ROCm0/CUDA0/Vulkan0）取决于编译时启用的后端，
  // 无法从操作系统信息推断。部署后用 --list-devices 让用户自己选择。
  // 用户通过 UI 选择设备后，由 setup:update-device IPC 单独写入配置。
  const args = ['-c', '16384', '-t', String(threads), '-fa', 'on', '--parallel', '1']

  const configDir = getBackendConfigDir()
  fs.mkdirSync(configDir, { recursive: true })

  const backendJson = {
    exe: exePath,
    model: finalModelPath,
    port: 18765,
    args,
    startupTimeoutSec: 600
  }

  fs.writeFileSync(
    path.join(configDir, 'backend.json'),
    JSON.stringify(backendJson, null, 2),
    'utf8'
  )

  broadcast('setup:progress', { filename: '配置完成！', receivedBytes: 0, totalBytes: 0, overallFraction: 1.0 })
}
