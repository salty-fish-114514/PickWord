/**
 * preload：renderer 与主进程之间的「受限桥梁」。
 *
 * 所有通道都经由 shared/ipc.ts 的 IpcInvokeMap / IpcSendMap / IpcPushMap 约束，
 * 通道名写错、参数或返回类型不符都会在编译期报错。
 * `WriterApi` 直接取自这里的 api 对象（见 index.d.ts），renderer 不再手写一份镜像接口。
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  BackendConfig,
  BackendProgress,
  BackendStatus,
  CandidateRequest,
  ChoosePathOptions,
  CompletionRequest,
  DeployConfig,
  DocumentPayload,
  ExpandChunk,
  ExpandRequest,
  IpcInvokeArgs,
  IpcInvokeChannel,
  IpcInvokeResult,
  IpcPushMap,
  IpcSendMap,
  LibraryFormat,
  UiBackendStatus
} from '../shared/ipc'

/* ───────── 类型化的 ipcRenderer 封装 ───────── */

function invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcInvokeArgs<C>): Promise<IpcInvokeResult<C>> {
  return ipcRenderer.invoke(channel, ...args)
}

function send<C extends keyof IpcSendMap>(channel: C, ...args: IpcSendMap[C]): void {
  ipcRenderer.send(channel, ...args)
}

/** 订阅主进程推送；返回取消订阅函数。 */
function on<C extends keyof IpcPushMap>(channel: C, listener: (payload: IpcPushMap[C]) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: IpcPushMap[C]): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

function toUiStatus(status: BackendStatus): UiBackendStatus {
  switch (status.state) {
    case 'ready':
      return 'ready'
    case 'error':
      return 'error'
    case 'stopped':
      return 'stopped'
    default:
      return 'loading'
  }
}

/* ───────── 暴露给页面的 API ───────── */

const api = {
  platform: process.platform,

  // ─── 首次设置 / 后端配置 ───
  getSetupState: () => invoke('setup:get-state'),
  getSetupCatalog: () => invoke('setup:get-catalog'),
  /** 硬件检测（首次设置向导用，可能需要几秒） */
  detectHardware: () => invoke('setup:detect-hardware'),
  /** 已安装的 llama-server 实际识别到的设备列表（用于 --device 选择） */
  listBackendDevices: () => invoke('setup:list-devices'),
  /** 写入 --device 并重启后端；null = 移除 --device 交给 llama.cpp 自选 */
  updateBackendDevice: (deviceId: string | null) => invoke('setup:update-device', deviceId),
  /** 整体替换 backend.json 并重启后端（首页「模型与推理」面板） */
  applyBackendConfig: (config: BackendConfig) => invoke('setup:apply-config', config),
  deployBackend: (config: DeployConfig) => invoke('setup:deploy', config),
  cancelDeploy: () => send('setup:cancel-deploy'),
  onDeployProgress: (listener: (p: IpcPushMap['setup:progress']) => void) => on('setup:progress', listener),

  // ─── 系统对话框 / 文件路径 ───
  choosePath: (options: ChoosePathOptions) => invoke('dialog:choose-path', options),
  /** 拖拽进来的 File 对象 → 磁盘绝对路径（Electron 32 起 File.path 已移除，只能在 preload 里取） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ─── 候选与模型 ───
  getCandidates: (request: CandidateRequest) => invoke('candidates:get', request),
  cancelCandidates: (requestId: string) => send('candidates:cancel', requestId),
  getModelProfile: () => invoke('model:profile'),
  /** 系统已装字体的显示名清单（主进程侧读注册表，见 main/fonts.ts）。 */
  listSystemFonts: (force?: boolean) => invoke('fonts:list', force),
  complete: (request: CompletionRequest) => invoke('llm:complete', request),
  cancelCompletion: (requestId: string) => send('llm:cancel', requestId),
  expandStart: (request: ExpandRequest) => invoke('expand:start', request),
  expandCancel: (requestId: string) => send('expand:cancel', requestId),
  onExpandChunk: (listener: (chunk: ExpandChunk) => void) => on('expand:chunk', listener),

  // ─── 导出 ───
  saveDocumentAs: (doc: DocumentPayload) => invoke('doc:save-as', doc),

  // ─── 后端状态与加载进度 ───
  getBackendStatus: async (): Promise<UiBackendStatus> => toUiStatus(await invoke('backend:get-status')),
  onBackendStatus: (listener: (status: UiBackendStatus) => void) =>
    on('backend:status', (status) => {
      console.info('[backend]', status.state, status.message)
      listener(toUiStatus(status))
    }),
  getBackendProgress: (): Promise<BackendProgress | null> => invoke('backend:get-progress'),
  onBackendProgress: (listener: (progress: BackendProgress) => void) => on('backend:progress', listener),
  retryBackend: () => invoke('backend:restart'),
  openBackendLog: () => invoke('backend:open-log'),

  // ─── 关窗前保存 ───
  onFlushRequest: (listener: () => void) => on('app:flush', () => listener()),
  confirmClose: () => send('app:flush-done'),

  // ─── 多篇文稿文库 ───
  listLibraryDocuments: () => invoke('library:list'),
  readLibraryDocument: (id: string) => invoke('library:read', id),
  createLibraryDocument: (doc: DocumentPayload, format: LibraryFormat) => invoke('library:create', doc, format),
  saveLibraryDocument: (id: string, doc: DocumentPayload) => invoke('library:save', id, doc),
  renameLibraryDocument: (id: string, title: string) => invoke('library:rename', id, title),
  deleteLibraryDocuments: (ids: string[]) => invoke('library:delete', ids),
  touchLibraryDocument: (id: string) => invoke('library:touch', id),
  createLibraryBook: (title: string) => invoke('library:create-book', title),
  createLibraryVolume: (bookId: string) => invoke('library:create-volume', bookId),
  renameLibraryBook: (bookId: string, title: string) => invoke('library:rename-book', bookId, title),
  convertLibraryToBook: (id: string) => invoke('library:convert-to-book', id),
  convertLibraryToStandalone: (bookId: string) => invoke('library:convert-to-standalone', bookId),
  getLibraryDirectory: () => invoke('library:directory'),
  chooseLibraryDirectory: () => invoke('library:choose-directory'),
  resetLibraryDirectory: () => invoke('library:reset-directory')
}

/** renderer 侧 window.api 的类型（index.d.ts 里引用）。 */
export type WriterApi = typeof api

if (!process.contextIsolated) {
  throw new Error('preload 要求开启 contextIsolation')
}
contextBridge.exposeInMainWorld('api', api)
