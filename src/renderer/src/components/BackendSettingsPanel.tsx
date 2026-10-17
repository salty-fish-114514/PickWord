/**
 * 「模型与推理」面板：在不重跑安装向导的前提下修改 backend.json 的结构化字段
 * （llama-server 路径、模型、端口、线程、上下文长度、推理设备、其它参数），
 * 点「保存并重启」→ setup:apply-config → 主进程写文件并重启后端。
 *
 * 与向导共用 DevicePicker / PathField；参数拆装用 shared/backendArgs，renderer 不手拼 flag。
 */
import { useEffect, useState } from "react";

import { Icon } from "./Icon";
import { DevicePicker } from "./setup/DevicePicker";
import { PathField, StatusNote } from "./setup/setupShared";
import { errorText } from "./setup/setupUtils";
import { pickNativeFile } from "../lib/pathPicker";
import { requireApi } from "../lib/platform";
import type { BackendDeviceInfo } from "../lib/types";
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_PORT,
  DEFAULT_STARTUP_TIMEOUT_SEC,
  MAX_SLOTS,
  composeArgs,
  contextPerSlot,
  joinArgLine,
  splitArgLine,
  splitStructuredArgs,
} from "../../../shared/backendArgs";

interface BackendSettingsPanelProps {
  onClose: () => void;
  /** 「重新运行安装向导」：重新下载 / 换引擎走完整流程。 */
  onRunSetupWizard: () => void;
}

interface FormState {
  exe: string;
  model: string;
  port: number;
  threads: number;
  contextLength: number;
  slots: number;
  device: string;
  extraArgs: string;
  startupTimeoutSec: number;
}

export function BackendSettingsPanel({ onClose, onRunSetupWizard }: BackendSettingsPanelProps) {
  const [form, setForm] = useState<FormState | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [devices, setDevices] = useState<BackendDeviceInfo[]>([]);
  const [querying, setQuerying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const api = requireApi();
    api
      .getSetupState()
      .then((state) => {
        if (!alive) return;
        setConfigPath(state.configPath);
        setProblem(state.configured ? null : state.message);
        const cfg = state.existingConfig;
        const parts = splitStructuredArgs(cfg?.args ?? []);
        setForm({
          exe: cfg?.exe ?? "",
          model: cfg?.model ?? "",
          port: cfg?.port ?? DEFAULT_PORT,
          threads: parts.threads ?? 8,
          contextLength: parts.contextLength ?? DEFAULT_CONTEXT_LENGTH,
          slots: parts.slots ?? 1,
          device: parts.device ?? "",
          extraArgs: joinArgLine(parts.extra),
          startupTimeoutSec: cfg?.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC,
        });
        if (cfg?.exe) void queryDevices();
      })
      .catch((caught) => alive && setError(errorText(caught, "读取配置失败")));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function patch(p: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...p } : prev));
  }

  async function queryDevices() {
    setQuerying(true);
    try {
      setDevices(await requireApi().listBackendDevices());
    } catch (caught) {
      setError(`设备查询失败：${errorText(caught, "未知错误")}`);
    } finally {
      setQuerying(false);
    }
  }

  async function browseExe() {
    const file = await pickNativeFile({ title: "选择 llama-server.exe", defaultPath: form?.exe || undefined, extensions: ["exe"], extensionsLabel: "llama-server 可执行程序" });
    if (file) patch({ exe: file });
  }
  async function browseModel() {
    const file = await pickNativeFile({ title: "选择 GGUF 模型文件", defaultPath: form?.model || undefined, extensions: ["gguf"], extensionsLabel: "GGUF 模型权重" });
    if (file) patch({ model: file });
  }

  function validate(f: FormState): string | null {
    if (!f.exe.trim()) return "请填写 llama-server 可执行文件路径。";
    if (!f.model.trim()) return "请填写模型文件路径。";
    if (!Number.isInteger(f.port) || f.port < 1024 || f.port > 65535) return "端口需在 1024–65535 之间。";
    if (!Number.isFinite(f.threads) || f.threads < 1) return "线程数至少为 1。";
    if (!Number.isFinite(f.contextLength) || f.contextLength < 512) return "上下文长度至少为 512。";
    if (!Number.isInteger(f.slots) || f.slots < 1 || f.slots > MAX_SLOTS) return `并行槽位须在 1～${MAX_SLOTS} 之间。`;
    if (contextPerSlot(f.contextLength, f.slots) < 4096) return "每个槽位分到的上下文不足 4096，请调大上下文长度或减少槽位。";
    return null;
  }

  async function save() {
    if (!form) return;
    const invalid = validate(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await requireApi().applyBackendConfig({
        exe: form.exe.trim(),
        model: form.model.trim(),
        port: form.port,
        startupTimeoutSec: form.startupTimeoutSec,
        args: composeArgs({
          threads: Math.round(form.threads),
          contextLength: Math.round(form.contextLength),
          slots: Math.round(form.slots),
          device: form.device.trim() || null,
          extra: splitArgLine(form.extraArgs),
        }),
      });
      onClose();
    } catch (caught) {
      setError(errorText(caught, "保存失败"));
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="backend-dialog" role="dialog" aria-modal="true" aria-labelledby="backend-dialog-title">
        <header className="backend-dialog-head">
          <div>
            <h2 id="backend-dialog-title">模型与推理</h2>
            <p className="setup-section-subtitle">{configPath ? `配置文件：${configPath}` : "修改后将重启本地推理服务。"}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>

        {problem && <StatusNote title="当前配置不可用">{problem}</StatusNote>}
        {error && <StatusNote kind="error">{error}</StatusNote>}

        {form ? (
          <div className="backend-dialog-body">
            <PathField label="llama-server 可执行文件" value={form.exe} disabled={saving} placeholder="例如 D:\PickWordData\llama\llama-server.exe" onChange={(v) => patch({ exe: v })} onBrowse={() => void browseExe()} />
            <PathField label="模型文件（.gguf）" value={form.model} disabled={saving} placeholder="例如 D:\PickWordData\models\xxx.gguf" onChange={(v) => patch({ model: v })} onBrowse={() => void browseModel()} />

            <div className="backend-dialog-grid">
              <div className="setup-form-row">
                <label>端口</label>
                <input type="number" disabled={saving} min={1024} max={65535} value={form.port} onChange={(e) => patch({ port: Number(e.target.value) })} />
              </div>
              <div className="setup-form-row">
                <label>CPU 线程数（-t）</label>
                <input type="number" disabled={saving} min={1} max={128} value={form.threads} onChange={(e) => patch({ threads: Number(e.target.value) })} />
              </div>
              <div className="setup-form-row">
                <label>上下文长度（-c）</label>
                <input type="number" disabled={saving} min={512} step={512} value={form.contextLength} onChange={(e) => patch({ contextLength: Number(e.target.value) })} />
              </div>
              <div className="setup-form-row">
                <label>并行槽位（--parallel）</label>
                <input type="number" disabled={saving} min={1} max={MAX_SLOTS} value={form.slots} onChange={(e) => patch({ slots: Number(e.target.value) })} />
              </div>
            </div>
            <p className="setup-hint">
              上下文按槽位平分：当前每槽 {contextPerSlot(form.contextLength, form.slots).toLocaleString("zh-CN")} token。槽 0 给候选，槽 1 给纠错等后台检查；只开 1 个槽位时纠错不可用。
            </p>

            <div className="setup-form-row">
              <label>推理设备（--device）</label>
              <div className="setup-device-picker">
                <DevicePicker devices={devices} querying={querying} selected={form.device} allowAuto disabled={saving} onSelect={(id) => patch({ device: id })} />
              </div>
              <div className="backend-dialog-inline">
                <button type="button" className="setup-secondary-button" disabled={querying || saving || !form.exe.trim()} onClick={() => void queryDevices()}>
                  {querying ? "查询中…" : "重新查询设备"}
                </button>
                <p className="setup-hint">设备列表来自上面填写的 llama-server；换了可执行文件请重新查询。</p>
              </div>
            </div>

            <div className="setup-form-row">
              <label>其它启动参数（高级）</label>
              <input type="text" disabled={saving} value={form.extraArgs} placeholder="例如 --no-mmap -ngl 99" onChange={(e) => patch({ extraArgs: e.target.value })} />
              <p className="setup-hint">-m / --port / -c / -t / --device 由上方字段管理，这里写了也会被忽略。</p>
            </div>
          </div>
        ) : (
          !error && <p className="setup-hint">正在读取配置…</p>
        )}

        <footer className="setup-actions backend-dialog-actions">
          <button type="button" className="setup-primary-button" disabled={!form || saving} onClick={() => void save()}>
            {saving ? "正在保存…" : "保存并重启服务"}
          </button>
          <button type="button" className="setup-secondary-button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="button" className="setup-secondary-button backend-dialog-wizard" disabled={saving} onClick={onRunSetupWizard}>
            重新运行安装向导…
          </button>
        </footer>
      </section>
    </div>
  );
}
