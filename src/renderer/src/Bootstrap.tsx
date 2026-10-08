import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";

import { SetupWizard } from "./components/SetupWizard";
import type { SetupState } from "./lib/types";

/**
 * 使用动态 import：
 * 未配置时连 App.tsx 模块都不加载，避免执行其中的模块级初始化。
 */
const App = lazy(() => import("./App"));

type BootPhase =
  | { kind: "checking" }
  | { kind: "setup"; state: SetupState }
  | { kind: "app" }
  | { kind: "error"; message: string };

/**
 * renderer 的真正入口：
 *
 *   未配置 → 只挂载 SetupWizard
 *   已配置 → 才动态加载现有 App
 */
export default function Bootstrap() {
  const [phase, setPhase] = useState<BootPhase>({ kind: "checking" });

  const refresh = useCallback(async () => {
    const getSetupState = window.api?.getSetupState;

    // 浏览器演示环境没有 preload，继续进入原有 App。
    if (!getSetupState) {
      setPhase({ kind: "app" });
      return;
    }

    setPhase({ kind: "checking" });

    try {
      const state = await getSetupState();
      setPhase(
        state.configured
          ? { kind: "app" }
          : { kind: "setup", state },
      );
    } catch (error) {
      setPhase({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "无法检查本地模型配置。",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 设置页面没有文稿需要保存。
   *
   * 现有主进程关闭保护会发送 app:flush；如果不回应，
   * 设置页面关闭时会无故等待 5 秒。这里直接确认即可。
   *
   * 进入 App 后取消这个监听，由 WritingEditor 使用现有保存逻辑接管。
   */
  useEffect(() => {
    if (phase.kind === "app") return;

    const unsubscribe = window.api?.onFlushRequest?.(() => {
      window.api?.confirmClose?.();
    });

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [phase.kind]);

  if (phase.kind === "app") {
    return (
      <Suspense
        fallback={
          <main className="setup-root">
            <div className="setup-loading">正在打开 PickWord…</div>
          </main>
        }
      >
        <App />
      </Suspense>
    );
  }

  if (phase.kind === "checking") {
    return (
      <SetupWizard
        state={null}
        checking
        onRefresh={refresh}
      />
    );
  }

  if (phase.kind === "error") {
    return (
      <SetupWizard
        state={null}
        error={phase.message}
        checking={false}
        onRefresh={refresh}
      />
    );
  }

  return (
    <SetupWizard
      state={phase.state}
      checking={false}
      onRefresh={refresh}
    />
  );
}