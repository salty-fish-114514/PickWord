import { DevicePicker } from "../DevicePicker";
import { StatusNote } from "../setupShared";
import type { BackendDeviceInfo, BackendKind } from "../../../lib/types";

interface DeviceStepProps {
  title?: string;
  devices: BackendDeviceInfo[];
  querying: boolean;
  confirming: boolean;
  selected: string;
  error: string | null;
  /** 当前部署的引擎类型；老配置读不到时为 null。 */
  engineKind: BackendKind | null;
  /** 正在换引擎（补下载 + 解压 + 重启）。 */
  switching: boolean;
  /** 换引擎过程中的进度 / 失败说明。 */
  switchNote: string | null;
  onSelect: (id: string) => void;
  onConfirm: () => void;
  onUseDefault: () => void;
  onSwitchEngine: () => void;
  onRetryStart: () => void;
  onOpenLog: () => void;
}

const ENGINE_LABELS: Record<BackendKind, string> = {
  cuda: "NVIDIA CUDA",
  rocm: "AMD HIP/ROCm",
  vulkan: "Vulkan",
  cpu: "纯 CPU",
};

const SWITCH_LABEL = "改用 Vulkan 重新部署（约 32 MB，模型不用重下）";

/** 第 4 步：选择推理设备并启动服务（升级场景单独作为整页使用）。 */
export function DeviceStep({
  title = "第 4 步：选择推理设备",
  devices,
  querying,
  confirming,
  selected,
  error,
  engineKind,
  switching,
  switchNote,
  onSelect,
  onConfirm,
  onUseDefault,
  onSwitchEngine,
  onRetryStart,
  onOpenLog,
}: DeviceStepProps) {
  const busy = querying || confirming || switching;
  const gpuEngine = engineKind === "cuda" || engineKind === "rocm";
  /** Vulkan / 纯 CPU 已经是兜底，没有更低一档可退。 */
  const canSwitch = engineKind !== "vulkan" && engineKind !== "cpu";

  let emptyHint: string | undefined;
  if (gpuEngine) {
    emptyHint =
      `${ENGINE_LABELS[engineKind]} 引擎没有报告任何显卡：llama.cpp 只认引擎里编译进去的后端，` +
      "跟系统认得出几张显卡无关。" +
      (engineKind === "rocm" ? " HIP 只对部分 AMD 型号有效，RX 6600/6700/6750 这类卡需要用 Vulkan。" : "");
  }

  return (
    <div className="setup-section setup-step-pane">
      <div className="setup-section-head">
        <div>
          <h2>{title}</h2>
          <p className="setup-section-subtitle">
            确认用于 llama.cpp 运算的加速显卡并启动本地服务。
            {engineKind ? ` 当前引擎：${ENGINE_LABELS[engineKind]}。` : ""}
          </p>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <StatusNote kind="error">{error}</StatusNote>
          <div className="setup-device-actions">
            <button type="button" className="setup-secondary-button" disabled={busy} onClick={onRetryStart}>
              重试启动
            </button>
            <button type="button" className="setup-secondary-button" onClick={onOpenLog}>
              打开日志
            </button>
            {canSwitch && (
              <button type="button" className="setup-secondary-button" disabled={busy} onClick={onSwitchEngine}>
                {SWITCH_LABEL}
              </button>
            )}
          </div>
        </div>
      )}

      {switchNote && (
        <div style={{ marginTop: 12 }}>
          <StatusNote>{switchNote}</StatusNote>
        </div>
      )}

      <div className="setup-device-picker" style={{ marginTop: 16 }}>
        <DevicePicker
          devices={devices}
          querying={querying}
          selected={selected}
          disabled={busy}
          onSelect={onSelect}
          {...(emptyHint ? { emptyHint } : {})}
          {...(canSwitch && !querying
            ? {
                emptyAction: (
                  <div className="setup-device-actions">
                    <button type="button" className="setup-secondary-button" disabled={busy} onClick={onSwitchEngine}>
                      {switching ? "正在换成 Vulkan…" : SWITCH_LABEL}
                    </button>
                  </div>
                ),
              }
            : {})}
        />
      </div>

      <div className="setup-actions">
        <button type="button" className="setup-primary-button" disabled={busy} onClick={onConfirm}>
          {confirming ? "正在启动…" : switching ? "正在换引擎…" : "确认并启动服务 →"}
        </button>
        {devices.length > 0 && (
          <button type="button" className="setup-secondary-button" disabled={busy} onClick={onUseDefault}>
            使用默认设备
          </button>
        )}
      </div>
    </div>
  );
}
