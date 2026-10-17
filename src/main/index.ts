import { app, dialog, shell, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { ChoosePathOptions, IpcInvokeArgs, IpcInvokeChannel, IpcInvokeResult, IpcSendMap } from '../shared/ipc'
import { removeArg, setArgValue } from '../shared/backendArgs'
import { backend } from './backend'
import { updateBackendConfig, writeBackendConfig } from './backendConfig'
import { cancelCandidates, getCandidates, getModelProfile } from './candidates'
import { cancelCompletion, complete } from './llm'
import { cancelExpand, expand } from './expand'
import { getSetupCatalog } from './catalog'
import { executeDeploy, parseDeployConfig } from './deploy'
import { listBackendDevices } from './devices'
import { listSystemFontNames } from './fonts'
import * as docs from './documents'
import { detectHardware } from './hardware'
import * as lib from './library'
import { getSetupState } from './setup'

let mainWindow: BrowserWindow | null = null

function isFromMainWindow(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
}

/**
 * 注册一个请求 / 应答通道。通道名与参数类型来自 shared/ipc.ts 的 IpcInvokeMap，
 * 名字写错或参数个数不对会在编译期报错。入参仍按 unknown 对待：复杂结构在各模块里做运行时校验。
 */
function handle<C extends IpcInvokeChannel>(
  channel: C,
  fn: (win: BrowserWindow, ...args: IpcInvokeArgs<C>) => IpcInvokeResult<C> | Promise<IpcInvokeResult<C>>
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!mainWindow || !isFromMainWindow(event)) throw new Error('拒绝来自未知页面的请求')
    return fn(mainWindow, ...(args as IpcInvokeArgs<C>))
  })
}

/** 注册一个单向通知通道（renderer → main）。 */
function on<C extends keyof IpcSendMap>(channel: C, fn: (...args: IpcSendMap[C]) => void): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (isFromMainWindow(event)) fn(...(args as IpcSendMap[C]))
  })
}

/**
 * 关窗前先让前端保存，并等待两套独立的写入队列都清空：
 *   - docs.whenWritesIdle：「导出」功能用的队列
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

    const onDone = (e: IpcMainEvent): void => {
      if (e.sender === win.webContents) finish()
    }
    const finish = (): void => {
      if (allowClose) return
      allowClose = true
      clearTimeout(timer)
      ipcMain.removeListener('app:flush-done', onDone)
      void Promise.all([docs.whenWritesIdle(3000), lib.whenLibWritesIdle(3000)]).finally(() => {
        if (!win.isDestroyed()) win.close()
      })
    }

    ipcMain.on('app:flush-done', onDone)
    const timer = setTimeout(finish, 5000)
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

/** 系统文件 / 目录选择框。renderer 没有 Node，所有「选路径」都走这里。 */
async function choosePath(win: BrowserWindow, options: ChoosePathOptions): Promise<string | null> {
  const isDir = options.type === 'directory'
  const result = await dialog.showOpenDialog(win, {
    title: options.title,
    defaultPath: options.defaultPath,
    properties: isDir ? ['openDirectory', 'createDirectory'] : ['openFile'],
    filters:
      !isDir && options.extensions?.length
        ? [
            { name: options.extensionsLabel ?? options.extensions.join(', '), extensions: options.extensions },
            { name: '所有文件', extensions: ['*'] }
          ]
        : undefined
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
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

    // —— 首次设置 / 配置 ——
    // 约定：所有写 backend.json 的入口都在这里显式 restart()，不靠文件监听。
    handle('setup:get-state', () => getSetupState())
    handle('setup:get-catalog', () => getSetupCatalog())
    handle('setup:detect-hardware', () => detectHardware())
    handle('setup:list-devices', () => listBackendDevices())
    handle('setup:update-device', async (_win, deviceId) => {
      if (deviceId !== null && (typeof deviceId !== 'string' || !deviceId.trim())) throw new Error('设备 ID 无效')
      await updateBackendConfig((cfg) => ({
        ...cfg,
        args: deviceId ? setArgValue(cfg.args, '--device', deviceId.trim()) : removeArg(cfg.args, '--device')
      }))
      void backend.restart()
    })
    handle('setup:apply-config', async (_win, config) => {
      await writeBackendConfig(config)
      void backend.restart()
    })
    handle('dialog:choose-path', (win, options) => {
      if (!options || (options.type !== 'file' && options.type !== 'directory')) throw new Error('参数错误')
      return choosePath(win, options)
    })

    // —— 部署流程 ——
    let deployAbort: AbortController | null = null
    handle('setup:deploy', async (_win, rawConfig) => {
      const config = parseDeployConfig(rawConfig)
      if (deployAbort) deployAbort.abort() // 上一次部署还在跑：先取消
      const controller = new AbortController()
      deployAbort = controller
      backend.stop(true) // 下载期间不让旧后端占着显存；部署完成后由设备选择步骤重启
      try {
        await executeDeploy(config, controller.signal)
      } finally {
        if (deployAbort === controller) deployAbort = null
      }
    })
    on('setup:cancel-deploy', () => {
      deployAbort?.abort()
      deployAbort = null
    })

    // —— 后端状态与加载进度 ——
    handle('backend:get-status', () => backend.getStatus())
    handle('backend:get-progress', () => backend.getProgress())
    handle('backend:restart', () => void backend.restart())
    handle('backend:open-log', () => shell.showItemInFolder(backend.logFile))
    handle('model:profile', () => getModelProfile())
    handle('fonts:list', (_win, force) => listSystemFontNames(force === true))

    // —— 候选 ——
    handle('candidates:get', (_win, request) => getCandidates(request))
    on('candidates:cancel', (requestId) => cancelCandidates(requestId))
    handle('llm:complete', (_win, request) => complete(request))
    on('llm:cancel', (requestId) => cancelCompletion(requestId))
    handle('expand:start', (_win, request) => expand(request))
    on('expand:cancel', (requestId) => cancelExpand(requestId))

    // —— 导出 ——
    handle('doc:save-as', (win, doc) => docs.saveDocumentAs(win, doc))

    // —— 多篇文稿文库 ——
    handle('library:list', () => lib.listLibrary())
    handle('library:read', (_, id) => lib.readLibrary(id))
    handle('library:create', (_, doc, fmt) => lib.createLibrary(doc, fmt))
    handle('library:save', (_, id, doc) => lib.saveLibrary(id, doc))
    handle('library:rename', (_, id, title) => lib.renameLibrary(id, title))
    handle('library:delete', (_, ids) => lib.deleteLibrary(ids))
    handle('library:touch', (_, id) => lib.touchLibrary(id))
    handle('library:create-book', (_, title) => lib.createBook(title))
    handle('library:create-volume', (_, bookId) => lib.createVolume(bookId))
    handle('library:rename-book', (_, bookId, title) => lib.renameBook(bookId, title))
    handle('library:convert-to-book', (_, id) => lib.convertToBook(id))
    handle('library:convert-to-standalone', (_, bookId) => lib.convertToStandalone(bookId))
    handle('library:directory', () => lib.getLibraryDirectory())
    handle('library:choose-directory', (win) => lib.chooseLibraryDirectory(win))
    handle('library:reset-directory', () => lib.resetLibraryDirectory())

    createWindow()

    // 首次安装时没有 backend.json：只显示设置向导，不启动 llama-server。
    if (getSetupState().configured) void backend.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => backend.stop(true))
  process.on('exit', () => backend.stop(true))
}
