/**
 * 短句展开的数据源与参数（plan.md §2.5）。
 *   真实：window.api.expandStart（主进程流式转发槽 0），chunk 经 onExpandChunk 推回；
 *   演示：从一小组短语里拼一句，逐字「流」出来，走一样的回调。
 */
import { platform } from "./platform";
import type { ExpandRequest, ExpandResult } from "./types";

/** 停止符：就要短句，逗号也停（已定）。 */
export const EXPAND_STOPS = ["，", "。", "！", "？", "；", "…", "\n"];
export const EXPAND_SAMPLING = { nPredict: 24, temperature: 0.6, topP: 0.9, repeatPenalty: 1.1 } as const;
/** 命中这些停止符时把标点一起补回句尾（换行除外）。 */
const APPEND_STOP = new Set(["，", "。", "！", "？", "；", "…"]);
/** 思考标记：prompt 已经预填空思考块，正常不会再来一个；万一来了就从这里截断，别把它当短句显示。 */
const THINK_MARK = /<\/?think>/;

export type ExpandStream = (request: ExpandRequest, signal: AbortSignal, onChunk: (text: string) => void) => Promise<ExpandResult>;

/** 流结束后的收尾：补回句尾标点；流里混进隐藏标记（`<|…|>` / 思考标记）就从那里截断。 */
export function finalizeExpansion(result: ExpandResult): string {
  let text = result.text;
  const marker = text.indexOf("<|");
  if (marker !== -1) text = text.slice(0, marker);
  const think = THINK_MARK.exec(text);
  if (think) text = text.slice(0, think.index);
  if (result.stopType === "word" && result.stopWord && APPEND_STOP.has(result.stopWord)) text += result.stopWord;
  return text;
}

export const realExpandStream: ExpandStream = async (request, signal, onChunk) => {
  if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
  const api = platform.api;
  if (!api) throw new Error("主进程尚未暴露展开接口。");
  const unsubscribe = api.onExpandChunk((chunk) => {
    if (chunk.requestId === request.requestId && !signal.aborted) onChunk(chunk.text);
  });
  const onAbort = () => api.expandCancel(request.requestId);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await api.expandStart(request);
    if (signal.aborted || result.stopType === "cancelled") throw new DOMException("请求已取消", "AbortError");
    return result;
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", onAbort);
  }
};

const MOCK_TAILS = [
  "慢慢地站起身来",
  "没有再说什么",
  "把手里的东西放下",
  "望向远处的灯火",
  "忽然笑了一下",
  "像是想起了什么",
  "沉默了很久",
  "轻轻叹了口气",
];

export const mockExpandStream: ExpandStream = (request, signal, onChunk) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("请求已取消", "AbortError"));
      return;
    }
    const seed = [...request.prompt.slice(-12)].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const tail = MOCK_TAILS[seed % MOCK_TAILS.length];
    let i = 0;
    let text = "";
    const timer = window.setInterval(() => {
      if (i >= tail.length) {
        finish();
        resolve({ requestId: request.requestId, text, stopType: "word", stopWord: "，" });
        return;
      }
      const piece = tail.slice(i, i + 1);
      i += 1;
      text += piece;
      onChunk(piece);
    }, 70);
    const finish = () => {
      window.clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(new DOMException("请求已取消", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function chooseExpandStream(): { stream: ExpandStream; isDemo: boolean } {
  if (platform.isElectron) return { stream: realExpandStream, isDemo: false };
  return { stream: mockExpandStream, isDemo: true };
}
