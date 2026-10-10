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
  | { kind: "setup"; state: SetupState; skipped?: boolean }
  | { kind: "app"; skippedSetup?: boolean }
  | { kind: "error"; message: string };

/**
 * renderer 的真正入口：
 *
 *   未配置 → 只显示 SetupWizard（但用户可跳过直接进入 App）
 *   已配置 → 才动态加载现有 App
 *
 * 「跳过配置」和「重新配置」两种场景都会显示 SetupWizard：
 *   - 跳过：从 app 阶段回退到 setup 阶段，完成后回来
 *   - 初次：从 checking 发现未配置，或用户主动跳过
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
   * 用户选择跳过配置：直接进入 App，但标记 skippedSetup。
   * App 收到这个标记后会在模型不可用时显示警告条，引导用户回到配置页。
   */
  const handleSkip = useCallback(() => {
    setPhase({ kind: "app", skippedSetup: true });
  }, []);

  /**
   * 从 App 内触发「重新配置模型」：回到 SetupWizard。
   * 完成后（部署成功）再回到 App。
   */
  const handleReconfigure = useCallback(() => {
    setPhase({ kind: "setup", state: null as unknown as SetupState, skipped: true });
    // 重新检查实际状态
    void (async () => {
      try {
        const state = await window.api?.getSetupState?.();
        if (state) {
          setPhase({ kind: "setup", state, skipped: true });
        }
      } catch {
        // 保持当前状态
      }
    })();
  }, []);

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
        <App
          skippedSetup={phase.skippedSetup}
          onReconfigure={handleReconfigure}
        />
      </Suspense>
    );
  }

  if (phase.kind === "checking") {
    return (
      <SetupWizard
        state={null}
        checking
        onRefresh={refresh}
        onSkip={handleSkip}
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
        onSkip={handleSkip}
      />
    );
  }

  return (
    <SetupWizard
      state={phase.state}
      checking={false}
      onRefresh={refresh}
      onSkip={handleSkip}
    />
  );
}
