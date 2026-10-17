import { StatusNote } from "../setupShared";
import { BACKEND_KIND_LABEL, formatBytes } from "../setupUtils";
import type { HardwareReport } from "../../../lib/types";

interface HardwareStepProps {
  hardware: HardwareReport | null;
  detecting: boolean;
  error: string | null;
  onDetect: () => void;
  onNext: () => void;
  onSkip?: () => void;
}

/** 第 1 步：硬件检测与引擎推荐。 */
export function HardwareStep({ hardware, detecting, error, onDetect, onNext, onSkip }: HardwareStepProps) {
  const rec = hardware?.recommendation ?? null;
  return (
    <div className="setup-section setup-step-pane">
      <div className="setup-section-head">
        <div>
          <h2>第 1 步：硬件检测</h2>
          <p className="setup-section-subtitle">识别 CPU、内存大小及可用 GPU 显卡，给出最佳运行建议。</p>
        </div>
        <button className="setup-secondary-button" type="button" disabled={detecting} onClick={onDetect}>
          {detecting ? "正在检测…" : hardware ? "重新检测" : "开始检测"}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <StatusNote kind="error">{error}</StatusNote>
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
              <span>
                建议线程数：{rec.recommendedThreads ?? "请手动设置"}。{rec.threadsNote}
              </span>
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
            <button type="button" className="setup-primary-button" onClick={onNext}>
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
  );
}
