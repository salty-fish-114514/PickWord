import { type RefObject } from "react";

import { Icon } from "./Icon";
import { PROMPT_MODE_LABEL, type PromptMode } from "../lib/promptBuilder";
import type { Anchor } from "../lib/types";

export interface ContextState {
  styleEnabled: boolean;
  styleText: string;
  outlineEnabled: boolean;
  outlineText: string;
  anchor: Anchor | null;
}

interface ContextSidebarProps extends ContextState {
  /** 当前实际生效的拼接模式，用来给作者一个「我现在处于什么状态」的反馈。 */
  mode: PromptMode;
  /** 本次是否真的处于锚点模式（大纲开 + 已锚定 + 光标在锚点后）。 */
  anchored: boolean;
  /** 锚点模式的正文硬上限（字符数，按 1 字 = 1 token 保守估算）。 */
  anchorHardLimit: number;
  /** PromptBuilder 返回的非阻塞提示（例如锚点正文过长、未分段）。 */
  notices: string[];
  /** 锚点被移动、需要确认，或被自动清除时的提示（停留较久，不会一闪而过）。 */
  anchorNotice: string | null;
  /** 正文窗口长度，侧边栏底部显示，帮助作者理解上下文规模。 */
  bodyLength: number;
  /** 大纲输入框的 ref：Toast 的「更新大纲」按钮会聚焦它。 */
  outlineRef: RefObject<HTMLTextAreaElement | null>;
  /** 大纲框是否处于高亮状态（被 Toast 唤起时短暂高亮）。 */
  outlineHighlighted: boolean;
  onChange: <K extends keyof ContextState>(key: K, value: ContextState[K]) => void;
  onAnchorHere: () => void;
  onLocateAnchor: () => void;
  onClearAnchor: () => void;
  onClose: () => void;
}

/** 一个小开关组件（原生 button + role="switch"，不依赖任何 UI 库）。 */
function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
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

/** 锚点徽章上显示的段首摘要。 */
function anchorSummary(anchor: Anchor): string {
  const head = anchor.fingerprint.trim();
  if (!head) return "空行";
  return head.length > 12 ? `${head.slice(0, 12)}…` : head;
}

/**
 * 右侧「写作上下文」侧边栏。
 *
 * 设计哲学：做影子，不做教练。
 *   - 默认折叠，第一次打开软件看不到任何配置项；
 *   - 三块内容（风格参考 / 章节大纲 / 大纲锚点）全部可选；
 *   - 关闭开关时文本框只是变灰，内容保留，随时可以再打开；
 *   - 锚点是「建议」而非「强制」：不锚定也照常给候选，只是用滑动窗口兜底。
 */
export function ContextSidebar({
  styleEnabled,
  styleText,
  outlineEnabled,
  outlineText,
  anchor,
  mode,
  anchored,
  anchorHardLimit,
  notices,
  anchorNotice,
  bodyLength,
  outlineRef,
  outlineHighlighted,
  onChange,
  onAnchorHere,
  onLocateAnchor,
  onClearAnchor,
  onClose,
}: ContextSidebarProps) {
  // 开关打开但大纲仍为空时，模型侧等价于「未使用大纲」；不要展示会让人误以为生效的锚点区。
  const outlineActive = outlineEnabled && outlineText.trim().length > 0;

  return (
    <aside className="side-panel context-sidebar" aria-label="写作上下文">
      <div className="panel-heading">
        <div>
          <span className="panel-eyebrow">写作上下文</span>
          <h2>风格与大纲</h2>
        </div>
        <button className="icon-button panel-close" type="button" onClick={onClose} aria-label="收起侧边栏">
          <Icon name="close" />
        </button>
      </div>

      <div className="mode-chip" title="由「风格参考」「章节大纲」两个开关共同决定">
        <Icon name="sparkle" size={14} />
        <span>
          当前：{PROMPT_MODE_LABEL[mode]}
          {anchored ? " · 锚点模式" : ""}
        </span>
      </div>

      {/* 锚点被移动 / 自动清除时的提示：放在最上面，即使大纲被关闭也看得到 */}
      {anchorNotice && <p className="anchor-notice">{anchorNotice}</p>}

      {/* 图例：区分「送入模型的正文」与「你选中的文字」两种背景 */}
      {outlineActive && (
        <div className="range-legend" aria-label="背景色图例">
          <span className="legend-item">
            <i className="legend-swatch is-context" />
            送入模型的正文
          </span>
          <span className="legend-item">
            <i className="legend-swatch is-selection" />
            你选中的文字
          </span>
        </div>
      )}

      {/* ── 风格参考 ───────────────────────────────── */}
      <section className="context-block">
        <div className="context-block-head">
          <span className="context-block-title">使用风格参考</span>
          <Switch checked={styleEnabled} label="使用风格参考" onChange={(next) => onChange("styleEnabled", next)} />
        </div>
        <textarea
          className={`context-textarea ${styleEnabled ? "" : "is-disabled"}`}
          value={styleText}
          disabled={!styleEnabled}
          rows={5}
          aria-label="风格参考文本"
          placeholder="（可选）粘贴几段你想模仿的文字，AI 预测的词会更贴近这种风格……"
          onChange={(event) => onChange("styleText", event.target.value)}
        />
        {styleEnabled && (
          <p className="context-hint">风格文本位于提示词最前面且固定不变，缓存必然命中，可以放心贴长文。</p>
        )}
      </section>

      {/* ── 章节大纲 ───────────────────────────────── */}
      <section className="context-block">
        <div className="context-block-head">
          <span className="context-block-title">使用大纲</span>
          <Switch checked={outlineEnabled} label="使用大纲" onChange={(next) => onChange("outlineEnabled", next)} />
        </div>
        <textarea
          ref={outlineRef}
          className={`context-textarea ${outlineEnabled ? "" : "is-disabled"} ${outlineHighlighted ? "is-highlighted" : ""}`}
          value={outlineText}
          disabled={!outlineEnabled}
          rows={5}
          aria-label="章节大纲文本"
          placeholder="（可选）写下本章要发生的剧情，AI 的候选词会更贴合走向……"
          onChange={(event) => onChange("outlineText", event.target.value)}
        />
      </section>

      {/* ── 大纲锚点（仅在大纲开启时出现，且永远是建议性的） ── */}
      {outlineActive && (
        <section className="context-block anchor-block">
          <div className="context-block-head">
            <span className="context-block-title">大纲锚点</span>
          </div>
          {anchor === null ? (
            <>
              <button className="quiet-button anchor-button" type="button" onClick={onAnchorHere}>
                <Icon name="anchor" size={15} />
                <span>锚定本章起点</span>
              </button>
              <p className="anchor-hint">
                建议把光标放到本章开头再点此（会自动对齐到段首）。不锚定也能用，AI 将参考光标前最近的文字。
              </p>
            </>
          ) : (
            <>
              <div className="anchor-state">
                <span className="anchor-badge" title={`段首：${anchor.fingerprint || "（空行）"}`}>
                  <Icon name="anchor" size={14} />
                  {anchored ? "已锚定" : "锚点已设 · 当前使用滑窗"} · 「{anchorSummary(anchor)}」
                </span>
                <span className="anchor-actions">
                  <button className="link-button" type="button" onClick={onLocateAnchor} title="把光标移到锚点">
                    <Icon name="locate" size={13} />
                    定位
                  </button>
                  <button className="link-button" type="button" onClick={onClearAnchor}>
                    清除
                  </button>
                </span>
              </div>
              <p className="anchor-hint">
                {anchored
                  ? `锚点模式只把锚点之后的正文送给模型，不截断、不滑窗；正文超过约 ${anchorHardLimit} 字的硬上限时会自动退出。编辑区的浅黄色背景就是这段范围。`
                  : "当前光标在锚点之前，暂时改用滑窗，只参考光标前的正文；回到锚点之后会自动恢复锚点模式。"}
                {" "}在锚点段落附近改动会导致锚点移动。
              </p>
            </>
          )}
        </section>
      )}

      {/* ── 底部：上下文规模与柔性提示 ───────────────── */}
      <div className="context-footer">
        <div className="context-meter">
          <span>本次送入正文</span>
          <strong>{bodyLength} 字</strong>
        </div>
        {notices.length > 0 && (
          <ul className="context-notices">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
