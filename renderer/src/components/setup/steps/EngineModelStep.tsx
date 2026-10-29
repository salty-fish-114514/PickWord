import { pickNativeDirectory, pickNativeFile } from "../../../lib/pathPicker";
import type { EngineModelForm } from "../engineModelForm";
import { PathField } from "../setupShared";
import type { BackendKind, BackendRecommendation, CudaVersion, SetupCatalog } from "../../../lib/types";

interface EngineModelStepProps {
  form: EngineModelForm;
  catalog: SetupCatalog | null;
  recommendation: BackendRecommendation | null;
  busy: boolean;
  onChange: (patch: Partial<EngineModelForm>) => void;
  onBack: () => void;
  onDeploy: () => void;
  onSkip?: () => void;
}

/** 第 2 步：引擎、模型与存放目录。 */
export function EngineModelStep({ form, catalog, recommendation, busy, onChange, onBack, onDeploy, onSkip }: EngineModelStepProps) {
  const needsTargetDir = form.engineSource === "auto" || form.modelSource === "preset";

  async function browseTargetDir() {
    const dir = await pickNativeDirectory({ title: "选择文件存放目录", defaultPath: form.targetDir || undefined });
    if (dir) onChange({ targetDir: dir });
  }
  async function browseExe() {
    const file = await pickNativeFile({
      title: "选择 llama-server.exe",
      defaultPath: form.localExePath || undefined,
      extensions: ["exe"],
      extensionsLabel: "llama-server 可执行程序",
    });
    if (file) onChange({ localExePath: file });
  }
  async function browseModel() {
    const file = await pickNativeFile({
      title: "选择 GGUF 模型文件",
      defaultPath: form.localModelPath || undefined,
      extensions: ["gguf"],
      extensionsLabel: "GGUF 模型权重",
    });
    if (file) onChange({ localModelPath: file });
  }

  return (
    <div className="setup-section setup-step-pane">
      <div className="setup-section-head">
        <div>
          <h2>第 2 步：引擎与模型配置</h2>
          <p className="setup-section-subtitle">
            选择推理后端，指定模型版本与文件保存目录。
            {catalog ? ` 引擎版本 llama.cpp ${catalog.engineTag}。` : ""}
          </p>
        </div>
      </div>

      <div className="setup-form-row">
        <label>运行引擎</label>
        <select disabled={busy} value={form.backendKind} onChange={(e) => onChange({ backendKind: e.target.value as BackendKind })}>
          <option value="cuda">NVIDIA CUDA（最快）</option>
          <option value="rocm">AMD HIP/ROCm（实验性，仅部分型号）</option>
          <option value="vulkan">Vulkan（通用 GPU，AMD 推荐）</option>
          <option value="cpu">纯 CPU</option>
        </select>
      </div>

      {form.backendKind === "rocm" && (
        <p className="setup-hint">
          HIP 只对 RX 6800/6900、RX 7000/9000 系列等部分型号有效；RX 6600/6700/6750 这类旧架构请改用 Vulkan，否则第 4 步会看不到显卡。
        </p>
      )}

      {form.backendKind === "cuda" && (
        <div className="setup-form-row">
          <label>CUDA 版本</label>
          <select disabled={busy} value={form.cudaVersion} onChange={(e) => onChange({ cudaVersion: e.target.value as CudaVersion })}>
            <option value="12.4">CUDA 12.4（兼容 GTX 9xx ~ RTX 40 系）</option>
            <option value="13.x">CUDA 13.x（RTX 50 系必选）</option>
          </select>
        </div>
      )}

      <div className="setup-form-row">
        <label>CPU 线程数</label>
        <input type="number" disabled={busy} min={1} max={128} value={form.threads} onChange={(e) => onChange({ threads: Number(e.target.value) })} />
        {recommendation && <p className="setup-hint">{recommendation.threadsNote}</p>}
      </div>

      <div className="setup-form-row">
        <label>上下文长度（tokens）</label>
        <input
          type="number"
          disabled={busy}
          min={512}
          step={512}
          value={form.contextLength}
          onChange={(e) => onChange({ contextLength: Number(e.target.value) })}
        />
        <p className="setup-hint">写进 llama-server 的 -c 参数。越大越占显存；日后可在「模型与推理」里调整。</p>
      </div>

      {/* 引擎来源 */}
      <div className="setup-form-row">
        <label className="setup-radio-label">
          <input type="radio" name="engineSource" disabled={busy} checked={form.engineSource === "auto"} onChange={() => onChange({ engineSource: "auto" })} />{" "}
          自动下载推荐版本的 llama.cpp
        </label>
      </div>
      <div className="setup-form-row">
        <label className="setup-radio-label">
          <input type="radio" name="engineSource" disabled={busy} checked={form.engineSource === "local"} onChange={() => onChange({ engineSource: "local" })} />{" "}
          使用本地已有的 llama-server（高级）
        </label>
        {form.engineSource === "local" && (
          <div className="radio-content">
            <PathField
              value={form.localExePath}
              disabled={busy}
              placeholder="例如 D:\llama-server\llama-server.exe"
              hint="支持手动填入或通过系统文件选择器选取本地 llama-server.exe。"
              onChange={(v) => onChange({ localExePath: v })}
              onBrowse={() => void browseExe()}
            />
          </div>
        )}
      </div>

      {needsTargetDir && (
        <PathField
          label="文件存放目录（建议选择剩余空间充裕的磁盘）"
          value={form.targetDir}
          disabled={busy}
          placeholder="例如 D:\PickWordData"
          browseLabel="选择目录…"
          browseIcon="folder"
          onChange={(v) => onChange({ targetDir: v })}
          onBrowse={() => void browseTargetDir()}
        />
      )}

      {/* 模型来源 */}
      <div className="setup-form-row">
        <label className="setup-radio-label">
          <input type="radio" name="modelSource" disabled={busy} checked={form.modelSource === "preset"} onChange={() => onChange({ modelSource: "preset" })} />{" "}
          下载预设推荐模型（推荐）
        </label>
        {form.modelSource === "preset" && (
          <div className="radio-content">
            {catalog === null && <p className="setup-hint">正在读取模型清单…</p>}
            {catalog?.models.map((m) => (
              <label key={m.id} className="model-radio">
                <input type="radio" disabled={busy} checked={form.presetUrl === m.url} onChange={() => onChange({ presetUrl: m.url })} />
                <div>
                  <strong>{m.name}</strong>
                  <span>{m.sizeLabel}</span>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="setup-form-row">
        <label className="setup-radio-label">
          <input type="radio" name="modelSource" disabled={busy} checked={form.modelSource === "local"} onChange={() => onChange({ modelSource: "local" })} />{" "}
          使用本地已有的模型文件（.gguf）
        </label>
        {form.modelSource === "local" && (
          <div className="radio-content">
            <PathField
              value={form.localModelPath}
              disabled={busy}
              placeholder="粘贴或选取 .gguf 文件的完整路径"
              onChange={(v) => onChange({ localModelPath: v })}
              onBrowse={() => void browseModel()}
            />
          </div>
        )}
      </div>

      <div className="setup-actions">
        <button type="button" className="setup-secondary-button" onClick={onBack}>
          ← 上一步
        </button>
        <button type="button" className="setup-primary-button" disabled={busy} onClick={onDeploy}>
          开始一键部署 →
        </button>
        {onSkip && (
          <button type="button" className="setup-secondary-button" onClick={onSkip}>
            跳过配置
          </button>
        )}
      </div>
    </div>
  );
}
