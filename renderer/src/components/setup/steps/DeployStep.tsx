import { Icon } from "../../Icon";
import { StatusNote } from "../setupShared";
import { formatBytes } from "../setupUtils";
import type { DownloadProgress } from "../../../lib/types";

interface DeployStepProps {
  deploying: boolean;
  progress: DownloadProgress | null;
  error: string | null;
  onCancel: () => void;
  onBack: () => void;
  onRetry: () => void;
  onSkipToDevices: () => void;
}

/** 第 3 步：下载与部署进度。 */
export function DeployStep({ deploying, progress, error, onCancel, onBack, onRetry, onSkipToDevices }: DeployStepProps) {
  return (
    <div className="setup-section setup-step-pane">
      <div className="setup-section-head">
        <div>
          <h2>第 3 步：下载与环境部署</h2>
          <p className="setup-section-subtitle">{deploying ? "正在下载引擎与模型权重，请保持网络畅通。" : "部署环境配置。"}</p>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <StatusNote kind="error">{error}</StatusNote>
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
              <span>
                {formatBytes(progress.receivedBytes)} / {formatBytes(progress.totalBytes)}
              </span>
            )}
            {progress.overallFraction !== undefined && <span>{Math.round(progress.overallFraction * 100)}%</span>}
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(progress.overallFraction ?? 0) * 100}%` }} />
          </div>
        </div>
      ) : (
        <div className="setup-deploy-waiting">
          {deploying ? <p>正在初始化环境并连接下载源，请稍候…</p> : <p>准备就绪。若下载中断，可点击重新部署。</p>}
        </div>
      )}

      <div className="setup-actions">
        {deploying ? (
          <button type="button" className="setup-cancel-button" onClick={onCancel}>
            取消部署
          </button>
        ) : (
          <>
            <button type="button" className="setup-secondary-button" onClick={onBack}>
              ← 返回修改配置
            </button>
            <button type="button" className="setup-primary-button" onClick={onRetry}>
              重新部署
            </button>
            <button type="button" className="setup-secondary-button" onClick={onSkipToDevices}>
              直接查询设备 →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
