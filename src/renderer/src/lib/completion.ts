/**
 * 通用补全数据源：纠错等后台任务共用。
 *   Electron 里走 window.api.complete（主进程转发给 llama-server 的槽 1）；
 *   浏览器演示模式用 mock：返回一条示例结果，让界面流程可以走通。
 */
import type { CompletionRequest, CompletionResult } from "./types";
import { platform } from "./platform";

export type CompletionProvider = (request: CompletionRequest, signal: AbortSignal) => Promise<CompletionResult>;

export const realCompletionProvider: CompletionProvider = async (request, signal) => {
  if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
  const api = platform.api;
  if (!api) throw new Error("主进程尚未暴露补全接口。");
  const onAbort = () => api.cancelCompletion(request.requestId);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await api.complete(request);
    if (signal.aborted || result.stopType === "cancelled") throw new DOMException("请求已取消", "AbortError");
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/** 演示模式：从 prompt 里的正文挑一句当「语病」、再找一处 4 字重复当「单调」，格式与真实输出一致。 */
export const mockCompletionProvider: CompletionProvider = (request, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("请求已取消", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve({ text: fakeFindings(request.prompt), stopType: "eos" });
    }, 900);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

function fakeFindings(prompt: string): string {
  const bodyStart = prompt.lastIndexOf("正文：\n");
  const body = bodyStart === -1 ? prompt : prompt.slice(bodyStart + "正文：\n".length).split("\n\n请按格式输出。")[0];
  const paragraphs = [...body.matchAll(/^\[(\d+)\] (.+)$/gm)].map((match) => ({
    id: Number(match[1]),
    text: match[2],
  }));
  const lines: string[] = [];
  const first = paragraphs.find((paragraph) => paragraph.text.length >= 4);
  if (first) {
    const quote = first.text.slice(0, Math.min(8, first.text.length));
    lines.push(`A|${first.id}|${quote}|演示模式：示例问题|示例改法`);
  }

  // 演示行严格遵循与真实协议相同的段号 + 精确片段结构。
  outer: for (let i = 0; i < paragraphs.length; i += 1) {
    for (let j = i; j < paragraphs.length; j += 1) {
      const a = paragraphs[i];
      const b = paragraphs[j];
      for (let fromA = 0; fromA + 4 <= a.text.length; fromA += 1) {
        const quote = a.text.slice(fromA, fromA + 4);
        if (/[\s，。！？；：、“”「」]/u.test(quote)) continue;
        const fromB = b.text.indexOf(quote, j === i ? fromA + 4 : 0);
        if (fromB >= 0) {
          lines.push(`B|${a.id}|${quote}|${b.id}|${quote}|演示模式：示例重复|`);
          break outer;
        }
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "无";
}

export interface CompletionSource {
  provider: CompletionProvider;
  isDemo: boolean;
}

export function chooseCompletionSource(): CompletionSource {
  if (platform.isElectron) return { provider: realCompletionProvider, isDemo: false };
  return { provider: mockCompletionProvider, isDemo: true };
}
