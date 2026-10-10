/**
 * 全局共享的类型定义。
 *
 * 这个文件不含任何运行逻辑，只是「数据形状的契约」。
 * 对 C 背景的你来说，可以把 interface 理解成 struct 的声明，
 * 把 type X = "a" | "b" 理解成枚举（但它只在编译期存在，运行时不占内存）。
 */

import type { PromptMode } from "./promptBuilder";

/** 单个候选词。 */
export interface Candidate {
  /** 直接插入编辑器的文字（Qwen 的分词天然是词级，不需要再合并）。 */
  text: string;
  /**
   * 展示与采样用的「软化」概率，0~1。
   * 由前端 applySoftening() 根据 logit 和设置里的温度算出，不是模型原始 softmax。
   */
  prob: number;
  /**
   * 模型原始 logit 或 logprob（二者只差一个常数，softmax 结果完全一样）。
   * 后端应尽量提供它；缺失时前端用 log(prob) 代替。
   */
  logit?: number;
  /** token id（可选，主进程调试用；前端不依赖它）。 */
  tokenId?: number;
  /** 是否是终止符（<|im_end|> 等）。UI 不展示它，只用来做 EOS 弱提醒计数。 */
  isEos?: boolean;
}

/**
 * 一次候选请求的入参。
 * prompt 已由 PromptBuilder 拼装好（可能带 ChatML 标签，也可能是纯正文）。
 */
export interface CandidateRequest {
  /** 请求唯一 id，主进程据此实现 cancel(requestId)。 */
  requestId: string;
  /** 最终发给 llama.cpp 的完整提示词。 */
  prompt: string;
  /** 光标前的正文片段（mock 用它生成合理假数据，也便于调试日志）。 */
  bodyPrefix: string;
  /** 希望后端返回多少个候选（本产品固定 100，前端自己分页）。 */
  topK: number;
  /** 当前拼接模式，主进程可据此选择 KV slot 或记录日志。 */
  mode: PromptMode;
}

/**
 * 候选数据源的统一签名。
 * 真实实现走 IPC，演示实现走本地假数据，UI 只认这个函数类型。
 */
export type CandidateProvider = (
  request: CandidateRequest,
  signal: AbortSignal,
) => Promise<Candidate[]>;

/** 本地 llama.cpp 服务状态。 */
export type BackendStatus = "stopped" | "loading" | "ready" | "error";

/**
 * 模型加载进度（主进程推送）。
 * 首页与编辑器的顶部都会显示进度条、摘要和预计剩余时间。
 * 主进程可从 llama-server 的日志 / `/health` 响应 / 子进程阶段推算出这些字段；
 * 没有精确数据时 fraction 可以给阶段性的估计值，etaSeconds 可省略。
 */
export interface BackendProgress {
  /** 0~1，加载完成度。 */
  fraction: number;
  /** 当前阶段的简短说明，例如「读取权重 3.2 GB / 4.1 GB」「预热 KV cache」。 */
  summary: string;
  /** 预计剩余秒数；主进程算不出来时省略。 */
  etaSeconds?: number;
  /**
   * 模型的 prefill 速度（token/秒）。前端用它估算「重算上下文要等多久」。
   * 主进程可在就绪后用一次小测试或从最近一次请求的 timings 中得到。
   */
  prefillTokensPerSecond?: number;
}

/** 界面主题。 */
export type Theme = "light" | "dark";

/** 保存状态指示灯。 */
export type SaveStatus = "saved" | "saving" | "dirty" | "error";

/** 光标 / 选区，用字符偏移量表示（和 textarea 的 selectionStart/End 一致）。 */
export interface SelectionRange {
  start: number;
  end: number;
}

/** 撤销栈里的一帧：正文 + 当时的光标。 */
export interface EditorSnapshot extends SelectionRange {
  text: string;
}

/**
 * 大纲锚点。
 *
 * offset 是段首的字符偏移；fingerprint 是该段开头最多 48 个字。
 * 偏移量在编辑前文时会错位，所以每次正文变化都会「先按偏移平移，再用指纹校验」，
 * 指纹对不上就在全文里重新找这一段（详见 editorText.ts 的 mapAnchorThroughEdit）。
 */
export interface Anchor {
  offset: number;
  fingerprint: string;
}

/** 文稿持久化的数据结构（localStorage / 主进程保存都用它）。 */
export interface DocumentPayload {
  title: string;
  content: string;
  styleText: string;
  outlineText: string;
  styleEnabled: boolean;
  outlineEnabled: boolean;
  anchor: Anchor | null;
}

/** 文库在首页展示的轻量索引；正文只在打开单篇时通过 readLibraryDocument 读取。 */
export type LibraryFormat = "txt" | "md" | "docx";

export interface LibraryEntry {
  /** 稳定 ID，不用文件名或绝对路径当 ID；改名/移动目录后仍保持不变。 */
  id: string;
  title: string;
  /** 正文的短预览，主进程只需读取前几个字符，不必把全文传给首页。 */
  excerpt: string;
  /** 原始导入格式；持久化的正文始终是 .txt。 */
  sourceFormat: LibraryFormat;
  characterCount: number;
  updatedAt: number;
  /** 每次打开、写作保存、改名时更新，首页按它降序排列。 */
  interactedAt: number;
}

export interface LibraryDirectory {
  path: string;
  isDefault: boolean;
}

/** 主进程保存后的回执。 */
export interface SaveResult {
  /** 实际写入的文件路径（主进程返回；演示模式没有）。 */
  path?: string;
}

/**
 * 「打开文件」时主进程交给 renderer 的原始数据。
 * 解析（txt 编码识别 / docx 提取文字）统一由 renderer 完成，主进程只负责弹对话框和读字节。
 */
export interface OpenedFile {
  /** 文件名（含扩展名），renderer 据此判断格式并生成标题。 */
  name: string;
  /** 文件原始字节。IPC 传回来可能是 Uint8Array / Buffer / ArrayBuffer，renderer 统一转换。 */
  bytes: Uint8Array | ArrayBuffer;
  /** 完整路径（仅供主进程自己记账，renderer 不使用）。 */
  path?: string;
  /** 打开 .txt 时，主进程若找到了旁车 .writer.json，一并带回来（风格 / 大纲 / 锚点）。 */
  sidecar?: DocumentPayload | null;
}

/**
 * renderer 对 preload 暴露 API 的最小契约。
 * 所有方法都是可选的：真实项目里主进程接口名若不同，只改这里 + candidateProvider.ts。
 * 每个方法的语义与主进程实现建议见 INTEGRATION.md。
 */
export type SetupProblem =
  | "missing-config"
  | "invalid-config"
  | "missing-backend"
  | "missing-model";

export interface SetupState {
  configured: boolean;
  configPath: string;
  problem?: SetupProblem;
  message: string;
}

export type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";
export type VramSource = "nvidia-smi" | "registry" | "wmi" | "unknown";

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  vramBytes: number | null;
  vramSource: VramSource;
  /** 是否为集成显卡(iGPU)。帮助 llama.cpp 选择正确的主 GPU。 */
  isIntegrated?: boolean;
}

export interface CpuInfo {
  name: string;
  physicalCores: number | null;
  logicalCores: number;
  isKnownMultiCcd: boolean;
}

export type BackendKind = "cuda" | "rocm" | "vulkan" | "cpu";

export interface BackendRecommendation {
  kind: BackendKind;
  cudaVersion?: "12.4" | "13.x";
  reason: string;
  recommendedThreads: number | null;
  threadsNote: string;
}

export interface HardwareReport {
  cpu: CpuInfo;
  ramBytes: number;
  gpus: GpuInfo[];
  nvidiaDriverVersion: string | null;
  recommendation: BackendRecommendation;
  warnings: string[];
}

export interface WriterApi {
  /** 检查正式环境的后端配置和相关文件是否完整。 */
  getSetupState?: () => Promise<SetupState>;
  /** 首次设置:检测 CPU / 内存 / 显卡并给出后端推荐。 */
  detectHardware?: () => Promise<HardwareReport>;
  /** 查询已安装的 llama-server 实际识别到的设备列表（用于 --device 选择） */
  listBackendDevices?: () => Promise<BackendDeviceInfo[]>;
  /** 更新 backend.json 中的 --device 参数（用户选择设备后调用） */
  updateBackendDevice?: (deviceId: string) => Promise<void>;
  /** 通知主进程部署流程已完成 */
  deployFinished?: () => void;

  /** 开始部署后端与模型（下载、解压、写配置） */
  deployBackend?: (config: {
    targetDir: string;
    backendKind: string;
    cudaVersion?: string;
    modelUrl: string;
    localModelPath?: string;
    localExePath?: string;
    threads: number;
  }) => Promise<void>;

  cancelDeploy?: () => void;

  /** 监听部署进度 */
  onDeployProgress?: (
    listener: (progress: DownloadProgress) => void,
  ) => (() => void) | void;

  /** 取 top-K 候选。主进程应把 llama-server 的 n_probs 结果映射为 Candidate[]。 */
  getCandidates?: (request: CandidateRequest) => Promise<Candidate[]>;
  /** 取消一次候选请求（主进程中断对 llama-server 的 HTTP 请求，或丢弃排队中的任务）。 */
  cancelCandidates?: (requestId: string) => void | Promise<void>;

  /** 启动时读取上次的文稿（txt + 旁车 json）。返回 null 表示没有。 */
  loadDocument?: () => Promise<DocumentPayload | null>;
  /**
   * 「打开」按钮：主进程弹系统对话框（.txt / .md / .docx），读取字节返回；用户取消返回 null。
   * 主进程还要负责「当前保存目标」的切换：打开 .txt → 之后保存覆盖它；
   * 打开 .docx → 之后保存写到一个新的 .txt，绝不写回 .docx（详见 INTEGRATION.md）。
   */
  openDocument?: () => Promise<OpenedFile | null>;
  /**
   * 两阶段打开的第二步：renderer 已经成功解析了文件，通知主进程「现在才」切换当前保存目标。
   * 为什么要分两步：如果主进程在弹对话框时就切换了保存目标，而 renderer 随后解析失败（文件损坏），
   * 编辑器里仍是旧文稿，下一次自动保存就会把旧文稿写进刚选中的文件，造成覆盖。
   */
  commitOpenedDocument?: (info: { path?: string; format: "txt" | "docx" }) => Promise<void>;
  /** 保存到当前文件（txt 存正文，旁车 json 存风格/大纲/锚点）。 */
  saveDocument?: (document: DocumentPayload) => Promise<SaveResult | void>;
  /** 另存为：弹系统对话框，用户取消时返回 null。 */
  saveDocumentAs?: (document: DocumentPayload) => Promise<SaveResult | null>;

  /** 以下是多篇文稿的新接口。实现时应始终按 id 操作，不能复用旧版全局 currentPath。 */
  listLibraryDocuments?: () => Promise<LibraryEntry[]>;
  readLibraryDocument?: (id: string) => Promise<DocumentPayload>;
  createLibraryDocument?: (document: DocumentPayload, sourceFormat: LibraryFormat) => Promise<LibraryEntry>;
  saveLibraryDocument?: (id: string, document: DocumentPayload) => Promise<LibraryEntry>;
  renameLibraryDocument?: (id: string, title: string) => Promise<LibraryEntry>;
  deleteLibraryDocuments?: (ids: string[]) => Promise<void>;
  touchLibraryDocument?: (id: string) => Promise<LibraryEntry>;
  getLibraryDirectory?: () => Promise<LibraryDirectory>;
  /** 选目录并安全迁移现有文稿；用户取消时返回 null。 */
  chooseLibraryDirectory?: () => Promise<LibraryDirectory | null>;
  /** 将文稿安全迁回默认目录，不能只更改路径配置。 */
  resetLibraryDirectory?: () => Promise<LibraryDirectory>;

  getBackendStatus?: () => Promise<BackendStatus>;
  /** 订阅状态推送；返回取消订阅函数。 */
  onBackendStatus?: (listener: (status: BackendStatus) => void) => (() => void) | void;
  /** 查询当前加载进度（启动中途打开窗口时用得到）。 */
  getBackendProgress?: () => Promise<BackendProgress | null>;
  /** 订阅加载进度推送（建议 200~500ms 一次）；返回取消订阅函数。 */
  onBackendProgress?: (listener: (progress: BackendProgress) => void) => (() => void) | void;
  retryBackend?: () => Promise<void>;
  openBackendLog?: () => Promise<void> | void;
  getBackendLogs?: () => Promise<string>;

  /** 主进程准备关窗时请求 renderer 先落盘；renderer 保存完调用 confirmClose()。 */
  onFlushRequest?: (listener: () => void) => (() => void) | void;
  confirmClose?: () => void;
}

declare global {
  interface Window {
    api?: WriterApi;
  }
}

/**
 * llama.cpp 报告的一个可用设备。
 * 通过 llama-server --list-devices 获取，id 就是 --device 参数要填的值。
 */
export interface BackendDeviceInfo {
  id: string;
  name: string;
  vramBytes: number | null;
  freeVramBytes: number | null;
}

export interface DownloadProgress {
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  overallFraction?: number;
}

export interface ModelPreset {
  id: string;
  name: string;
  sizeLabel: string;
  url: string;
}

/** 写作上下文状态：风格参考、大纲、锚点 */
export interface ContextState {
  styleEnabled: boolean;
  styleText: string;
  outlineEnabled: boolean;
  outlineText: string;
  anchor: Anchor | null;
}