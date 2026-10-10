import { app, shell, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import { join, dirname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { backend, listBackendDevices, updateDeviceInConfig } from './backend'
import { cancelCandidates, getCandidates, getModelInfo } from './candidates'
import * as docs from './documents'
import * as lib from './library'
import { getSetupState, getBackendConfigPath } from './setup'
import { detectHardware } from './hardware'
import { executeDeploy, type DeployConfig } from './deploy'

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

    // 查询 llama-server 实际识别到的设备列表（用于让用户选择 --device 参数）
    // 自动从 backend.json 读取 exe 路径，前端无需传递
    handle('setup:list-devices', () => {
      return listBackendDevices()
    })

    // 更新 backend.json 中的 --device 参数（用户选择设备后调用）
    handle('setup:update-device', (_win, deviceId: unknown) => {
      if (typeof deviceId !== 'string') throw new Error('缺少设备 ID')
      deployInProgress = false // 设备选择完成，允许文件监控器正常工作
      return updateDeviceInConfig(deviceId)
    })

    // 设备选择被跳过时重置部署标志
    ipcMain.on('setup:deploy-finished', (event) => {
      if (isFromMainWindow(event)) deployInProgress = false
    })

    // —— 部署流程——
    let deployAbort: AbortController | null = null
    let deployInProgress = false // 部署进行中标志，用于禁用文件监控器的自动重启

    handle('setup:deploy', async (_win, rawConfig: unknown) => {
      // 如果上一次部署还在跑，先取消
      if (deployAbort) deployAbort.abort()

      const controller = new AbortController()
      deployAbort = controller
      const signal = controller.signal
      deployInProgress = true

      try {
        const config = rawConfig as DeployConfig
        await executeDeploy(config, signal)
      } finally {
        if (deployAbort === controller) deployAbort = null
        // 延迟重置标志，给前端足够时间完成设备选择
        setTimeout(() => { deployInProgress = false }, 30000)
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

    // ─── 监听 backend.json 变化，自动重启模型 ───
    // 当用户通过"重新配置"功能修改了 backend.json，或手动编辑了配置文件，
    // 必须重新加载模型以确保新配置（如 --device 参数）生效。
    const backendConfigPath = getBackendConfigPath()
    const configDir = dirname(backendConfigPath)
    let configWatchDebounce: NodeJS.Timeout | null = null
    try {
      fs.watch(configDir, { persistent: false }, (_event, filename) => {
        if (filename !== 'backend.json') return
        // 部署进行中不自动重启，因为部署流程会自己管理后端启动
        if (deployInProgress) return
        // 防抖：文件写入可能分多次触发事件，合并为一次重启
        if (configWatchDebounce) clearTimeout(configWatchDebounce)
        configWatchDebounce = setTimeout(() => {
          configWatchDebounce = null
          // 只在后端已启动（或已出错）时才重启，避免与 setup 流程冲突
          const state = backend.getStatus()
          if (state.state === 'ready' || state.state === 'error' || state.state === 'stopped') {
            backend.stop()
            void backend.start()
          }
        }, 500)
      })
    } catch {
      // 监控失败不影响正常使用，只是不会自动响应配置变更
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => backend.stop(true))
  process.on('exit', () => backend.stop(true))
}