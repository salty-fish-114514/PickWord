import type { BackendKind, CudaVersion } from "../../lib/types";

/** 向导第 2 步的表单状态；由 SetupWizard 持有，EngineModelStep 只负责渲染与修改。 */
export interface EngineModelForm {
  backendKind: BackendKind;
  cudaVersion: CudaVersion;
  threads: number;
  contextLength: number;
  engineSource: "auto" | "local";
  localExePath: string;
  modelSource: "preset" | "local";
  presetUrl: string;
  localModelPath: string;
  targetDir: string;
}

/** 校验第 2 步输入；返回错误文案或 null。 */
export function validateEngineModelForm(form: EngineModelForm): string | null {
  if (form.engineSource === "local" && !form.localExePath.trim()) return "请输入或选择 llama-server.exe 的完整路径。";
  if (form.modelSource === "local" && !form.localModelPath.trim()) return "请输入或选择 .gguf 模型文件的完整路径。";
  if (form.modelSource === "preset" && !form.presetUrl) return "请选择一个预设模型。";
  if ((form.engineSource === "auto" || form.modelSource === "preset") && !form.targetDir.trim()) return "请输入或选择文件存放目录。";
  if (!Number.isFinite(form.threads) || form.threads < 1) return "CPU 线程数至少为 1。";
  if (!Number.isFinite(form.contextLength) || form.contextLength < 512) return "上下文长度至少为 512。";
  return null;
}
