/**
 * 订阅本地模型的状态、加载进度与模型画像。
 *
 * 首页和编辑器都需要同一份信息，所以抽成一个 hook：
 *   - Electron：订阅 preload 的 onBackendStatus / onBackendProgress，就绪后再取一次 ModelProfile；
 *   - 浏览器演示：跑一段假的加载动画，然后置为就绪。
 *
 * 模块级缓存：首页 → 编辑器 → 首页来回切换时，不要每次都从 0% 重新播放演示进度，
 * 也不要让真实环境的订阅丢掉「已就绪」这个事实。
 */

import { useEffect, useSyncExternalStore } from "react";

import { simulateBackendProgress } from "./candidateProvider";
import { platform } from "./platform";
import type { BackendProgress, BackendStatus, ModelProfile } from "./types";

interface BackendSnapshot {
  status: BackendStatus;
  progress: BackendProgress | null;
  /** 后端就绪后由主进程给出：上下文长度、提示词模板、终止符。未就绪 / 演示模式为 null。 */
  profile: ModelProfile | null;
}

const INITIAL: BackendSnapshot = { status: "loading", progress: null, profile: null };

let cached: BackendSnapshot = INITIAL;
let demoStarted = false;
let subscribers = 0;
let unsubscribeApi: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(patch: Partial<BackendSnapshot>) {
  cached = { ...cached, ...patch };
  listeners.forEach((listener) => listener());
}

function getSnapshot(): BackendSnapshot {
  return cached;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 就绪后拉取模型画像；失败不致命（编辑器会退回默认模板 / 设置里的上下文长度）。 */
function fetchProfile() {
  const api = platform.api;
  if (!api) return;
  void api
    .getModelProfile()
    .then((profile) => {
      if (cached.status === "ready") publish({ profile });
    })
    .catch(() => undefined);
}

/** 进程内只订阅一次 preload 推送；组件各自订阅模块级缓存。 */
function ensureApiSubscription() {
  const api = platform.api;
  if (!api || unsubscribeApi) return;
  const unsubStatus = api.onBackendStatus((status) => {
    publish({ status, ...(status === "ready" ? {} : { profile: null }) });
    if (status === "ready") fetchProfile();
  });
  const unsubProgress = api.onBackendProgress((progress) => publish({ progress }));
  unsubscribeApi = () => {
    unsubStatus();
    unsubProgress();
    unsubscribeApi = null;
  };

  void api
    .getBackendStatus()
    .then((status) => {
      publish({ status });
      if (status === "ready") fetchProfile();
    })
    .catch(() => publish({ status: "error" }));
  void api
    .getBackendProgress()
    .then((progress) => {
      if (progress) publish({ progress });
    })
    .catch(() => undefined);
}

export function useBackendStatus(isDemo: boolean): BackendSnapshot & {
  prefillTokensPerSecond: number | undefined;
  retry: () => void;
  openLog: () => Promise<string | null>;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  // 数据源的生命周期：第一个订阅者启动（演示动画 / preload 订阅），最后一个离开时才退订 preload。
  useEffect(() => {
    subscribers += 1;

    if (isDemo) {
      if (!demoStarted) {
        demoStarted = true;
        // 演示进度不随组件卸载而中断，否则切页会卡在中途。
        simulateBackendProgress(
          (progress) => publish({ status: "loading", progress }),
          () => publish({ status: "ready" }),
        );
      }
    } else {
      ensureApiSubscription();
    }

    return () => {
      subscribers -= 1;
      if (subscribers === 0 && unsubscribeApi) unsubscribeApi();
    };
  }, [isDemo]);

  function retry() {
    const api = platform.api;
    if (!api) {
      publish({ status: "error" });
      return;
    }
    publish({ status: "loading", progress: { fraction: 0, summary: "正在重新启动本地模型…" }, profile: null });
    // 真正的状态由 onBackendStatus 推送；这里只负责触发
    void api.retryBackend().catch(() => publish({ status: "error" }));
  }

  /** 返回日志文本（需要弹窗显示时），或 null（主进程已用系统方式打开）。 */
  async function openLog(): Promise<string | null> {
    const api = platform.api;
    if (!api) return "浏览器演示模式没有后端日志。";
    try {
      await api.openBackendLog();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "读取日志失败。";
    }
  }

  return {
    ...snapshot,
    prefillTokensPerSecond: snapshot.progress?.prefillTokensPerSecond,
    retry,
    openLog,
  };
}
