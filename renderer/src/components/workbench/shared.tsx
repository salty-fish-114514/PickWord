import { useRef } from "react";
import type { ReactNode } from "react";

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

/**
 * 别名：一行一个、纵向铺开（不再挤在单行里横向滚动）。
 * 失焦 / 回车时规范化：去空白、去重、丢掉空行；粘贴「甲、乙」这种带分隔符的内容会自动拆成多行。
 */
export function AliasField({ aliases, onChange }: { aliases: string[]; onChange: (next: string[]) => void }) {
  /**
   * 收尾（失焦 / 回车 / 删行时）：去首尾空白、去重。
   * ★ 一整列都是空行时原样保留：parseAliases 会滤掉空值，那样「加了两行空别名、删掉一行」
   *   会连另一行一起吃掉。只要已经填了内容，空行就该被收干净（空别名不进数据）。
   */
  const tidy = (list: string[]) => {
    const trimmed = list.map((value) => value.trim());
    return trimmed.some(Boolean) ? parseAliases(trimmed.join("、")) : trimmed;
  };
  const commit = (list: string[]) => {
    const next = tidy(list);
    if (next.length !== aliases.length || next.some((value, index) => value !== aliases[index])) onChange(next);
  };
  return (
    <div className="card-field">
      <span className="card-field-label">别名</span>
      <div className="alias-list">
        {aliases.map((alias, index) => (
          <div className="alias-row" key={index}>
            <input
              className="text-field card-field-input"
              type="text"
              value={alias}
              placeholder={index === 0 ? "小名、称谓、绰号" : "再填一个"}
              aria-label={`别名 ${index + 1}`}
              onChange={(event) => onChange(aliases.map((item, i) => (i === index ? event.target.value : item)))}
              onBlur={() => commit(aliases)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commit(aliases);
              }}
            />
            <button
              className="link-button is-danger alias-remove"
              type="button"
              aria-label={`删除别名「${alias || index + 1}」`}
              title="删除这个别名"
              onClick={() => commit(aliases.filter((_, i) => i !== index))}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
        <button className="link-button alias-add" type="button" onClick={() => onChange([...aliases, ""])}>
          <Icon name="plus" size={13} />
          添加别名
        </button>
      </div>
    </div>
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

/** 卡片拖动排序的回调（可选）：给了才显示抓手、才允许拖。 */
export interface CardDrag {
  /**
   * 排序拖动：**整张卡**都是拖拽源（边框、标题行、展开后的空白处都行），
   * 只有在输入框 / 文本域里选字不触发拖动。没有额外的拖动按钮。
   */
  /** 这张卡正在被拖。 */
  dragging: boolean;
  /** 拖着别的卡悬停在这张上（画落点线）。 */
  over: boolean;
  onStart: () => void;
  onEnter: () => void;
  onDrop: () => void;
  onEnd: () => void;
}

/** 可折叠卡片的外框：（抓手）+ 标题行 + 右侧徽标 + 展开内容。 */
export function CardShell({
  open,
  onToggle,
  title,
  meta,
  drag,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  meta?: ReactNode;
  drag?: CardDrag;
  children: ReactNode;
}) {
  /** 本次按下是否落在输入框里：是则这次手势不拖卡（选字优先）。 */
  const dragFromEditableRef = useRef(false);

  return (
    <article
      className={`material-card ${open ? "is-open" : ""} ${drag?.dragging ? "is-dragging" : ""} ${drag?.over ? "is-drop-target" : ""}`}
      draggable={Boolean(drag)}
      onMouseDown={
        drag
          ? (event) => {
              const target = event.target as HTMLElement;
              dragFromEditableRef.current = Boolean(target.closest("input, textarea, select, [contenteditable]"));
            }
          : undefined
      }
      onDragStart={
        drag
          ? (event) => {
              if (dragFromEditableRef.current) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", title);
              drag.onStart();
            }
          : undefined
      }
      onDragEnd={drag ? drag.onEnd : undefined}
      onDragOver={
        drag
          ? (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              drag.onEnter();
            }
          : undefined
      }
      onDrop={
        drag
          ? (event) => {
              event.preventDefault();
              drag.onDrop();
            }
          : undefined
      }
    >
      <div className="material-card-head">
        <button className="material-card-toggle" type="button" onClick={onToggle} aria-expanded={open}>
          <Icon name="chevron" size={13} />
          <span className="material-card-name">{title || "（未命名）"}</span>
          {meta && <span className="material-card-meta">{meta}</span>}
        </button>
      </div>
      {open && <div className="material-card-body">{children}</div>}
    </article>
  );
}
