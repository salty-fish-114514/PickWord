/**
 * 更新弹窗：检查结果 / 下载进度 / 下载失败（降级提示）三态共用一个 modal。
 * 结构照抄 BackendSettingsPanel（.modal-backdrop + .backend-dialog），不新增视觉语言。
 */
import { Icon } from "./Icon";
import type { UpdaterState } from "../lib/useUpdater";

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `（${mb.toFixed(0)} MB）` : `（${(bytes / 1024).toFixed(0)} KB）`;
}

export function UpdateDialog({ updater }: { updater: UpdaterState }) {
  const { phase, info, progress, error, dialogOpen, startDownload, install, ignoreVersion, closeDialog } = updater;
  if (!dialogOpen || !info) return null;

  const downloading = phase === "downloading";
  const fraction = downloading && progress && progress.total > 0 ? Math.min(1, progress.received / progress.total) : null;

  let title = "检查更新";
  if (phase === "ready" || phase === "installing") title = "安装更新";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
      <section className="backend-dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <header className="backend-dialog-head">
          <div>
            <h2 id="update-dialog-title">{title}</h2>
            <p className="setup-section-subtitle">当前版本 v{info.currentVersion}</p>
          </div>
          <button type="button" className="icon-button" onClick={closeDialog} aria-label="关闭" disabled={downloading || phase === "installing"}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="update-dialog-body">
          {!info.supported ? (
            <p className="setup-hint">{info.reason ?? "当前环境不支持检查更新。"}</p>
          ) : error ? (
            <>
              {info.available && <p>发现新版本 v{info.latest}，但没能把它下载下来。</p>}
              <p className="setup-hint">{error}</p>
              <p className="setup-hint">更新包和所有镜像源都试过了。可以稍后在这里重试；不影响继续使用。</p>
            </>
          ) : phase === "checking" ? (
            <p className="setup-hint">正在检查更新…</p>
          ) : downloading ? (
            <>
              <p>正在下载 v{info.latest} 安装包{formatSize(info.assetSize)}…</p>
              <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction ? Math.round(fraction * 100) : undefined}>
                {fraction !== null ? <div className="update-progress-fill" style={{ width: `${Math.round(fraction * 100)}%` }} /> : <div className="update-progress-fill update-progress-indeterminate" />}
              </div>
              <p className="setup-hint">
                {fraction !== null ? `${Math.round(fraction * 100)}%` : "连接中…"}
                {progress && progress.source > 0 ? " · 已切换到镜像源" : ""}
              </p>
            </>
          ) : phase === "ready" || phase === "installing" ? (
            <>
              <p>v{info.latest} 已下载完成。现在安装会关闭紫霞写作并静默覆盖安装。</p>
              <p className="setup-hint">你的设置、文库和已部署的模型都不会被改动。</p>
            </>
          ) : info.available ? (
            <>
              <p>发现新版本 v{info.latest}{formatSize(info.assetSize)}。</p>
              {info.notes && <pre className="update-notes">{info.notes}</pre>}
            </>
          ) : (
            <p className="setup-hint">已是最新版本{info.reason ? `（${info.reason}）` : ""}。</p>
          )}
        </div>

        <footer className="setup-actions backend-dialog-actions">
          {phase === "ready" ? (
            <button type="button" className="setup-primary-button" onClick={install}>
              现在安装
            </button>
          ) : phase === "installing" ? (
            <button type="button" className="setup-primary-button" disabled>
              正在启动安装…
            </button>
          ) : info.supported && info.available && !downloading ? (
            <>
              <button type="button" className="setup-primary-button" disabled={phase === "checking"} onClick={startDownload}>
                现在更新
              </button>
              <button type="button" className="setup-secondary-button" onClick={ignoreVersion}>
                忽略此版本
              </button>
            </>
          ) : null}
          <button type="button" className="setup-secondary-button" onClick={closeDialog} disabled={downloading || phase === "installing"}>
            {info.available && !error && phase === "idle" ? "稍后" : "关闭"}
          </button>
        </footer>
      </section>
    </div>
  );
}
