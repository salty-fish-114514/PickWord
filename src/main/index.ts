import { app, shell, BrowserWindow, ipcMain, net, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { backend } from './backend'
import { cancelCandidates, getCandidates, getModelInfo } from './candidates'
import * as docs from './documents'
import * as lib from './library'
import { getSetupState } from './setup'
import { detectHardware } from './hardware'
import fs from 'node:fs'
import path from 'node:path'
import { broadcast, downloadFile, extractZip, cleanupPartialDownload } from './downloader'
import { getBackendConfigDir } from './setup'
import type { BackendKind } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null

function isFromMainWindow(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
}

function handle(channel: string, fn: (win: BrowserWindow, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!mainWindow || !isFromMainWindow(event)) throw new Error('拒绝来自未知页面的请求')
    return fn(mainWindow, ...args)
  })
}

/**
 * 关窗前先让前端保存，并等待两套独立的写入队列都清空：
 *   - docs.whenWritesIdle：旧版「导出」功能用的队列（现在用得很少，但保留以防万一）
 *   - lib.whenLibWritesIdle：文库的写入队列（真正重要的那个）
 * 5 秒没等到前端回应（例如页面已崩溃）就直接关，不能让窗口永远关不掉。
 */
function installCloseGuard(win: BrowserWindow): void {
  let allowClose = false
  let waiting = false

  win.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    if (waiting) return
    waiting = true

    let timer: NodeJS.Timeout | undefined
    const onDone = (e: IpcMainEvent): void => {
      if (e.sender === win.webContents) finish()
    }
    const finish = (): void => {
      if (allowClose) return
      allowClose = true
      if (timer) clearTimeout(timer)
      ipcMain.removeListener('app:flush-done', onDone)
      void Promise.all([docs.whenWritesIdle(3000), lib.whenLibWritesIdle(3000)]).finally(() => {
        if (!win.isDestroyed()) win.close()
      })
    }

    ipcMain.on('app:flush-done', onDone)
    timer = setTimeout(finish, 5000)
    win.webContents.send('app:flush')
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    title: 'PickWord',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!is.dev) {
    win.webContents.on('will-navigate', (event) => event.preventDefault())
  }

  installCloseGuard(win)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.pickword.desktop')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    // —— 首次设置状态 ——
    handle('setup:get-state', () => getSetupState())
    handle('setup:detect-hardware', () => detectHardware())

    // —— 部署流程——
    let deployAbort: AbortController | null = null

    /** 依次尝试多个镜像源下载，全部失败才报错。 */
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
     * 先探测 GitHub 官方源，再依次尝试镜像。
     * 每个源内部最多尝试 3 次；换源时从已下载的位置续传。
     * 所有源都失败或用户取消时，删除临时文件。
     */
    async function downloadWithMirrors(
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

    handle('setup:deploy', async (_win, rawConfig: unknown) => {
      // 如果上一次部署还在跑，先取消
      if (deployAbort) deployAbort.abort()

      const controller = new AbortController()
      deployAbort = controller
      const signal = controller.signal

      try {
        const config = rawConfig as {
          targetDir: string
          backendKind: BackendKind
          cudaVersion?: '12.4' | '13.x'
          modelUrl: string
          localModelPath?: string
          localExePath?: string
          threads: number
        }
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
        // 不指定 --device，让 llama.cpp 自动检测 GPU
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
      } finally {
        if (deployAbort === controller) deployAbort = null
      }
    })

    ipcMain.on('setup:cancel-deploy', (event) => {
      if (isFromMainWindow(event) && deployAbort) {
        deployAbort.abort()
        deployAbort = null
      }
    })

    // —— 后端状态与加载进度 ——
    handle('backend:getStatus', () => backend.getStatus())
    handle('backend:getProgress', () => backend.getProgress())
    handle('backend:restart', () => {
      backend.stop()
      void backend.start()
    })
    handle('backend:openLog', () => shell.showItemInFolder(backend.logFile))
    handle('model:info', () => getModelInfo())

    // —— 候选 ——
    handle('candidates:get', (_win, request) => getCandidates(request))
    ipcMain.on('candidates:cancel', (event, requestId: unknown) => {
      if (isFromMainWindow(event)) cancelCandidates(requestId)
    })

    // —— 导出（唯一保留的旧版文档接口）——
    handle('doc:save-as', (win, doc) => docs.saveDocumentAs(win, doc))

    // —— 多篇文稿文库 ——
    handle('library:list', () => lib.listLibrary())
    handle('library:read', (_, id) => lib.readLibrary(id))
    handle('library:create', (_, doc, fmt) => lib.createLibrary(doc, fmt))
    handle('library:save', (_, id, doc) => lib.saveLibrary(id, doc))
    handle('library:rename', (_, id, title) => lib.renameLibrary(id, title))
    handle('library:delete', (_, ids) => lib.deleteLibrary(ids))
    handle('library:touch', (_, id) => lib.touchLibrary(id))
    handle('library:directory', () => lib.getLibraryDirectory())
    handle('library:choose-directory', (win) => lib.chooseLibraryDirectory(win))
    handle('library:reset-directory', () => lib.resetLibraryDirectory())

    const setupState = getSetupState()

    createWindow()

    // 首次安装时没有 backend.json：只显示设置向导，不启动 llama-server。
    if (setupState.configured) {
      void backend.start()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => backend.stop(true))
  process.on('exit', () => backend.stop(true))
}