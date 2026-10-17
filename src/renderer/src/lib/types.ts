/**
 * renderer 的类型入口。
 *
 * 跨进程传输的结构（候选、文稿、文库、后端状态、设置向导……）只在 src/shared/ipc.ts 定义一次，
 * 这里 re-export 以便组件写 `import type { X } from "../lib/types"`。
 * window.api 的类型来自 preload（src/preload/index.d.ts → WriterApi），renderer 不再手写镜像接口。
 * 下面只保留 renderer 自己用的 UI 类型。
 */

export type {
  Anchor,
  BackendConfig,
  BackendDeviceInfo,
  BackendKind,
  BackendProgress,
  BackendRecommendation,
  BookRef,
  Candidate,
  CandidateRequest,
  ChoosePathOptions,
  CompletionRequest,
  CompletionResult,
  ExpandRequest,
  ExpandResult,
  CpuInfo,
  CudaVersion,
  DeployConfig,
  DocumentPayload,
  DownloadProgress,
  GpuInfo,
  GpuVendor,
  HardwareReport,
  LibraryDirectory,
  LibraryEntry,
  LibraryFormat,
  ModelPreset,
  OutlineSegment,
  PromptMode,
  SaveResult,
  SetupCatalog,
  SetupProblem,
  SetupState,
  VramSource,
} from "../../../shared/ipc";
export type { UiBackendStatus as BackendStatus } from "../../../shared/ipc";
export type { ModelProfile, PromptTemplate, PromptTemplateId } from "../../../shared/modelProfile";
export type {
  CharacterCard,
  CharacterGroup,
  CustomField,
  LoreCategory,
  LoreEntry,
  Materials,
} from "../../../shared/materials";

import type { Candidate, CandidateRequest, OutlineSegment } from "../../../shared/ipc";

/** preload 暴露的 window.api（类型由 src/preload/index.d.ts 声明）。 */
export type WriterApi = NonNullable<Window["api"]>;

/**
 * 候选数据源的统一签名。
 * 真实实现走 IPC，演示实现走本地假数据，UI 只认这个函数类型。
 */
export type CandidateProvider = (request: CandidateRequest, signal: AbortSignal) => Promise<Candidate[]>;

/** 界面主题。 */
export type Theme = "light" | "dark";

/** 保存状态指示灯。 */
export type SaveStatus = "saved" | "saving" | "dirty" | "error";

/** 光标 / 选区，用字符偏移量表示（和 textarea 的 selectionStart/End 一致）。 */
export interface SelectionRange {
  start: number;
  end: number;
}

/** 编辑器某一刻的快照：正文 + 当时的光标（撤销 / 重做恢复用）。 */
export interface EditorSnapshot extends SelectionRange {
  text: string;
}

/** 写作上下文状态：风格参考、总纲（备忘）、大纲段 */
export interface ContextState {
  styleEnabled: boolean;
  styleText: string;
  /** 注入大纲段的总开关。 */
  outlineEnabled: boolean;
  /** 总纲：只给作者看，永不注入。 */
  outlineText: string;
  /** 大纲段（lib/outline.ts）。 */
  outlineSegments: OutlineSegment[];
}
