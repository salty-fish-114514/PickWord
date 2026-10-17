/**
 * 通用补全数据源：纠错 / 人设校验等后台任务共用。
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
  const body = bodyStart === -1 ? prompt : prompt.slice(bodyStart + 3);
  const lines: string[] = [];
  if (prompt.includes("设定卡：\n")) {
    // 人设校验：拿第一张卡的名字 + 正文里它附近的一句当「示例矛盾」
    const name = prompt.slice(prompt.indexOf("设定卡：\n") + 4).match(/^[【「]?([^】」：:｜\n|]{1,12})/u)?.[1]?.trim();
    const at = name ? body.indexOf(name) : -1;
    if (name && at !== -1) {
      const sentence = body.slice(at, at + 30).split(/[\n，。！？；…]/u)[0];
      if (sentence.length >= 6) return `${name}|${sentence}|演示模式：示例矛盾（与设定卡不符）\n`;
    }
    return "无";
  }
  const sentence = body.match(/[^\n，。！？；…]{10,30}[，。！？；…]/u);
  if (sentence) lines.push(`A|${sentence[0]}|演示模式：示例语病|${sentence[0].replace(/[，。！？；…]$/u, "。")}`);
  const seen = new Map<string, number>();
  for (let i = 0; i + 4 <= body.length; i += 1) {
    const gram = body.slice(i, i + 4);
    if (/[\n\s，。！？；：、“”「」]/u.test(gram)) continue;
    const prev = seen.get(gram);
    if (prev !== undefined && i - prev < 800) {
      lines.push(`B|${gram}‖${gram}|演示模式：示例重复|`);
      break;
    }
    seen.set(gram, i);
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
