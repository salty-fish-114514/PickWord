import { DevicePicker } from "../DevicePicker";
import { StatusNote } from "../setupShared";
import type { BackendDeviceInfo } from "../../../lib/types";

interface DeviceStepProps {
  title?: string;
  devices: BackendDeviceInfo[];
  querying: boolean;
  confirming: boolean;
  selected: string;
  error: string | null;
  onSelect: (id: string) => void;
  onConfirm: () => void;
  onUseDefault: () => void;
}

/** 第 4 步：选择推理设备并启动服务（升级场景单独作为整页使用）。 */
export function DeviceStep({ title = "第 4 步：选择推理设备", devices, querying, confirming, selected, error, onSelect, onConfirm, onUseDefault }: DeviceStepProps) {
  const busy = querying || confirming;
  return (
    <div className="setup-section setup-step-pane">
      <div className="setup-section-head">
        <div>
          <h2>{title}</h2>
          <p className="setup-section-subtitle">确认用于 llama.cpp 运算的加速显卡并启动本地服务。</p>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <StatusNote kind="error">{error}</StatusNote>
        </div>
      )}

      <div className="setup-device-picker" style={{ marginTop: 16 }}>
        <DevicePicker devices={devices} querying={querying} selected={selected} disabled={confirming} onSelect={onSelect} />
      </div>

      <div className="setup-actions">
        <button type="button" className="setup-primary-button" disabled={busy} onClick={onConfirm}>
          {confirming ? "正在启动…" : "确认并启动服务 →"}
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
