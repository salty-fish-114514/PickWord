import { app, shell, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
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
import { downloadFile, extractZip, broadcast } from './downloader'
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
      for (let i = 0; i < mirrors.length; i++) {
        if (signal.aborted) throw new Error('用户取消了部署')
        const url = mirrors[i] + filename
        const suffix = i === mirrors.length - 1 ? '（直连）' : `（镜像 ${i + 1}/${mirrors.length}）`
        try {
          await downloadFile(url, destPath, `${uiLabel} ${suffix}`, signal, fractionBase, fractionWeight)
          return // 成功就返回
        } catch (err) {
          if (signal.aborted) throw new Error('用户取消了部署')
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${url} → ${msg}`)
          // 继续尝试下一个镜像
        }
      }
      throw new Error(`所有下载源均失败：\n${errors.join('\n')}`)
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

          // 按优先级排列：清华 TUNA > ghproxy.net > gh-proxy.com > GitHub 直连
          // 清华 TUNA 的 github-release 目录格式为 owner/project/tag/filename
          const mirrors = [
            `https://mirrors.tuna.tsinghua.edu.cn/github-release/ggml-org/llama.cpp/${LLAMA_TAG}/`,
            `https://ghproxy.net/https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`,
            `https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`,
            `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`,
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
        // -ngl 99 表示尽量全部卸载到 GPU，装不下的层自动留在 CPU
        const args = ['-ngl', '99', '-c', '16384', '-t', String(threads), '-fa', 'on']

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