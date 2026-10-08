import { useEffect, useState } from "react";
import type {
  BackendKind,
  DownloadProgress,
  HardwareReport,
  ModelPreset,
  SetupState,
} from "../lib/types";

interface SetupWizardProps {
  state: SetupState | null;
  error?: string;
  checking: boolean;
  onRefresh: () => Promise<void>;
}

const BACKEND_KIND_LABEL: Record<string, string> = {
  cuda: "NVIDIA CUDA",
  rocm: "AMD HIP/ROCm",
  vulkan: "Vulkan（通用 GPU）",
  cpu: "纯 CPU",
};

const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "qwen-9b-q4",
    name: "Qwen3.5 9B（Q4_K_M）",
    sizeLabel: "约 5.6 GB · 适合 8GB 显存或 16GB 内存",
    url: "https://modelscope.cn/models/unsloth/Qwen3.5-9B-GGUF/resolve/master/Qwen3.5-9B-Q4_K_M.gguf",
  },
  {
    id: "qwen-9b-q8",
    name: "Qwen3.5 9B（Q8_0）",
    sizeLabel: "约 9.8 GB · 适合 12GB 显存或 24GB 内存",
    url: "https://modelscope.cn/models/unsloth/Qwen3.5-9B-GGUF/resolve/master/Qwen3.5-9B-Q8_0.gguf",
  },
  {
    id: "qwen-35b-q4",
    name: "Qwen3.5 35B-A3B（Q4_K_M）",
    sizeLabel: "约 21.4 GB · 适合 16GB 显存 + 充足内存",
    url: "https://modelscope.cn/models/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/master/Qwen3.5-35B-A3B-Q4_K_M.gguf",
  },
  {
    id: "qwen-35b-q8",
    name: "Qwen3.5 35B-A3B（Q8_0）",
    sizeLabel: "约 37.5 GB · 写作效果最佳，需充足内存/显存",
    url: "https://modelscope.cn/models/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/master/Qwen3.5-35B-A3B-Q8_0.gguf",
  },
];

type EngineSource = "auto" | "local";
type ModelSource = "preset" | "local";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "未知";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} B`;
}

export function SetupWizard({ state, error, onRefresh }: SetupWizardProps) {
  /* ── 第 1 步：硬件检测 ── */
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  /* ── 第 2 步：引擎与模型 ── */
  const [backendKind, setBackendKind] = useState<BackendKind>("vulkan");
  const [cudaVersion, setCudaVersion] = useState<"12.4" | "13.x">("12.4");
  const [threads, setThreads] = useState(4);

  const [engineSource, setEngineSource] = useState<EngineSource>("auto");
  const [localExePath, setLocalExePath] = useState("");

  const [modelSource, setModelSource] = useState<ModelSource>("preset");
  const [selectedPresetUrl, setSelectedPresetUrl] = useState(MODEL_PRESETS[2].url);
  const [localModelPath, setLocalModelPath] = useState("");

  const [targetDir, setTargetDir] = useState("D:\\PickWordData");

  /* ── 第 3 步：部署 ── */
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    if (!window.api?.onDeployProgress) return;
    const unsub = window.api.onDeployProgress((p) => setProgress(p));
    return typeof unsub === "function" ? unsub : undefined;
  }, []);

  /* ── 检测 ── */
  async function runDetection() {
    if (!window.api?.detectHardware) {
      setDetectError("当前环境不支持硬件检测。");
      return;
    }
    setDetecting(true);
    setDetectError(null);
    try {
      const report = await window.api.detectHardware();
      setHardware(report);
      setBackendKind(report.recommendation.kind);
      if (report.recommendation.cudaVersion) setCudaVersion(report.recommendation.cudaVersion);
      if (report.recommendation.recommendedThreads !== null) setThreads(report.recommendation.recommendedThreads);
    } catch (caught) {
      setDetectError(caught instanceof Error ? caught.message : "检测失败");
    } finally {
      setDetecting(false);
    }
  }

  /* ── 部署 ── */
  async function runDeploy() {
    if (!window.api?.deployBackend) return;

    if (engineSource === "local" && !localExePath.trim()) {
      setDeployError("请输入 llama-server.exe 的完整路径。");
      return;
    }
    if (modelSource === "local" && !localModelPath.trim()) {
      setDeployError("请输入 .gguf 模型文件的完整路径。");
      return;
    }
    if (engineSource === "auto" && !targetDir.trim()) {
      setDeployError("请输入文件存放目录。");
      return;
    }

    setDeploying(true);
    setDeployError(null);
    setProgress(null);

    try {
      await window.api.deployBackend({
        targetDir: targetDir.trim(),
        backendKind,
        cudaVersion,
        modelUrl: modelSource === "preset" ? selectedPresetUrl : "",
        localModelPath: modelSource === "local" ? localModelPath.trim() : undefined,
        localExePath: engineSource === "local" ? localExePath.trim() : undefined,
        threads,
      });

      // ─── 关键改动：部署成功后，立即通知主进程启动后端 ───
      if (window.api.retryBackend) {
        await window.api.retryBackend();
      }

      // 然后再刷新界面进入编辑器
      await onRefresh();
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "部署中断";
      setDeployError(msg);
      setDeploying(false);
    }
  }

  function cancelDeploy() {
    window.api?.cancelDeploy?.();
    setDeploying(false);
    setDeployError("已取消部署。");
    setProgress(null);
  }

  const rec = hardware?.recommendation ?? null;
  const step2Enabled = hardware !== null;

  return (
    <main className="setup-root">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-brand">PickWord</div>
        <h1 id="setup-title">准备本地写作模型</h1>

        <p className="setup-description">
          PickWord 主程序已经安装。下面先检测此电脑的硬件，然后根据结果下载合适的模型运行环境。
        </p>

        {error && (
          <div className="setup-status is-error">
            <strong>环境异常</strong>
            <span>{error}</span>
          </div>
        )}
        {state && !state.configured && !error && (
          <div className="setup-status">
            <strong>需要配置</strong>
            <span>{state.message}</span>
          </div>
        )}

        {/* ═══ 第 1 步 ═══ */}
        <div className="setup-section">
          <div className="setup-section-head">
            <h2>第 1 步：硬件检测</h2>
            <button
              className="setup-secondary-button"
              disabled={detecting || deploying}
              onClick={() => void runDetection()}
            >
              {detecting ? "正在检测…" : hardware ? "重新检测" : "开始检测"}
            </button>
          </div>

          {detectError && (
            <div className="setup-status is-error" style={{ marginTop: 12 }}>
              <span>{detectError}</span>
            </div>
          )}

          {hardware && (
            <>
              <dl className="setup-facts">
                <div>
                  <dt>处理器</dt>
                  <dd>
                    {hardware.cpu.name}
                    <small>
                      {hardware.cpu.physicalCores !== null
                        ? `${hardware.cpu.physicalCores} 核 ${hardware.cpu.logicalCores} 线程`
                        : `物理核心未知 · ${hardware.cpu.logicalCores} 逻辑处理器`}
                      {hardware.cpu.isKnownMultiCcd ? " · 多 CCD" : ""}
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>内存</dt>
                  <dd>{formatBytes(hardware.ramBytes)}</dd>
                </div>
                {hardware.gpus.length === 0 ? (
                  <div>
                    <dt>显卡</dt>
                    <dd>未检测到</dd>
                  </div>
                ) : (
                  hardware.gpus.map((gpu, i) => (
                    <div key={`${gpu.name}-${i}`}>
                      <dt>显卡</dt>
                      <dd>
                        {gpu.name}
                        <small>
                          显存 {formatBytes(gpu.vramBytes)}
                          {gpu.vramBytes !== null ? `（来源: ${gpu.vramSource}）` : ""}
                        </small>
                      </dd>
                    </div>
                  ))
                )}
                {hardware.nvidiaDriverVersion && (
                  <div>
                    <dt>NVIDIA 驱动</dt>
                    <dd>{hardware.nvidiaDriverVersion}</dd>
                  </div>
                )}
              </dl>

              {rec && (
                <div className="setup-recommend">
                  <strong>
                    推荐引擎：{BACKEND_KIND_LABEL[rec.kind]}
                    {rec.cudaVersion ? `（CUDA ${rec.cudaVersion}）` : ""}
                  </strong>
                  <span>{rec.reason}</span>
                  <span>建议线程数：{rec.recommendedThreads ?? "请手动设置"}。{rec.threadsNote}</span>
                </div>
              )}

              {hardware.warnings.length > 0 && (
                <ul className="setup-warnings">
                  {hardware.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* ═══ 第 2 步 ═══ */}
        <div className={`setup-section ${!step2Enabled ? "is-dimmed" : ""}`}>
          <h2>第 2 步：引擎与模型</h2>

          {/* 运行引擎 */}
          <div className="setup-form-row">
            <label>运行引擎</label>
            <select disabled={deploying} value={backendKind} onChange={(e) => setBackendKind(e.target.value as BackendKind)}>
              <option value="cuda">NVIDIA CUDA（最快）</option>
              <option value="rocm">AMD HIP/ROCm（部分型号较快）</option>
              <option value="vulkan">Vulkan（通用 GPU）</option>
              <option value="cpu">纯 CPU</option>
            </select>
          </div>

          {backendKind === "cuda" && (
            <div className="setup-form-row">
              <label>CUDA 版本</label>
              <select disabled={deploying} value={cudaVersion} onChange={(e) => setCudaVersion(e.target.value as "12.4" | "13.x")}>
                <option value="12.4">CUDA 12.4（兼容 GTX 9xx ~ RTX 40 系）</option>
                <option value="13.x">CUDA 13.x（RTX 50 系必选）</option>
              </select>
            </div>
          )}

          <div className="setup-form-row">
            <label>CPU 线程数</label>
            <input type="number" disabled={deploying} min={1} max={128} value={threads} onChange={(e) => setThreads(Number(e.target.value))} />
            {rec && <p className="setup-hint">{rec.threadsNote}</p>}
          </div>

          {/* 引擎来源 */}
          <div className="setup-form-row">
            <label>
              <input type="radio" name="engineSource" disabled={deploying} checked={engineSource === "auto"} onChange={() => setEngineSource("auto")} />
              {" "}自动下载推荐版本的 llama.cpp
            </label>
          </div>
          <div className="setup-form-row">
            <label>
              <input type="radio" name="engineSource" disabled={deploying} checked={engineSource === "local"} onChange={() => setEngineSource("local")} />
              {" "}使用本地已有的 llama-server（高级）
            </label>
            {engineSource === "local" && (
              <div className="radio-content">
                <input
                  type="text"
                  disabled={deploying}
                  value={localExePath}
                  onChange={(e) => setLocalExePath(e.target.value)}
                  placeholder="例如 D:\llama-b8868-bin-win-hip-radeon-x64\llama-server.exe"
                />
                <p className="setup-hint">请粘贴 llama-server.exe 的完整路径。此选项不会下载引擎。</p>
              </div>
            )}
          </div>

          {/* 文件存放 */}
          {(engineSource === "auto" || modelSource === "preset") && (
            <div className="setup-form-row">
              <label>文件存放目录（引擎和模型可达数十 GB，建议放非系统盘）</label>
              <input
                type="text"
                disabled={deploying}
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                placeholder="例如 D:\PickWordData"
              />
            </div>
          )}

          {/* 模型来源 */}
          <div className="setup-form-row">
            <label>
              <input type="radio" name="modelSource" disabled={deploying} checked={modelSource === "preset"} onChange={() => setModelSource("preset")} />
              {" "}下载预设模型（推荐）
            </label>
            {modelSource === "preset" && (
              <div className="radio-content">
                {MODEL_PRESETS.map((m) => (
                  <label key={m.id} className="model-radio">
                    <input type="radio" disabled={deploying} checked={selectedPresetUrl === m.url} onChange={() => setSelectedPresetUrl(m.url)} />
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
            <label>
              <input type="radio" name="modelSource" disabled={deploying} checked={modelSource === "local"} onChange={() => setModelSource("local")} />
              {" "}使用本地已有的模型文件（高级）
            </label>
            {modelSource === "local" && (
              <div className="radio-content">
                <input
                  type="text"
                  disabled={deploying}
                  value={localModelPath}
                  onChange={(e) => setLocalModelPath(e.target.value)}
                  placeholder="粘贴 .gguf 文件的完整路径"
                />
              </div>
            )}
          </div>
        </div>

        {/* ═══ 第 3 步 ═══ */}
        <div className="setup-section">
          <h2>第 3 步：开始部署</h2>

          {deployError && (
            <div className="setup-status is-error" style={{ marginTop: 12 }}>
              <span>{deployError}</span>
            </div>
          )}

          {deploying && progress && (
            <div className="progress-box" style={{ marginTop: 12 }}>
              <span>{progress.filename}</span>
              <div className="progress-stats">
                {progress.totalBytes > 0 && (
                  <span>{formatBytes(progress.receivedBytes)} / {formatBytes(progress.totalBytes)}</span>
                )}
                {progress.overallFraction !== undefined && (
                  <span>{Math.round(progress.overallFraction * 100)}%</span>
                )}
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${(progress.overallFraction ?? 0) * 100}%` }} />
              </div>
            </div>
          )}

          <div className="setup-actions">
            {deploying ? (
              <button type="button" className="setup-cancel-button" onClick={cancelDeploy}>
                取消部署
              </button>
            ) : (
              <button
                type="button"
                className="setup-primary-button"
                disabled={!step2Enabled}
                onClick={() => void runDeploy()}
              >
                开始一键部署
              </button>
            )}
          </div>
        </div>

        <p className="setup-footnote">
          部署完成后将自动进入写作界面。配置保存在用户数据目录，卸载程序不会删除模型文件。
        </p>
      </section>
    </main>
  );
}