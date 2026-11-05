/**
 * 关窗前落盘的「单点注册」。
 *
 * 主进程关窗时只发一次 app:flush，谁来回应必须唯一：
 *   - 根组件（Bootstrap）调用 installFlushBridge() 订阅一次 onFlushRequest + beforeunload；
 *   - 当前需要落盘的页面（编辑器）用 registerFlusher() 登记自己的保存函数，卸载时注销。
 * 同一时刻最多一个 flusher；没有 flusher（在首页）时直接放行关窗。
 */
import { platform } from "./platform";

type Flusher = () => Promise<boolean>;

let current: Flusher | null = null;

/** 登记落盘函数；返回注销函数（只有仍是当前登记者时才会注销，避免新旧页面交替时误删）。 */
export function registerFlusher(flusher: Flusher): () => void {
  current = flusher;
  return () => {
    if (current === flusher) current = null;
  };
}

/** 执行落盘；没有登记者时视为成功。 */
export function runFlush(): Promise<boolean> {
  return current ? current() : Promise.resolve(true);
}

/**
 * 根组件挂载时调用一次。
 *   浏览器：beforeunload 里尽力保存（localStorage 是同步的，来得及）；
 *   Electron：主进程发 flush 请求 → 保存完回 confirmClose，主进程才真正关窗。
 */
export function installFlushBridge(): () => void {
  const onBeforeUnload = () => void runFlush();
  window.addEventListener("beforeunload", onBeforeUnload);
  const unsubscribe = platform.api?.onFlushRequest(() => {
    void runFlush().then((saved) => {
      if (saved) platform.api?.confirmClose();
    });
  });
  return () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
    unsubscribe?.();
  };
}
