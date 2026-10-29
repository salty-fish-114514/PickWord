/** 安装向导、「模型与推理」面板共用的纯函数与常量（不含组件，避免破坏 Fast Refresh）。 */
import type { BackendDeviceInfo, BackendKind } from "../../lib/types";

export const BACKEND_KIND_LABEL: Record<BackendKind, string> = {
  cuda: "NVIDIA CUDA",
  rocm: "AMD HIP/ROCm",
  vulkan: "Vulkan（通用 GPU）",
  cpu: "纯 CPU",
};

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "未知";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} B`;
}

export function errorText(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  // 主进程抛的错到了页面会带一层 "Error invoking remote method 'xxx': Error: " 前缀，剥掉再显示。
  return caught.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "") || fallback;
}

/** 默认选中第一块 GPU；没有 GPU 就不选（= 自动）。 */
export function defaultDeviceId(devices: BackendDeviceInfo[]): string {
  const gpu = devices.find((d) => !d.id.startsWith("CPU"));
  return (gpu ?? devices[0])?.id ?? "";
}
