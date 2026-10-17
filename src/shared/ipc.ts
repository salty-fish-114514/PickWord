/**
 * 主进程 / preload / renderer 三方共用的数据结构与 IPC 契约。
 *
 * 规则：
 *   - 跨进程传输的任何结构只在这里定义一次；renderer 的 lib/types.ts 只做 re-export。
 *   - IpcInvokeMap / IpcSendMap / IpcPushMap 是通道清单：主进程 handle()、preload invoke()
 *     都用它约束通道名与参数类型。新增通道 = 在这里加一行 + 主进程实现 + preload 一行。
 *   - 主进程仍然不信任页面数据：复杂入参在主进程侧另有 parseXxx() 做运行时校验。
 */

import type { Materials } from './materials'
import type { ModelProfile } from './modelProfile'

/* ───────── 候选 ───────── */

export type PromptMode = 'plain' | 'outline' | 'style' | 'full'

export interface CandidateRequest {
  requestId: string
  prompt: string
  bodyPrefix: string
  topK: number
  mode: PromptMode
}

export interface Candidate {
  text: string
  prob: number
  logit?: number
  tokenId?: number
  isEos?: boolean
}

/* ───────── 通用补全（后台任务共用的单一接口） ───────── */

export interface CompletionRequest {
  requestId: string
  /** 已按 ModelProfile.template 拼好的完整提示词。 */
  prompt: string
  /** 槽位：0 = 候选（前台），1 = 纠错等后台任务。超过服务器槽位数会被拒绝。 */
  idSlot: number
  nPredict: number
  temperature?: number
  topP?: number
  stop?: string[]
  /** GBNF 文法：锁定输出格式（纠错 / 校验要可解析的行格式）。 */
  grammar?: string
}

export interface CompletionResult {
  text: string
  /** 'eos' 正常结束 | 'limit' 撞到 nPredict | 'word' 命中停止符 | 'cancelled' */
  stopType: 'eos' | 'limit' | 'word' | 'cancelled'
  stopWord?: string
  timings?: { cacheN?: number; promptN?: number; promptMs?: number; predictedN?: number; predictedMs?: number }
}

/* ───────── 短句展开（流式，槽 0，紧接候选提示词之后解码） ───────── */

export interface ExpandRequest {
  requestId: string
  /** 候选那份提示词 + 选中的候选词：前缀全部命中 KV cache，只解码。 */
  prompt: string
  idSlot: number
  nPredict: number
  temperature?: number
  topP?: number
  repeatPenalty?: number
  stop?: string[]
}

export interface ExpandChunk {
  requestId: string
  text: string
}

export interface ExpandResult {
  requestId: string
  /** 完整文本（所有 chunk 之和）。 */
  text: string
  stopType: 'eos' | 'limit' | 'word' | 'cancelled'
  stopWord?: string
}

/* ───────── 文稿 ───────── */

export interface Anchor {
  offset: number
  fingerprint: string
}

/**
 * 大纲段：一段正文对应一段大纲。起点 = 段首偏移 + 48 字指纹（随编辑平移 / 重找，见 renderer lib/editorText），
 * 终点 = 下一段起点或章末。起点落在章节标记行上（或文首）= 章首段。
 */
export interface OutlineSegment {
  id: string
  anchor: Anchor
  text: string
  /** 单段开关（默认注入）；总开关是 DocumentPayload.outlineEnabled。 */
  inject: boolean
}

export interface DocumentPayload {
  title: string
  content: string
  styleText: string
  outlineText: string
  styleEnabled: boolean
  /** 注入大纲段的总开关（总纲 outlineText 只是备忘，从不注入）。 */
  outlineEnabled: boolean
  /** v5：大纲段。缺省 = 旧旁车，由 renderer 从 anchor / chapterOutlines / outlineText 迁移。 */
  outlineSegments?: OutlineSegment[]
  /** 旧字段（≤ v4 的手动锚点），只读不再写。 */
  anchor: Anchor | null
  /** 旧字段（≤ v4 的分章大纲，键为标记行标题），只读不再写。 */
  chapterOutlines?: Record<string, string>
  /** 角色卡 / 设定。长篇各卷共用（存 book.json），短篇存自己的旁车。缺省 = 空。 */
  materials?: Materials
}

export interface SaveResult {
  path?: string
}

export type LibraryFormat = 'txt' | 'md' | 'docx'

export interface LibraryEntry {
  /** 稳定 ID（旁车里的 UUID），改名 / 移动目录后不变。 */
  id: string
  /** 短篇 = 文稿标题；长篇的一卷 = 卷标题（如「第一卷」）。 */
  title: string
  /** 正文短预览（前 160 字），不传全文。 */
  excerpt: string
  sourceFormat: LibraryFormat
  characterCount: number
  updatedAt: number // Unix 毫秒
  interactedAt: number // 打开 / 保存 / 改名时刷新
  /** 属于某部长篇时存在：文库首页按 book.id 把各卷归成一张卡片。 */
  book?: BookRef
}

/** 一卷所属长篇的摘要（随 LibraryEntry 下发，首页分组用）。 */
export interface BookRef {
  id: string
  title: string
  /** 卷序号，从 0 开始（文件名 `<书名>_<N>卷.txt`）。 */
  volume: number
}

export interface LibraryDirectory {
  path: string
  isDefault: boolean
}

/* ───────── 后端状态 ───────── */

export type BackendState = 'stopped' | 'starting' | 'loading' | 'ready' | 'error'

export interface BackendStatus {
  state: BackendState
  message: string
  baseUrl: string // 例如 http://127.0.0.1:18765
}

/** 前端认识的后端状态（比主进程少一个 starting，preload 负责转换）。 */
export type UiBackendStatus = 'stopped' | 'loading' | 'ready' | 'error'

/**
 * 模型加载进度（主进程推送）。
 * fraction 是「日志阶段标记」和「历史耗时比例」的混合估算，不是精确的字节级进度。
 */
export interface BackendProgress {
  fraction: number // 0~1
  summary: string
  etaSeconds?: number
  prefillTokensPerSecond?: number
}

/* ───────── 后端配置（backend.json） ───────── */

/** backend.json 的结构。exe / model 允许相对路径（相对配置文件所在目录）。 */
export interface BackendConfig {
  exe: string
  model: string
  port: number
  args: string[]
  startupTimeoutSec: number
}

export type SetupProblem = 'missing-config' | 'invalid-config' | 'missing-backend' | 'missing-model'

/**
 * 应用启动时由主进程检查。
 *   configured=true  且 needsDeviceSelection=false：可直接启动后端。
 *   configured=true  且 needsDeviceSelection=true ：配置有效但 args 没有 --device，只需选设备。
 *   configured=false：显示设置向导；existingConfig 存在时用它预填。
 */
export interface SetupState {
  configured: boolean
  configPath: string
  problem?: SetupProblem
  message: string
  /** 文件里能恢复出的配置（不保证文件都存在）。 */
  existingConfig?: BackendConfig
  needsDeviceSelection?: boolean
}

/* ───────── 硬件检测 ───────── */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown'
export type VramSource = 'nvidia-smi' | 'registry' | 'wmi' | 'unknown'

export interface GpuInfo {
  name: string
  vendor: GpuVendor
  /** 显存字节数；null = 没有任何可靠来源，界面显示「未知」。 */
  vramBytes: number | null
  vramSource: VramSource
  isIntegrated?: boolean
}

export interface CpuInfo {
  name: string
  physicalCores: number | null
  logicalCores: number
  isKnownMultiCcd: boolean
}

export type BackendKind = 'cuda' | 'rocm' | 'vulkan' | 'cpu'
export type CudaVersion = '12.4' | '13.x'

export interface BackendRecommendation {
  kind: BackendKind
  cudaVersion?: CudaVersion
  reason: string
  recommendedThreads: number | null
  threadsNote: string
}

export interface HardwareReport {
  cpu: CpuInfo
  ramBytes: number
  gpus: GpuInfo[]
  nvidiaDriverVersion: string | null
  recommendation: BackendRecommendation
  warnings: string[]
}

/* ───────── 部署、下载清单与设备 ───────── */

/** llama-server --list-devices 报告的一个设备；id 就是 --device 要填的值（ROCm0 / CUDA0 / Vulkan0）。 */
export interface BackendDeviceInfo {
  id: string
  name: string
  vramBytes: number | null
  freeVramBytes: number | null
}

export interface DownloadProgress {
  /** 正在处理的阶段或文件名 */
  filename: string
  receivedBytes: number
  totalBytes: number // -1 表示未知
  /** 0~1 的整体部署进度估算 */
  overallFraction?: number
}

export interface ModelPreset {
  id: string
  name: string
  sizeLabel: string
  url: string
}

/**
 * 下载清单：由主进程持有（main/catalog.ts），向导通过 setup:get-catalog 读取。
 * 换 llama.cpp 版本、加模型、改镜像都只动主进程那一处。
 */
export interface SetupCatalog {
  /** llama.cpp release tag，例如 b8868 */
  engineTag: string
  models: ModelPreset[]
  /** 建议的文件存放目录（主进程按当前用户环境给出，renderer 不猜盘符）。 */
  defaultTargetDir: string
  /** 默认上下文长度（写进 -c）。 */
  defaultContextLength: number
}

/** setup:deploy 的入参。 */
export interface DeployConfig {
  targetDir: string
  backendKind: BackendKind
  cudaVersion?: CudaVersion
  /** 预设模型的下载地址；为空表示使用 localModelPath。 */
  modelUrl: string
  localModelPath?: string
  /** 用户自带 llama-server.exe；为空表示下载。 */
  localExePath?: string
  threads: number
  /** 写进 -c；缺省用 catalog.defaultContextLength。 */
  contextLength?: number
}

/** dialog:choose-path 的入参。 */
export interface ChoosePathOptions {
  type: 'file' | 'directory'
  title?: string
  defaultPath?: string
  /** 仅 type='file'：扩展名列表（不含点），如 ['gguf']。 */
  extensions?: string[]
  extensionsLabel?: string
}

/* ───────── IPC 通道清单 ───────── */

/** renderer → main 请求 / 应答（ipcRenderer.invoke / ipcMain.handle）。 */
export interface IpcInvokeMap {
  'setup:get-state': () => SetupState
  'setup:get-catalog': () => SetupCatalog
  'setup:detect-hardware': () => HardwareReport
  'setup:list-devices': () => BackendDeviceInfo[]
  /** 写入 --device 并重启后端。传 null 表示移除 --device（交给 llama.cpp 自己选）。 */
  'setup:update-device': (deviceId: string | null) => void
  /** 整体替换 backend.json 并重启后端（首页「模型与推理」面板用）。 */
  'setup:apply-config': (config: BackendConfig) => void
  'setup:deploy': (config: DeployConfig) => void
  'dialog:choose-path': (options: ChoosePathOptions) => string | null
  'backend:get-status': () => BackendStatus
  'backend:get-progress': () => BackendProgress
  'backend:restart': () => void
  'backend:open-log': () => void
  'model:profile': () => ModelProfile | null
  /**
   * 系统已装字体的显示名清单（主进程读 Windows 注册表；非 Windows 返回空数组）。
   * renderer 拿到后用 canvas 量宽逐个验证，只有真正装了的才会进「字体」下拉。
   */
  'fonts:list': (force?: boolean) => string[]
  'candidates:get': (request: CandidateRequest) => Candidate[]
  /** 通用一次性补全（纠错 / 人设校验等后台任务）：prompt 已按模板拼好，原样转发。 */
  'llm:complete': (request: CompletionRequest) => CompletionResult
  /** 流式展开：中途的文字走 expand:chunk 推送，结束时 resolve 完整结果。 */
  'expand:start': (request: ExpandRequest) => ExpandResult
  'doc:save-as': (doc: DocumentPayload) => SaveResult | null
  'library:list': () => LibraryEntry[]
  'library:read': (id: string) => DocumentPayload
  'library:create': (doc: DocumentPayload, format: LibraryFormat) => LibraryEntry
  'library:save': (id: string, doc: DocumentPayload) => LibraryEntry
  'library:rename': (id: string, title: string) => LibraryEntry
  'library:delete': (ids: string[]) => void
  'library:touch': (id: string) => LibraryEntry
  /** 新建长篇：建子目录 + book.json + 第一卷，返回第一卷。 */
  'library:create-book': (title: string) => LibraryEntry
  /** 给已有长篇追加一卷，返回新卷。 */
  'library:create-volume': (bookId: string) => LibraryEntry
  /** 长篇改名：改目录名 + 各卷文件名。 */
  'library:rename-book': (bookId: string, title: string) => void
  /** 短篇升级为长篇（原稿成为第一卷），返回第一卷。 */
  'library:convert-to-book': (id: string) => LibraryEntry
  /** 只有一卷的长篇降回短篇，返回该短篇。 */
  'library:convert-to-standalone': (bookId: string) => LibraryEntry
  'library:directory': () => LibraryDirectory
  'library:choose-directory': () => LibraryDirectory | null
  'library:reset-directory': () => LibraryDirectory
}

/** renderer → main 单向通知（ipcRenderer.send / ipcMain.on）。 */
export interface IpcSendMap {
  'candidates:cancel': [requestId: string]
  'llm:cancel': [requestId: string]
  'expand:cancel': [requestId: string]
  'setup:cancel-deploy': []
  'app:flush-done': []
}

/** main → renderer 推送（webContents.send / ipcRenderer.on）。 */
export interface IpcPushMap {
  'expand:chunk': ExpandChunk
  'backend:status': BackendStatus
  'backend:progress': BackendProgress
  'setup:progress': DownloadProgress
  'app:flush': undefined
}

export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcInvokeArgs<C extends IpcInvokeChannel> = Parameters<IpcInvokeMap[C]>
export type IpcInvokeResult<C extends IpcInvokeChannel> = ReturnType<IpcInvokeMap[C]>
