/**
 * 选文件 / 选目录：薄薄一层转发到主进程的系统对话框（dialog:choose-path）。
 *
 * 浏览器拿不到绝对路径（Web 标准刻意不暴露；Electron 32 起 File.path 也已移除），
 * 所以这里不再有 input[type=file] 之类的「假回退」——演示模式下返回 null，
 * 由界面提示作者手动粘贴路径。
 */
import { platform } from "./platform";
import type { ChoosePathOptions } from "./types";

export function pickNativeDirectory(options: { title?: string; defaultPath?: string } = {}): Promise<string | null> {
  return choose({ type: "directory", ...options });
}

export function pickNativeFile(
  options: { title?: string; defaultPath?: string; extensions?: string[]; extensionsLabel?: string } = {},
): Promise<string | null> {
  return choose({ type: "file", ...options });
}

/** 拖拽进来的文件 → 绝对路径；浏览器里返回 null。 */
export function pathOfDroppedFile(file: File): string | null {
  return platform.api ? platform.api.getPathForFile(file) || null : null;
}

async function choose(options: ChoosePathOptions): Promise<string | null> {
  const api = platform.api;
  if (!api) return null;
  try {
    return await api.choosePath(options);
  } catch {
    return null;
  }
}
