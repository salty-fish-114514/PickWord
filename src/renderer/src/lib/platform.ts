/**
 * renderer 唯一允许碰 window.api 的地方。
 *
 * 两种运行环境：
 *   - Electron：preload 注入了完整的 window.api；
 *   - 浏览器演示（vite dev 直接开网页）：没有 api，候选用 mock、文库用 localStorage。
 * 其余模块一律通过 platform.api / requireApi() 取接口，不再各自写 `window.api?.xxx` 兜底。
 */
import type { WriterApi } from "./types";

const api: WriterApi | null = typeof window !== "undefined" && window.api ? window.api : null;

export const platform = {
  /** 是否运行在 Electron 里（有 preload 桥） */
  isElectron: api !== null,
  /** 完整的 preload API；浏览器演示模式下为 null */
  api
} as const;

/** 只能在 Electron 环境里走到的路径用它；浏览器里调用会抛明确的错误而不是 undefined 调用。 */
export function requireApi(): WriterApi {
  if (!api) throw new Error("此功能仅在桌面应用中可用");
  return api;
}
