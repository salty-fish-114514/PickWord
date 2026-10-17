import { useState, type ReactNode } from "react";

import { Icon } from "../Icon";
import { parseAliases } from "../../lib/materials";

/** 一个小开关组件（原生 button + role="switch"，不依赖任何 UI 库）。 */
export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      className={`switch switch-small ${checked ? "is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/** 面板里的分区：标题 + 右侧动作（开关 / 按钮）。 */
export function Block({ title, action, children, last }: { title: ReactNode; action?: ReactNode; children: ReactNode; last?: boolean }) {
  return (
    <section className={`context-block ${last ? "anchor-block" : ""}`}>
      <div className="context-block-head">
        <span className="context-block-title">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 自动增高的小文本域（卡片字段用）。 */
export function FieldArea({
  label,
  value,
  placeholder,
  onChange,
  onRemove,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onRemove?: () => void;
}) {
  return (
    <label className="card-field">
      <span className="card-field-label">
        {label}
        {onRemove && (
          <button className="link-button" type="button" onClick={onRemove} aria-label={`删除字段 ${label}`}>
            删除
          </button>
        )}
      </span>
      <textarea
        className="context-textarea card-field-area"
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** 别名输入：逗号 / 顿号分隔，失焦时规范化。 */
export function AliasField({ aliases, onChange }: { aliases: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? aliases.join("、");
  return (
    <label className="card-field card-field-inline">
      <span className="card-field-label">别名</span>
      <input
        className="text-field card-field-input"
        type="text"
        value={shown}
        placeholder="小名、称谓、绰号，用顿号分隔"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null) onChange(parseAliases(draft));
          setDraft(null);
        }}
      />
    </label>
  );
}

/** 列表上方的搜索 + 新建一行。 */
export function ListToolbar({
  query,
  onQuery,
  placeholder,
  onCreate,
  createLabel,
  extra,
}: {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  onCreate: () => void;
  createLabel: string;
  extra?: ReactNode;
}) {
  return (
    <div className="list-toolbar">
      <label className="list-search">
        <Icon name="search" size={14} />
        <input type="search" value={query} placeholder={placeholder} onChange={(event) => onQuery(event.target.value)} />
      </label>
      {extra}
      <button className="quiet-button quiet-button-accent list-create" type="button" onClick={onCreate}>
        <Icon name="plus" size={14} />
        <span>{createLabel}</span>
      </button>
    </div>
  );
}

/** 可折叠卡片的外框：标题行 + 右侧徽标 + 展开内容。 */
export function CardShell({
  open,
  onToggle,
  title,
  meta,
  injected,
  onInject,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  meta?: ReactNode;
  injected: boolean;
  onInject: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <article className={`material-card ${open ? "is-open" : ""} ${injected ? "" : "is-muted"}`}>
      <div className="material-card-head">
        <button className="material-card-toggle" type="button" onClick={onToggle} aria-expanded={open}>
          <Icon name="chevron" size={13} />
          <span className="material-card-name">{title || "（未命名）"}</span>
          {meta && <span className="material-card-meta">{meta}</span>}
        </button>
        <Switch checked={injected} label="允许注入提示词" onChange={onInject} />
      </div>
      {open && <div className="material-card-body">{children}</div>}
    </article>
  );
}
