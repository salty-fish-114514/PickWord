/**
 * 订阅本地模型的状态与加载进度。
 *
 * 首页和编辑器都需要同一份信息，所以抽成一个 hook：
 *   - 真实环境：订阅 window.api 的 onBackendStatus / onBackendProgress；
 *   - 浏览器演示：跑一段假的加载动画，然后置为就绪。
 *
 * 模块级缓存：首页 → 编辑器 → 首页来回切换时，不要每次都从 0% 重新播放演示进度，
 * 也不要让真实环境的订阅丢掉「已就绪」这个事实。
 */

import { useEffect, useState } from "react";

import { simulateBackendProgress } from "./candidateProvider";
import type { BackendProgress, BackendStatus } from "./types";

interface BackendSnapshot {
  status: BackendStatus;
  progress: BackendProgress | null;
}

let cached: BackendSnapshot | null = null;
let demoStarted = false;
const listeners = new Set<(snapshot: BackendSnapshot) => void>();

function publish(snapshot: BackendSnapshot) {
  cached = snapshot;
  listeners.forEach((listener) => listener(snapshot));
}

export function useBackendStatus(isDemo: boolean): BackendSnapshot & {
  prefillTokensPerSecond: number | undefined;
  retry: () => void;
  openLog: () => Promise<string | null>;
} {
  const [snapshot, setSnapshot] = useState<BackendSnapshot>(
    () => cached ?? { status: isDemo ? "loading" : "loading", progress: null },
  );

  useEffect(() => {
    listeners.add(setSnapshot);
    if (cached) setSnapshot(cached);

    let cleanup: (() => void) | undefined;

    if (isDemo) {
      if (!demoStarted) {
        demoStarted = true;
        cleanup = simulateBackendProgress(
          (progress) => publish({ status: "loading", progress }),
          () => publish({ status: "ready", progress: cached?.progress ?? null }),
        );
        // 演示进度不随组件卸载而中断，否则切页会卡在中途。
        cleanup = undefined;
      }
    } else {
      const api = window.api;
      const unsubStatus = api?.onBackendStatus?.((status) => {
        publish({ status, progress: cached?.progress ?? null });
      });
      const unsubProgress = api?.onBackendProgress?.((progress) => {
        publish({ status: cached?.status ?? "loading", progress });
      });
      if (api?.getBackendStatus) {
        void api.getBackendStatus()
          .then((status) => publish({ status, progress: cached?.progress ?? null }))
          .catch(() => publish({ status: "error", progress: cached?.progress ?? null }));
      } else if (!cached) {
        // 既没有候选接口也没有状态接口的情况下走不到这里；保险起见标为未启动。
        publish({ status: "stopped", progress: null });
      }
      if (api?.getBackendProgress) {
        void api.getBackendProgress()
          .then((progress) => {
            if (progress) publish({ status: cached?.status ?? "loading", progress });
          })
          .catch(() => undefined);
      }
      cleanup = () => {
        if (typeof unsubStatus === "function") unsubStatus();
        if (typeof unsubProgress === "function") unsubProgress();
      };
    }

    return () => {
      listeners.delete(setSnapshot);
      cleanup?.();
    };
  }, [isDemo]);

  function retry() {
    const api = window.api;
    if (!api?.retryBackend) {
      publish({ status: "error", progress: cached?.progress ?? null });
      return;
    }
    publish({ status: "loading", progress: { fraction: 0, summary: "正在重新启动本地模型…" } });
    void api.retryBackend()
      .then(async () => {
        const status = api.getBackendStatus ? await api.getBackendStatus() : "ready";
        publish({ status, progress: cached?.progress ?? null });
      })
      .catch(() => publish({ status: "error", progress: cached?.progress ?? null }));
  }

  /** 返回日志文本（需要弹窗显示时），或 null（主进程已用系统方式打开 / 没有接口）。 */
  async function openLog(): Promise<string | null> {
    const api = window.api;
    try {
      if (api?.openBackendLog) {
        await api.openBackendLog();
        return null;
      }
      if (api?.getBackendLogs) return await api.getBackendLogs();
      return "主进程尚未暴露 openBackendLog 或 getBackendLogs 接口。\n\n请在 preload 中加入受控的日志读取方法，再由 renderer 调用。";
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
