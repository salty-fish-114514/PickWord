/**
 * preload：renderer 与主进程之间的「受限桥梁」。
 * 旧版单文档接口（loadDocument / openDocument / commitOpenedDocument / saveDocument）
 * 已随主进程一起移除；前端 WriterApi 里这几个方法本来就是可选的（?:），
 * 缺失不会报错，只是 App.tsx 里 hasLegacyApi 这个判断永远是 false（这正是预期）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BackendProgress, BackendStatus } from '../shared/types'
import type {
  LibraryEntry,
  LibraryFormat,
  LibraryDirectory,
  Candidate,
  CandidateRequest,
  DocumentPayload,
  ModelInfo,
  SaveResult,
  HardwareReport,
  SetupState,
  BackendDeviceInfo,
  UiBackendStatus,
  DownloadProgress 
} from '../shared/ipc'

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

const api = {
  getSetupState: (): Promise<SetupState> => ipcRenderer.invoke('setup:get-state'),
  // 硬件检测(首次设置向导用,可能需要几秒)
  detectHardware: (): Promise<HardwareReport> => ipcRenderer.invoke('setup:detect-hardware'),
  // 查询已安装的 llama-server 实际识别到的设备列表（用于 --device 选择）
  // 自动从 backend.json 读取 exe 路径
  listBackendDevices: (): Promise<BackendDeviceInfo[]> =>
    ipcRenderer.invoke('setup:list-devices'),
  // 更新 backend.json 中的 --device 参数
  updateBackendDevice: (deviceId: string): Promise<void> =>
    ipcRenderer.invoke('setup:update-device', deviceId),
  // 通知主进程部署流程已完成（包括跳过设备选择的情况）
  deployFinished: (): void =>
    ipcRenderer.send('setup:deploy-finished'),

  deployBackend: (config: {
    targetDir: string
    backendKind: string
    cudaVersion?: string
    modelUrl: string
    localModelPath?: string
    localExePath?: string
    threads: number
  }): Promise<void> => ipcRenderer.invoke('setup:deploy', config),

  cancelDeploy: (): void => ipcRenderer.send('setup:cancel-deploy'),

  onDeployProgress: (listener: (p: DownloadProgress) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, p: DownloadProgress): void => listener(p)
    ipcRenderer.on('setup:progress', handler)
    return () => ipcRenderer.removeListener('setup:progress', handler)
  },

  getCandidates: (request: CandidateRequest): Promise<Candidate[]> =>
    ipcRenderer.invoke('candidates:get', request),
  cancelCandidates: (requestId: string): void => ipcRenderer.send('candidates:cancel', requestId),
  getModelInfo: (): Promise<ModelInfo | null> => ipcRenderer.invoke('model:info'),

  saveDocumentAs: (doc: DocumentPayload): Promise<SaveResult | null> =>
    ipcRenderer.invoke('doc:save-as', doc),

  getBackendStatus: async (): Promise<UiBackendStatus> => {
    const status: BackendStatus = await ipcRenderer.invoke('backend:getStatus')
    return toUiStatus(status)
  },
  onBackendStatus: (listener: (status: UiBackendStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: BackendStatus): void => {
      console.info('[backend]', status.state, status.message)
      listener(toUiStatus(status))
    }
    ipcRenderer.on('backend:status', handler)
    return () => ipcRenderer.removeListener('backend:status', handler)
  },

  getBackendProgress: (): Promise<BackendProgress | null> => ipcRenderer.invoke('backend:getProgress'),
  onBackendProgress: (listener: (progress: BackendProgress) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: BackendProgress): void => listener(progress)
    ipcRenderer.on('backend:progress', handler)
    return () => ipcRenderer.removeListener('backend:progress', handler)
  },

  retryBackend: (): Promise<void> => ipcRenderer.invoke('backend:restart'),
  openBackendLog: (): Promise<void> => ipcRenderer.invoke('backend:openLog'),

  onFlushRequest: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('app:flush', handler)
    return () => ipcRenderer.removeListener('app:flush', handler)
  },
  confirmClose: (): void => ipcRenderer.send('app:flush-done'),

  // ─── 多篇文稿文库 ─────────────────────────────────────────────
  listLibraryDocuments: (): Promise<LibraryEntry[]> => ipcRenderer.invoke('library:list'),
  readLibraryDocument: (id: string): Promise<DocumentPayload> => ipcRenderer.invoke('library:read', id),
  createLibraryDocument: (doc: DocumentPayload, format: LibraryFormat): Promise<LibraryEntry> =>
    ipcRenderer.invoke('library:create', doc, format),
  saveLibraryDocument: (id: string, doc: DocumentPayload): Promise<LibraryEntry> =>
    ipcRenderer.invoke('library:save', id, doc),
  renameLibraryDocument: (id: string, title: string): Promise<LibraryEntry> =>
    ipcRenderer.invoke('library:rename', id, title),
  deleteLibraryDocuments: (ids: string[]): Promise<void> => ipcRenderer.invoke('library:delete', ids),
  touchLibraryDocument: (id: string): Promise<LibraryEntry> => ipcRenderer.invoke('library:touch', id),
  getLibraryDirectory: (): Promise<LibraryDirectory> => ipcRenderer.invoke('library:directory'),
  chooseLibraryDirectory: (): Promise<LibraryDirectory | null> =>
    ipcRenderer.invoke('library:choose-directory'),
  resetLibraryDirectory: (): Promise<LibraryDirectory> => ipcRenderer.invoke('library:reset-directory')
}

if (!process.contextIsolated) {
  throw new Error('preload 要求开启 contextIsolation')
}
contextBridge.exposeInMainWorld('api', api)