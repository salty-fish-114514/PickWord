/**
 * 主进程 / preload 与 renderer 之间传输的数据结构。
 *
 * ⚠ 这是 renderer 里 src/renderer/src/lib/types.ts 的「镜像」。
 * 为什么不直接 import 那个文件：它里面有 `declare global { interface Window ... }`，
 * 而主进程的 TypeScript 配置里没有浏览器的 Window 类型，直接引用会报错。
 * TypeScript 按「形状」比较类型（不看名字），所以两边字段一致就能互通。
 * 前端改了 types.ts 里对应的结构，这里要同步改。
 */

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

export interface Anchor {
  offset: number
  fingerprint: string
}

export interface DocumentPayload {
  title: string
  content: string
  styleText: string
  outlineText: string
  styleEnabled: boolean
  outlineEnabled: boolean
  anchor: Anchor | null
}

export interface SaveResult {
  path?: string
}

/** 模型信息。contextLength 为 null 表示主进程也没查到，前端保持手填。 */
export interface ModelInfo {
  contextLength: number | null
  modelName: string
}

/** 前端认识的后端状态（比主进程的少一个 starting，preload 负责转换）。 */
export type UiBackendStatus = 'stopped' | 'loading' | 'ready' | 'error'

// ─── 以下为多篇文稿文库新增类型 ───────────────────────────────────

export type LibraryFormat = 'txt' | 'md' | 'docx'

export interface LibraryEntry {
  /** 稳定 ID = 物理文件名（不含扩展名）。改名后 ID 随文件名更新。 */
  id: string
  title: string
  /** 正文短预览，主进程只传前 160 字，不传全文。 */
  excerpt: string
  sourceFormat: LibraryFormat
  characterCount: number
  updatedAt: number      // Unix 毫秒
  interactedAt: number   // 打开 / 保存 / 改名时刷新
}

export interface LibraryDirectory {
  path: string
  isDefault: boolean
}

// ─── 首次设置 / 后端部署 ─────────────────────────────────────────

export type SetupProblem =
  | 'missing-config'
  | 'invalid-config'
  | 'missing-backend'
  | 'missing-model'

/**
 * 应用启动时由主进程检查。
 *
 * configured=true：
 *   配置可解析，并且 llama-server.exe 和模型文件都存在。
 *
 * configured=false：
 *   renderer 不挂载现有 App，只显示独立的 SetupWizard。
 */
export interface SetupState {
  configured: boolean
  configPath: string
  problem?: SetupProblem
  message: string
}

// ─── 硬件检测(首次设置向导用) ───────────────────────────────────

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown'

/** VRAM 数值的来源。排查"为什么显存显示不对"时直接看这个字段。 */
export type VramSource = 'nvidia-smi' | 'registry' | 'wmi' | 'unknown'

export interface GpuInfo {
  name: string
  vendor: GpuVendor
  /** 显存字节数;null = 没有任何可靠来源,界面显示"未知",不要编造。 */
  vramBytes: number | null
  vramSource: VramSource
  /** 是否为集成显卡(iGPU)。帮助 llama.cpp 选择正确的主 GPU。 */
  isIntegrated?: boolean
}

export interface CpuInfo {
  name: string
  /** 物理核心数;WMI 查询失败时为 null。 */
  physicalCores: number | null
  /** 逻辑处理器数(含超线程),来自 Node os.cpus(),总是有值。 */
  logicalCores: number
  /** 是否命中已知的多 CCD 锐龙型号表(7950X 之类)。 */
  isKnownMultiCcd: boolean
}

/** 推荐的后端类别。这是抽象类别,不是 release 资产文件名;
 *  具体下载哪个 zip 由下一步的下载清单决定。 */
export type BackendKind = 'cuda' | 'rocm' | 'vulkan' | 'cpu'

export interface BackendRecommendation {
  kind: BackendKind
  /** 仅 kind='cuda' 时有意义:'12.4' 或 '13.x'。 */
  cudaVersion?: '12.4' | '13.x'
  /** 给用户看的一句话理由。 */
  reason: string
  /** 建议线程数;null = 检测不到物理核心数,让用户自己填。 */
  recommendedThreads: number | null
  /** 线程数的说明(为什么是这个数、是不是经验值)。 */
  threadsNote: string
}

export interface HardwareReport {
  cpu: CpuInfo
  ramBytes: number
  gpus: GpuInfo[]
  /** NVIDIA 驱动版本(nvidia-smi 查到的);没有 N 卡或查询失败为 null。 */
  nvidiaDriverVersion: string | null
  recommendation: BackendRecommendation
  /** 检测过程中的所有警告,原样展示给用户,不隐藏不确定性。 */
  warnings: string[]
}

// ─── 部署与下载 ───────────────────────────────────────────────

/**
 * llama.cpp 报告的一个可用设备。
 * 通过 llama-server --list-devices 获取，id 就是 --device 参数要填的值。
 * 例如：ROCm0、CUDA0、Vulkan0 等。
 */
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
  /** 0~1 的整体部署进度估算（可选） */
  overallFraction?: number
}

/** 预设的模型清单 */
export interface ModelPreset {
  id: string
  name: string
  sizeLabel: string
  url: string
}