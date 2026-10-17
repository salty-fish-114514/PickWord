/**
 * 首次安装向导（四步：硬件 → 引擎与模型 → 部署 → 设备）。
 *
 * 职责只剩「编排」：持有步骤与表单状态、调用 preload 接口、把结果交给 steps/ 下的展示组件。
 * 下载清单、默认目录、默认上下文长度全部来自主进程的 setup:get-catalog。
 * 写 backend.json / 启动后端都由主进程完成（setup:deploy、setup:update-device），向导不再手动 retryBackend。
 */
import { useEffect, useRef, useState } from "react";

import { DeviceStep } from "./steps/DeviceStep";
import { DeployStep } from "./steps/DeployStep";
import { EngineModelStep } from "./steps/EngineModelStep";
import { HardwareStep } from "./steps/HardwareStep";
import { validateEngineModelForm, type EngineModelForm } from "./engineModelForm";
import { SetupFrame, StatusNote } from "./setupShared";
import { defaultDeviceId, errorText } from "./setupUtils";
import { requireApi } from "../../lib/platform";
import type { BackendDeviceInfo, DownloadProgress, HardwareReport, SetupCatalog, SetupState } from "../../lib/types";
import { DEFAULT_CONTEXT_LENGTH, getArgNumber } from "../../../../shared/backendArgs";

type WizardStep = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<WizardStep, string> = { 1: "硬件检测", 2: "引擎与模型", 3: "下载与部署", 4: "设备与启动" };

interface SetupWizardProps {
  state: SetupState | null;
  /** Bootstrap 读取 setup 状态时的异常文案。 */
  error?: string | null;
  /** "device"：配置有效但缺 --device（旧版本升级），只显示设备选择整页。 */
  startAt?: "hardware" | "device";
  /** 向导走完（后端已由主进程开始启动）→ Bootstrap 重新读取状态并进入应用。 */
  onFinished: () => Promise<void> | void;
  /** 允许跳过配置直接进入（模型功能不可用）。 */
  onSkip?: () => void;
}

function initialForm(state: SetupState | null, catalog: SetupCatalog | null): EngineModelForm {
  const existing = state?.existingConfig;
  const args = existing?.args ?? [];
  return {
    backendKind: "cpu",
    cudaVersion: "12.4",
    threads: getArgNumber(args, "-t") ?? 8,
    contextLength: getArgNumber(args, "-c") ?? catalog?.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH,
    engineSource: existing?.exe ? "local" : "auto",
    localExePath: existing?.exe ?? "",
    modelSource: existing?.model ? "local" : "preset",
    presetUrl: catalog?.models[0]?.url ?? "",
    localModelPath: existing?.model ?? "",
    targetDir: catalog?.defaultTargetDir ?? "",
  };
}

export default function SetupWizard({ state, error = null, startAt = "hardware", onFinished, onSkip }: SetupWizardProps) {
  const deviceOnly = startAt === "device";
  const [step, setStep] = useState<WizardStep>(deviceOnly ? 4 : 1);

  // 清单（主进程持有）
  const [catalog, setCatalog] = useState<SetupCatalog | null>(null);
  const [form, setForm] = useState<EngineModelForm>(() => initialForm(state, null));
  const catalogApplied = useRef(false);

  // 第 1 步
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  // 第 3 步
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  // 第 4 步
  const [devices, setDevices] = useState<BackendDeviceInfo[]>([]);
  const [deviceQuerying, setDeviceQuerying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [deviceError, setDeviceError] = useState<string | null>(null);

  /* ── 读取清单；只在用户尚未改动对应字段时填默认值 ── */
  useEffect(() => {
    let alive = true;
    requireApi()
      .getSetupCatalog()
      .then((c) => {
        if (!alive) return;
        setCatalog(c);
        if (!catalogApplied.current) {
          catalogApplied.current = true;
          setForm((prev) => ({
            ...prev,
            targetDir: prev.targetDir || c.defaultTargetDir,
            presetUrl: prev.presetUrl || c.models[0]?.url || "",
            contextLength: state?.existingConfig ? prev.contextLength : c.defaultContextLength,
          }));
        }
      })
      .catch((caught) => {
        if (alive) setDeployError(`读取下载清单失败：${errorText(caught, "未知错误")}`);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── 部署进度推送 ── */
  useEffect(() => requireApi().onDeployProgress(setProgress), []);

  /* ── 升级场景：直接查询设备 ── */
  useEffect(() => {
    if (deviceOnly) void queryDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceOnly]);

  function patchForm(patch: Partial<EngineModelForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  async function runDetection() {
    setDetecting(true);
    setDetectError(null);
    try {
      const report = await requireApi().detectHardware();
      setHardware(report);
      const rec = report.recommendation;
      patchForm({
        backendKind: rec.kind,
        ...(rec.cudaVersion ? { cudaVersion: rec.cudaVersion } : {}),
        ...(rec.recommendedThreads !== null ? { threads: rec.recommendedThreads } : {}),
      });
    } catch (caught) {
      setDetectError(errorText(caught, "检测失败"));
    } finally {
      setDetecting(false);
    }
  }

  async function runDeploy() {
    const problem = validateEngineModelForm(form);
    if (problem) {
      setDeployError(problem);
      setStep(2);
      return;
    }
    setDeploying(true);
    setDeployError(null);
    setProgress(null);
    setStep(3);
    try {
      await requireApi().deployBackend({
        targetDir: form.targetDir.trim(),
        backendKind: form.backendKind,
        cudaVersion: form.backendKind === "cuda" ? form.cudaVersion : undefined,
        modelUrl: form.modelSource === "preset" ? form.presetUrl : "",
        localModelPath: form.modelSource === "local" ? form.localModelPath.trim() : undefined,
        localExePath: form.engineSource === "local" ? form.localExePath.trim() : undefined,
        threads: form.threads,
        contextLength: form.contextLength,
      });
      setDeploying(false);
      await queryDevices();
    } catch (caught) {
      setDeployError(errorText(caught, "部署中断"));
      setDeploying(false);
    }
  }

  function cancelDeploy() {
    requireApi().cancelDeploy();
    setDeploying(false);
    setProgress(null);
    setDeployError("已取消部署。");
  }

  async function queryDevices() {
    setStep(4);
    setDeviceQuerying(true);
    setDeviceError(null);
    try {
      const list = await requireApi().listBackendDevices();
      setDevices(list);
      setSelectedDevice(defaultDeviceId(list));
    } catch (caught) {
      setDevices([]);
      setDeviceError(`设备查询失败：${errorText(caught, "未知错误")}。可直接使用默认设备启动。`);
    } finally {
      setDeviceQuerying(false);
    }
  }

  /** 写入 --device（或移除）→ 主进程重启后端 → 交回 Bootstrap。 */
  async function finish(deviceId: string | null) {
    setConfirming(true);
    setDeviceError(null);
    try {
      await requireApi().updateBackendDevice(deviceId);
      await onFinished();
    } catch (caught) {
      setDeviceError(`保存设备配置失败：${errorText(caught, "未知错误")}`);
      setConfirming(false);
    }
  }

  const deviceStep = (
    <DeviceStep
      title={deviceOnly ? "选择推理设备" : undefined}
      devices={devices}
      querying={deviceQuerying}
      confirming={confirming}
      selected={selectedDevice}
      error={deviceError}
      onSelect={setSelectedDevice}
      onConfirm={() => void finish(selectedDevice || null)}
      onUseDefault={() => void finish(null)}
    />
  );

  if (deviceOnly) {
    return (
      <SetupFrame title="选择推理设备" description="检测到您之前已经配置过模型，现在只需要选择推理设备即可。" onSkip={onSkip}>
        {state && !state.configured && <StatusNote title="配置状态">{state.message}</StatusNote>}
        {deviceStep}
        <p className="setup-footnote">配置完成后将自动进入写作界面。</p>
      </SetupFrame>
    );
  }

  const canOpenStep2 = hardware !== null;

  return (
    <SetupFrame
      title="准备本地写作模型"
      description="检测电脑硬件，一键部署推荐的本地大语言模型与 llama.cpp 推理环境。"
      onSkip={onSkip && step < 3 ? onSkip : undefined}
    >
      <div className="setup-step-bar" aria-label="安装向导步骤">
        {([1, 2, 3, 4] as const).map((s) => {
          const isCurrent = step === s;
          const isDone = step > s;
          const clickable = !deploying && !confirming && (s === 1 || (s === 2 && canOpenStep2)) && s <= step;
          return (
            <button
              key={s}
              type="button"
              className={`setup-step-pill ${isCurrent ? "is-active" : ""} ${isDone ? "is-done" : ""}`}
              disabled={!clickable && !isCurrent}
              onClick={() => clickable && setStep(s)}
            >
              <span className="step-num">{isDone ? "✓" : s}</span>
              <span className="step-text">{STEP_LABELS[s]}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <StatusNote kind="error" title="环境异常">
          {error}
        </StatusNote>
      )}
      {state && !state.configured && !error && <StatusNote title="需要配置">{state.message}</StatusNote>}

      {step === 1 && (
        <HardwareStep
          hardware={hardware}
          detecting={detecting}
          error={detectError}
          onDetect={() => void runDetection()}
          onNext={() => setStep(2)}
          onSkip={onSkip}
        />
      )}
      {step === 2 && (
        <>
          {deployError && (
            <div style={{ marginTop: 12 }}>
              <StatusNote kind="error">{deployError}</StatusNote>
            </div>
          )}
          <EngineModelStep
            form={form}
            catalog={catalog}
            recommendation={hardware?.recommendation ?? null}
            busy={deploying}
            onChange={patchForm}
            onBack={() => setStep(1)}
            onDeploy={() => void runDeploy()}
            onSkip={onSkip}
          />
        </>
      )}
      {step === 3 && (
        <DeployStep
          deploying={deploying}
          progress={progress}
          error={deployError}
          onCancel={cancelDeploy}
          onBack={() => setStep(2)}
          onRetry={() => void runDeploy()}
          onSkipToDevices={() => void queryDevices()}
        />
      )}
      {step === 4 && deviceStep}

      <p className="setup-footnote">
        部署完成后将自动进入写作界面。也可以跳过配置直接进入（模型功能暂不可用）。
        配置与模型保存在用户数据目录 / 所选目录，卸载程序不会删除模型文件。
      </p>
    </SetupFrame>
  );
}
