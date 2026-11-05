import type { ReactNode } from "react";

import { formatBytes } from "./setupUtils";
import type { BackendDeviceInfo } from "../../lib/types";

interface DevicePickerProps {
  devices: BackendDeviceInfo[];
  querying: boolean;
  /** 当前选中的设备 id；"" = 交给 llama.cpp 自己选（不写 --device）。 */
  selected: string;
  /** 是否显示「自动（默认）」这一项；向导里用按钮代替，面板里用它。 */
  allowAuto?: boolean;
  disabled?: boolean;
  onSelect: (deviceId: string) => void;
  /** 空列表时的说明；不给就用默认那句（首页「模型与推理」面板走默认）。 */
  emptyHint?: string;
  /** 空列表时附在下面的操作（向导里放「改用 Vulkan」按钮）。 */
  emptyAction?: ReactNode;
}

/** llama-server --list-devices 结果的单选列表（向导第 4 步与「模型与推理」面板共用）。 */
export function DevicePicker({ devices, querying, selected, allowAuto = false, disabled, onSelect, emptyHint, emptyAction }: DevicePickerProps) {
  if (querying) return <p className="setup-device-hint">正在查询可用计算设备…</p>;
  if (devices.length === 0) {
    return (
      <>
        <p className="setup-device-empty">
          {emptyHint ?? "未检测到可用的 GPU 设备（纯 CPU 引擎也会显示为空）。将使用默认设备配置启动服务。"}
          <br />
          <small>可在启动后随时在「模型与推理」里重新查询或切换引擎。</small>
        </p>
        {emptyAction}
      </>
    );
  }
  return (
    <div className="setup-device-list">
      {allowAuto && (
        <label className={`setup-device-option ${selected === "" ? "is-selected" : ""}`}>
          <input type="radio" name="backendDevice" value="" disabled={disabled} checked={selected === ""} onChange={() => onSelect("")} />
          <div className="setup-device-info">
            <strong>自动</strong>
            <span className="setup-device-name">不指定 --device，由 llama.cpp 自行选择</span>
          </div>
        </label>
      )}
      {devices.map((device) => (
        <label key={device.id} className={`setup-device-option ${selected === device.id ? "is-selected" : ""}`}>
          <input
            type="radio"
            name="backendDevice"
            value={device.id}
            disabled={disabled}
            checked={selected === device.id}
            onChange={() => onSelect(device.id)}
          />
          <div className="setup-device-info">
            <strong>{device.id}</strong>
            <span className="setup-device-name">{device.name}</span>
            {device.freeVramBytes !== null && <span className="setup-device-vram">可用显存 {formatBytes(device.freeVramBytes)}</span>}
          </div>
        </label>
      ))}
    </div>
  );
}
