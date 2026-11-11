/** 安装向导与「模型与推理」面板共用的小组件（纯函数见 setupUtils.ts）。 */
import type { ReactNode } from "react";

import { Icon } from "../Icon";

/** 状态 / 错误提示条。 */
export function StatusNote({ kind = "info", title, children }: { kind?: "info" | "error"; title?: string; children: ReactNode }) {
  return (
    <div className={`setup-status ${kind === "error" ? "is-error" : ""}`} role={kind === "error" ? "alert" : undefined}>
      {title && <strong>{title}</strong>}
      <span>{children}</span>
    </div>
  );
}

/** 路径输入框 + 「浏览…」按钮（系统对话框由主进程弹出；浏览器演示里按钮无效，可手动粘贴）。 */
export function PathField({
  label,
  value,
  placeholder,
  disabled,
  browseLabel = "浏览…",
  browseIcon = "open",
  hint,
  onChange,
  onBrowse,
}: {
  label?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  browseLabel?: string;
  browseIcon?: "open" | "folder";
  hint?: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="setup-form-row">
      {label && <label>{label}</label>}
      <div className="setup-input-browse-group">
        <input type="text" disabled={disabled} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="setup-browse-button" disabled={disabled} onClick={onBrowse} title={browseLabel}>
          <Icon name={browseIcon} size={15} />
          {browseLabel}
        </button>
      </div>
      {hint && <p className="setup-hint">{hint}</p>}
    </div>
  );
}

/** 向导页面外框：全屏背景 + 卡片 + 品牌行（右侧可放「跳过」链接）。 */
export function SetupFrame({ title, description, onSkip, children }: { title: string; description?: string; onSkip?: () => void; children: ReactNode }) {
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
        <h1 id="setup-title">{title}</h1>
        {description && <p className="setup-description">{description}</p>}
        {children}
      </section>
    </main>
  );
}
