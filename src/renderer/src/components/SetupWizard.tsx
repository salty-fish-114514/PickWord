import { useEffect, useState } from "react";
import type {
  BackendDeviceInfo,
  BackendKind,
  DownloadProgress,
  ExistingBackendConfig,
  HardwareReport,
  ModelPreset,
  SetupState,
} from "../lib/types";
import { pickNativeDirectory, pickNativeFile } from "../lib/pathPicker";
import { Icon } from "./Icon";

interface SetupWizardProps {
  state: SetupState | null;
  error?: string;
  checking?: boolean;
  onRefresh: () => Promise<void>;
  onSkip?: () => void;
  /** 现有的后端配置（用于旧版本升级后直接进入设备选择） */
  existingConfig?: ExistingBackendConfig;
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
type WizardStep = 1 | 2 | 3 | 4;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "未知";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} B`;
}

export function SetupWizard({ state, error, onRefresh, onSkip, existingConfig }: SetupWizardProps) {
  /* ── 步骤导航 ── */
  const [currentStep, setCurrentStep] = useState<WizardStep>(existingConfig ? 4 : 1);

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

  /* ── 第 4 步：设备选择（部署后自动运行 --list-devices）── */
  const [devices, setDevices] = useState<BackendDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [deviceQuerying, setDeviceQuerying] = useState(false);
  const [showDevicePicker, setShowDevicePicker] = useState(false);

  useEffect(() => {
    if (!window.api?.onDeployProgress) return;
    const unsub = window.api.onDeployProgress((p) => setProgress(p));
    return typeof unsub === "function" ? unsub : undefined;
  }, []);

  /* ── 从现有配置预填表单字段（重新配置/旧版本升级场景）──
   * 当 state.existingConfig 存在时，将已有的 exe/model 路径预填到表单中，
   * 并从 args 数组中提取 context size 和 threads 等参数。
   * 这样用户不必从零手填，只需调整需要变更的部分。
   */
  useEffect(() => {
    const ec = state?.existingConfig;
    if (!ec || existingConfig) return; // existingConfig prop 走简化 UI，不需要预填

    // 预填引擎路径（使用本地 exe 模式）
    if (ec.exe) {
      setEngineSource("local");
      setLocalExePath(ec.exe);
    }

    // 预填模型路径（使用本地模型模式）
    if (ec.model) {
      setModelSource("local");
      setLocalModelPath(ec.model);
    }

    // 从 args 中提取已知参数值
    if (Array.isArray(ec.args) && ec.args.length > 0) {
      const args = ec.args;
      // 查找 -t（线程数）
      const tIdx = args.indexOf("-t");
      if (tIdx >= 0 && tIdx + 1 < args.length) {
        const val = parseInt(args[tIdx + 1], 10);
        if (!isNaN(val) && val > 0) setThreads(val);
      }
    }
  }, [state?.existingConfig, existingConfig]);

  /* ── 硬件检测 ── */
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
      setDeployError("请输入或选择 llama-server.exe 的完整路径。");
      return;
    }
    if (modelSource === "local" && !localModelPath.trim()) {
      setDeployError("请输入或选择 .gguf 模型文件的完整路径。");
      return;
    }
    if (engineSource === "auto" && !targetDir.trim()) {
      setDeployError("请输入或选择文件存放目录。");
      return;
    }

    setDeploying(true);
    setCurrentStep(3);
    setDeployError(null);
    setProgress(null);
    setShowDevicePicker(false);

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

      // 部署成功后：查询可用设备并进入步骤 4
      await queryDevicesAndShow();
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

  /** 查询 llama-server 的可用设备并显示选择器 */
  async function queryDevicesAndShow() {
    setDeviceQuerying(true);
    setDeploying(false);
    setCurrentStep(4);
    try {
      const list = (await window.api?.listBackendDevices?.()) ?? [];
      setDevices(list);
      setShowDevicePicker(true);
      const gpuDevices = list.filter((d) => !d.id.startsWith("CPU"));
      if (gpuDevices.length > 0) {
        setSelectedDevice(gpuDevices[0].id);
      } else if (list.length > 0) {
        setSelectedDevice(list[0].id);
      }
    } catch (err) {
      setDeployError(`设备查询失败：${err instanceof Error ? err.message : String(err)}`);
      await finishSetup();
    } finally {
      setDeviceQuerying(false);
    }
  }

  /** 确认设备选择 → 写入 backend.json → 启动后端 → 进入编辑器 */
  async function confirmDeviceSelection() {
    try {
      if (window.api?.updateBackendDevice) {
        await window.api.updateBackendDevice(selectedDevice || "none");
      }
      await finishSetup();
    } catch (err) {
      setDeployError(`保存设备配置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function skipDeviceSelection() {
    setShowDevicePicker(false);
    void finishSetup();
  }

  async function finishSetup() {
    window.api?.deployFinished?.();
    try {
      if (window.api?.retryBackend) {
        await window.api.retryBackend();
      }
    } catch {
      // 启动失败不阻塞进入
    }
    await onRefresh();
  }

  /* ── 重新配置场景：加载已有配置时查询设备 ── */
  useEffect(() => {
    if (state?.configured && !showDevicePicker && !deploying) {
      const tryLoad = async () => {
        if (!window.api?.listBackendDevices) return;
        try {
          const list = await window.api.listBackendDevices();
          if (list.length > 0) {
            setDevices(list);
            setShowDevicePicker(true);
            setCurrentStep(4);
            const gpuDevices = list.filter((oe) => !oe.id.startsWith("CPU"));
            setSelectedDevice(gpuDevices.length > 0 ? gpuDevices[0].id : list[0].id);
          }
        } catch {
          // 查询失败不阻塞
        }
      };
      void tryLoad();
    }
  }, [state?.configured]);

  const rec = hardware?.recommendation ?? null;
  const step2Enabled = hardware !== null;

  /* ── 原生路径交互选择函数 ── */
  async function chooseTargetDirectory() {
    const dir = await pickNativeDirectory(targetDir);
    if (dir) setTargetDir(dir);
  }

  async function chooseLocalExeFile() {
    const file = await pickNativeFile({
      accept: ".exe",
      description: "llama-server 可执行程序 (*.exe)",
      defaultPath: localExePath || "D:\\llama-server.exe",
    });
    if (file) setLocalExePath(file);
  }

  async function chooseLocalModelFile() {
    const file = await pickNativeFile({
      accept: ".gguf",
      description: "GGUF 模型权重文件 (*.gguf)",
      defaultPath: localModelPath || "D:\\model.gguf",
    });
    if (file) setLocalModelPath(file);
  }

  /* ── 旧版本升级场景：直接显示设备选择界面 ── */
  if (existingConfig) {
    return (
      <main className="setup-root">
        <section className="setup-card" aria-labelledby="setup-title">
          <div className="setup-header-row">
            <div className="setup-brand">PickWord</div>
            {onSkip && (
              <button type="button" className="setup-skip-link" onClick={onSkip}>
                跳过配置，先体验写作 →
              </button>
            )}
          </div>

          <h1 id="setup-title">选择推理设备</h1>
          <p className="setup-description">
            检测到您之前已经配置过模型，现在只需要选择推理设备即可。
          </p>

          {state && !state.configured && (
            <div className="setup-status">
              <strong>配置状态</strong>
              <span>{state.message}</span>
            </div>
          )}

          {deployError && (
            <div className="setup-status is-error" style={{ marginTop: 12 }}>
              <span>{deployError}</span>
            </div>
          )}

          {/* 设备选择 */}
          <div className="setup-section">
            <div className="setup-section-head">
              <div>
                <h2>选择推理设备</h2>
                <p className="setup-section-subtitle">确认用于 llama.cpp 运算的加速显卡并启动本地服务。</p>
              </div>
            </div>

            <div className="setup-device-picker" style={{ marginTop: 16 }}>
              {deviceQuerying ? (
                <p>正在查询可用计算设备…</p>
              ) : devices.length === 0 ? (
                <p className="setup-device-empty">
                  未检测到专属 GPU 设备。将使用默认设备配置启动服务。
                  <br />
                  <small>可在启动后随时在设置面板中重新切换设备或调整后端参数。</small>
                </p>
              ) : devices.length === 1 ? (
                <>
                  <p>已识别到可用设备：</p>
                  <div className="setup-device-list">
                    {devices.map((device) => (
                      <div key={device.id} className="setup-device-option is-selected">
                        <div className="setup-device-info">
                          <strong>{device.id}</strong>
                          <span className="setup-device-name">{device.name}</span>
                          {device.freeVramBytes !== null && (
                            <span className="setup-device-vram">
                              可用显存 {formatBytes(device.freeVramBytes)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="setup-device-list">
                  {devices.map((device) => (
                    <label key={device.id} className={`setup-device-option ${selectedDevice === device.id ? "is-selected" : ""}`}>
                      <input
                        type="radio"
                        name="backendDevice"
                        value={device.id}
                        checked={selectedDevice === device.id}
                        onChange={() => setSelectedDevice(device.id)}
                      />
                      <div className="setup-device-info">
                        <strong>{device.id}</strong>
                        <span className="setup-device-name">{device.name}</span>
                        {device.freeVramBytes !== null && (
                          <span className="setup-device-vram">
                            可用显存 {formatBytes(device.freeVramBytes)}
                          </span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="setup-actions">
            <button
              type="button"
              className="setup-primary-button"
              disabled={deviceQuerying}
              onClick={() => void confirmDeviceSelection()}
            >
              确认并启动服务 →
            </button>
            {devices.length > 0 && (
              <button
                type="button"
                className="setup-secondary-button"
                onClick={skipDeviceSelection}
              >
                使用默认设备
              </button>
            )}
          </div>

          <p className="setup-footnote">
            配置完成后将自动进入写作界面。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="setup-root">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-header-row">
          <div className="setup-brand">PickWord</div>
          {onSkip && currentStep < 3 && (
            <button type="button" className="setup-skip-link" onClick={onSkip}>
              跳过配置，先体验写作 →
            </button>
          )}
        </div>

        <h1 id="setup-title">准备本地写作模型</h1>
        <p className="setup-description">
          检测电脑硬件，一键部署推荐的本地大语言模型与 llama.cpp 推理环境。
        </p>

        {/* ── 步骤导航条 ── */}
        <div className="setup-step-bar" aria-label="安装向导步骤">
          {[
            { step: 1, label: "1. 硬件检测" },
            { step: 2, label: "2. 引擎与模型" },
            { step: 3, label: "3. 下载与部署" },
            { step: 4, label: "4. 设备与启动" },
          ].map((s) => {
            const isCurrent = currentStep === s.step;
            const isCompleted = currentStep > s.step;
            return (
              <button
                key={s.step}
                type="button"
                className={`setup-step-pill ${isCurrent ? "is-active" : ""} ${isCompleted ? "is-done" : ""}`}
                disabled={deploying || (s.step === 2 && !step2Enabled) || s.step > currentStep}
                onClick={() => {
                  if (s.step === 1 || (s.step === 2 && step2Enabled)) {
                    setCurrentStep(s.step as WizardStep);
                  }
                }}
              >
                <span className="step-num">{isCompleted ? "✓" : s.step}</span>
                <span className="step-text">{s.label.split(". ")[1]}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="setup-status is-error" role="alert">
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

        {/* ═══════ 步骤 1：硬件检测 ═══════ */}
        {currentStep === 1 && (
          <div className="setup-section setup-step-pane">
            <div className="setup-section-head">
              <div>
                <h2>第 1 步：硬件检测</h2>
                <p className="setup-section-subtitle">识别 CPU、内存大小及可用 GPU 显卡，给出最佳运行建议。</p>
              </div>
              <button
                className="setup-secondary-button"
                type="button"
                disabled={detecting}
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

            {hardware ? (
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
                      <dd>未检测到独立显卡</dd>
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
                            {gpu.isIntegrated ? " · 集成显卡" : " · 独立显卡"}
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

                <div className="setup-actions">
                  <button
                    type="button"
                    className="setup-primary-button"
                    onClick={() => setCurrentStep(2)}
                  >
                    下一步：选择引擎与模型 →
                  </button>
                  {onSkip && (
                    <button type="button" className="setup-secondary-button" onClick={onSkip}>
                      跳过配置
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="setup-empty-detect">
                <p>点击上方「开始检测」按钮，向导将自动评估此电脑支持的加速方式。</p>
              </div>
            )}
          </div>
        )}

        {/* ═══════ 步骤 2：引擎与模型 ═══════ */}
        {currentStep === 2 && (
          <div className="setup-section setup-step-pane">
            <div className="setup-section-head">
              <div>
                <h2>第 2 步：引擎与模型配置</h2>
                <p className="setup-section-subtitle">选择推理后端，指定模型版本与文件保存目录。</p>
              </div>
            </div>

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
              <label className="setup-radio-label">
                <input type="radio" name="engineSource" disabled={deploying} checked={engineSource === "auto"} onChange={() => setEngineSource("auto")} />
                {" "}自动下载推荐版本的 llama.cpp
              </label>
            </div>
            <div className="setup-form-row">
              <label className="setup-radio-label">
                <input type="radio" name="engineSource" disabled={deploying} checked={engineSource === "local"} onChange={() => setEngineSource("local")} />
                {" "}使用本地已有的 llama-server（高级）
              </label>
              {engineSource === "local" && (
                <div className="radio-content">
                  <div className="setup-input-browse-group">
                    <input
                      type="text"
                      disabled={deploying}
                      value={localExePath}
                      onChange={(e) => setLocalExePath(e.target.value)}
                      placeholder="例如 D:\llama-server\llama-server.exe"
                    />
                    <button
                      type="button"
                      className="setup-browse-button"
                      disabled={deploying}
                      onClick={() => void chooseLocalExeFile()}
                      title="打开文件管理器选择 exe"
                    >
                      <Icon name="open" size={15} />
                      浏览…
                    </button>
                  </div>
                  <p className="setup-hint">支持手动填入或通过系统文件选择器选取本地 llama-server.exe。</p>
                </div>
              )}
            </div>

            {/* 文件存放目录 */}
            {(engineSource === "auto" || modelSource === "preset") && (
              <div className="setup-form-row">
                <label>文件存放目录（建议选择剩余空间充裕的磁盘）</label>
                <div className="setup-input-browse-group">
                  <input
                    type="text"
                    disabled={deploying}
                    value={targetDir}
                    onChange={(e) => setTargetDir(e.target.value)}
                    placeholder="例如 D:\PickWordData"
                  />
                  <button
                    type="button"
                    className="setup-browse-button"
                    disabled={deploying}
                    onClick={() => void chooseTargetDirectory()}
                    title="打开系统文件夹选择器"
                  >
                    <Icon name="folder" size={15} />
                    选择目录…
                  </button>
                </div>
              </div>
            )}

            {/* 模型来源 */}
            <div className="setup-form-row">
              <label className="setup-radio-label">
                <input type="radio" name="modelSource" disabled={deploying} checked={modelSource === "preset"} onChange={() => setModelSource("preset")} />
                {" "}下载预设推荐模型（推荐）
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
              <label className="setup-radio-label">
                <input type="radio" name="modelSource" disabled={deploying} checked={modelSource === "local"} onChange={() => setModelSource("local")} />
                {" "}使用本地已有的模型文件（.gguf）
              </label>
              {modelSource === "local" && (
                <div className="radio-content">
                  <div className="setup-input-browse-group">
                    <input
                      type="text"
                      disabled={deploying}
                      value={localModelPath}
                      onChange={(e) => setLocalModelPath(e.target.value)}
                      placeholder="粘贴或选取 .gguf 文件的完整路径"
                    />
                    <button
                      type="button"
                      className="setup-browse-button"
                      disabled={deploying}
                      onClick={() => void chooseLocalModelFile()}
                      title="打开文件管理器选择 gguf"
                    >
                      <Icon name="open" size={15} />
                      浏览…
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="setup-actions">
              <button
                type="button"
                className="setup-secondary-button"
                onClick={() => setCurrentStep(1)}
              >
                ← 上一步
              </button>
              <button
                type="button"
                className="setup-primary-button"
                onClick={() => void runDeploy()}
              >
                开始一键部署 →
              </button>
              {onSkip && (
                <button type="button" className="setup-secondary-button" onClick={onSkip}>
                  跳过配置
                </button>
              )}
            </div>
          </div>
        )}

        {/* ═══════ 步骤 3：部署与下载进度 ═══════ */}
        {currentStep === 3 && (
          <div className="setup-section setup-step-pane">
            <div className="setup-section-head">
              <div>
                <h2>第 3 步：下载与环境部署</h2>
                <p className="setup-section-subtitle">
                  {deploying ? "正在下载引擎与模型权重，请保持网络畅通。" : "部署环境配置。"}
                </p>
              </div>
            </div>

            {deployError && (
              <div className="setup-status is-error" style={{ marginTop: 12 }}>
                <span>{deployError}</span>
              </div>
            )}

            {progress ? (
              <div className="progress-box" style={{ marginTop: 16 }}>
                <div className="progress-filename-row">
                  <Icon name="upload" size={16} />
                  <strong>{progress.filename}</strong>
                </div>
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
            ) : (
              <div className="setup-deploy-waiting">
                {deploying ? (
                  <p>正在初始化环境并连接下载源，请稍候…</p>
                ) : (
                  <p>准备就绪。若下载中断，可点击重新部署。</p>
                )}
              </div>
            )}

            <div className="setup-actions">
              {deploying ? (
                <button type="button" className="setup-cancel-button" onClick={cancelDeploy}>
                  取消部署
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="setup-secondary-button"
                    onClick={() => setCurrentStep(2)}
                  >
                    ← 返回修改配置
                  </button>
                  <button
                    type="button"
                    className="setup-primary-button"
                    onClick={() => void runDeploy()}
                  >
                    重新部署
                  </button>
                  <button
                    type="button"
                    className="setup-secondary-button"
                    onClick={() => void queryDevicesAndShow()}
                  >
                    直接查询设备 →
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ═══════ 步骤 4：设备选择与启动 ═══════ */}
        {currentStep === 4 && (
          <div className="setup-section setup-step-pane">
            <div className="setup-section-head">
              <div>
                <h2>第 4 步：选择推理设备</h2>
                <p className="setup-section-subtitle">确认用于 llama.cpp 运算的加速显卡并启动本地服务。</p>
              </div>
            </div>

            {deployError && (
              <div className="setup-status is-error" style={{ marginTop: 12 }}>
                <span>{deployError}</span>
              </div>
            )}

            <div className="setup-device-picker" style={{ marginTop: 16 }}>
              {deviceQuerying ? (
                <p>正在查询可用计算设备…</p>
              ) : devices.length === 0 ? (
                <p className="setup-device-empty">
                  未检测到专属 GPU 设备。将使用默认设备配置启动服务。
                  <br />
                  <small>可在启动后随时在设置面板中重新切换设备或调整后端参数。</small>
                </p>
              ) : devices.length === 1 ? (
                <>
                  <p>已识别到可用设备：</p>
                  <div className="setup-device-list">
                    {devices.map((device) => (
                      <div key={device.id} className="setup-device-option is-selected">
                        <div className="setup-device-info">
                          <strong>{device.id}</strong>
                          <span className="setup-device-name">{device.name}</span>
                          {device.freeVramBytes !== null && (
                            <span className="setup-device-vram">
                              可用显存 {formatBytes(device.freeVramBytes)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="setup-device-list">
                  {devices.map((device) => (
                    <label key={device.id} className={`setup-device-option ${selectedDevice === device.id ? "is-selected" : ""}`}>
                      <input
                        type="radio"
                        name="backendDevice"
                        value={device.id}
                        checked={selectedDevice === device.id}
                        onChange={() => setSelectedDevice(device.id)}
                      />
                      <div className="setup-device-info">
                        <strong>{device.id}</strong>
                        <span className="setup-device-name">{device.name}</span>
                        {device.freeVramBytes !== null && (
                          <span className="setup-device-vram">
                            可用显存 {formatBytes(device.freeVramBytes)}
                          </span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="setup-actions">
              <button
                type="button"
                className="setup-primary-button"
                disabled={deviceQuerying}
                onClick={() => void confirmDeviceSelection()}
              >
                确认并启动服务 →
              </button>
              {devices.length > 0 && (
                <button
                  type="button"
                  className="setup-secondary-button"
                  onClick={skipDeviceSelection}
                >
                  使用默认设备
                </button>
              )}
            </div>
          </div>
        )}

        <p className="setup-footnote">
          部署完成后将自动进入写作界面。也可以跳过配置直接进入（模型功能暂不可用）。
          配置保存在用户数据目录，卸载程序不会删除模型文件。
        </p>
      </section>
    </main>
  );
}
