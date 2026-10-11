/**
 * 原生文件/目录选择器辅助工具。
 *
 * 优先调用 Electron 暴露的 window.api 接口；
 * 在现代浏览器中，使用标准 File System Access API (showDirectoryPicker / showOpenFilePicker)；
 * 不支持时回退到原生 input[type=file] / webkitdirectory 对话框。
 *
 * Web 标准刻意不暴露完整绝对路径，因此只在 Electron File.path 可用时回填路径；
 * 否则选择操作只用于确认，作者仍可手动粘贴路径。绝不伪造 D:\ 路径给后端。
 * 文本框始终允许手动输入和粘贴完整路径。
 */

export async function pickNativeDirectory(_currentPath?: string): Promise<string | null> {
  const api = window.api as (typeof window.api & {
    choosePath?: (options?: { type?: "file" | "directory"; filter?: string }) => Promise<string | null>;
  }) | undefined;
  if (api?.choosePath) {
    try {
      const chosen = await api.choosePath({ type: "directory" });
      if (chosen) return chosen;
    } catch {
      // 回退到浏览器原生
    }
  }

  // 浏览器原生 File System Access API
  if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
    try {
      const handle = await (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> }).showDirectoryPicker();
      if (handle?.name) return null;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
    }
  }

  // 回退：隐藏的 input 触发系统原生目录选择
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "true");
    input.setAttribute("directory", "true");
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0];
      const path = file && (file as unknown as { path?: string }).path;
      resolve(path || null);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

export async function pickNativeFile(options: {
  accept?: string;
  description?: string;
  defaultPath?: string;
}): Promise<string | null> {
  const api = window.api as (typeof window.api & {
    choosePath?: (options?: { type?: "file" | "directory"; filter?: string }) => Promise<string | null>;
  }) | undefined;
  if (api?.choosePath) {
    try {
      const chosen = await api.choosePath({ type: "file", filter: options.accept });
      if (chosen) return chosen;
    } catch {
      // 回退到浏览器原生
    }
  }

  if (typeof window !== "undefined" && "showOpenFilePicker" in window) {
    try {
      const handles = await (window as unknown as {
        showOpenFilePicker: (opts: unknown) => Promise<Array<{ name: string }>>;
      }).showOpenFilePicker({
        multiple: false,
        types: options.accept
          ? [{
              description: options.description || "指定文件",
              accept: { "*/*": options.accept.split(",").map((s) => s.trim()) },
            }]
          : undefined,
      });
      if (handles?.[0]?.name) return null;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options.accept) input.accept = options.accept;
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0];
      const path = file && (file as unknown as { path?: string }).path;
      resolve(path || null);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}
