import type { BackendProgress, BackendStatus } from "../lib/types";

interface BackendStatusBarProps {
  status: BackendStatus;
  progress: BackendProgress | null;
  /** 候选源是否为浏览器演示（演示时不显示「重试 / 日志」）。 */
  isDemo: boolean;
  /** 紧凑模式：编辑器顶栏空间有限，进度条更短、摘要更短。 */
  compact?: boolean;
  onRetry: () => void;
  onOpenLog: () => void;
}

const STATUS_TEXT: Record<BackendStatus, string> = {
  stopped: "未启动",
  loading: "加载中",
  ready: "就绪",
  error: "错误",
};

/** 把秒数变成「约 12 秒」「约 1 分 05 秒」这样的中文。 */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 1) return "不到 1 秒";
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return rest === 0 ? `约 ${minutes} 分钟` : `约 ${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
}

/**
 * 本地模型状态条：状态点 + 文字；加载中额外显示进度条、阶段摘要与预计剩余时间。
 * 首页顶栏和编辑器顶栏共用，保证两处看到的信息一致。
 */
export function BackendStatusBar({ status, progress, isDemo, compact = false, onRetry, onOpenLog }: BackendStatusBarProps) {
  const loading = status === "loading";
  const fraction = Math.max(0, Math.min(1, progress?.fraction ?? 0));
  const eta = progress?.etaSeconds !== undefined ? formatEta(progress.etaSeconds) : "";

  return (
    <div className={`backend-bar ${compact ? "is-compact" : ""} is-${status}`} aria-live="polite">
      <div className="backend-status">
        <span className={`status-dot is-${status}`} />
        <span className="backend-status-text">
          本地模型 {STATUS_TEXT[status]}
          {loading && progress ? ` · ${Math.round(fraction * 100)}%` : ""}
        </span>
        {status === "error" && !isDemo && (
          <span className="backend-actions">
            <button type="button" onClick={onRetry}>重试</button>
            <button type="button" onClick={onOpenLog}>查看日志</button>
          </span>
        )}
      </div>

      {loading && (
        <div className="backend-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <div className="backend-progress-track">
            <div className="backend-progress-fill" style={{ width: `${fraction * 100}%` }} />
          </div>
          <div className="backend-progress-meta">
            <span className="backend-progress-summary">{progress?.summary ?? "正在启动本地模型…"}</span>
            {eta && <span className="backend-progress-eta">剩余{eta}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
