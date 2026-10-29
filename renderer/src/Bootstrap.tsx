import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import SetupWizard from "./components/setup/SetupWizard";
import { installFlushBridge } from "./lib/flushRegistry";
import { platform } from "./lib/platform";
import type { SetupState } from "./lib/types";

/** 动态 import：未配置时连 App.tsx 都不加载。 */
const App = lazy(() => import("./App"));

/** 读一次 setup 状态，决定进哪个阶段。 */
async function checkSetup(): Promise<BootPhase> {
  const api = platform.api;
  if (!api) return { kind: "app" };
  try {
    const state = await api.getSetupState();
    if (state.configured && state.needsDeviceSelection) return { kind: "deviceSetup", state };
    if (state.configured) return { kind: "app" };
    return { kind: "setup", state };
  } catch (error) {
    return { kind: "setup", state: null, error: error instanceof Error ? error.message : "无法检查本地模型配置。" };
  }
}

type BootPhase =
  | { kind: "checking" }
  | { kind: "setup"; state: SetupState | null; error?: string }
  | { kind: "deviceSetup"; state: SetupState }
  | { kind: "app" };

/**
 * renderer 的真正入口：
 *
 *   浏览器演示（无 preload）→ 直接进入 App（演示模式）
 *   未配置 / 配置损坏      → SetupWizard（可跳过直接进入 App）
 *   配置有效但缺 --device   → SetupWizard 的设备选择整页
 *   已配置                 → App
 *
 * App 内「模型与推理」面板里的「重新运行安装向导」会回到 setup 阶段，向导走完再回来。
 * 关闭前的 app:flush 握手只在这里订阅一次（flushRegistry），编辑器只负责注册自己的 flusher。
 */
export default function Bootstrap() {
  // 浏览器演示没有 preload：没有可检查的配置，直接进 App。
  const [phase, setPhase] = useState<BootPhase>(() => (platform.api ? { kind: "checking" } : { kind: "app" }));

  useEffect(() => installFlushBridge(), []);

  useEffect(() => {
    let alive = true;
    void checkSetup().then((next) => alive && setPhase(next));
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setPhase(await checkSetup());
  }, []);

  const enterApp = useCallback(() => setPhase({ kind: "app" }), []);

  /** App 内触发：总是显示完整向导（用现有配置预填）。 */
  const runSetupWizard = useCallback(async () => {
    try {
      const state = await platform.api?.getSetupState();
      setPhase({ kind: "setup", state: state ?? null });
    } catch (error) {
      setPhase({ kind: "setup", state: null, error: error instanceof Error ? error.message : "无法读取配置。" });
    }
  }, []);

  if (phase.kind === "app") {
    return (
      <Suspense
        fallback={
          <main className="setup-root">
            <div className="setup-loading">正在打开 PickWord…</div>
          </main>
        }
      >
        <App onRunSetupWizard={() => void runSetupWizard()} />
      </Suspense>
    );
  }

  if (phase.kind === "checking") {
    return (
      <main className="setup-root">
        <div className="setup-loading">正在检查本地模型配置…</div>
      </main>
    );
  }

  if (phase.kind === "deviceSetup") {
    return <SetupWizard state={phase.state} startAt="device" onFinished={refresh} onSkip={enterApp} />;
  }

  return <SetupWizard state={phase.state} error={phase.error} onFinished={refresh} onSkip={enterApp} />;
}
