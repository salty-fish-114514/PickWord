import { type RefObject } from "react";

import type { Candidate } from "../lib/types";

/** 预计要重新 prefill 的字符数超过它，就把「生成中」换成「重建上下文」。 */
const REBUILD_HINT_CHARS = 400;

interface CandidatePopoverProps {
  panelRef: RefObject<HTMLDivElement | null>;
  position: { left: number; top: number } | null;
  visible: Candidate[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  /** 空候选时的中性提示（不是故障）。和 error 互斥使用。 */
  notice: string | null;
  page: number;
  pageCount: number;
  totalCount: number;
  faded: boolean;
  prefillChars: number;
  peekKeyLabel: string;
  sampleKeyLabel: string;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  onRetry: () => void;
}

export function CandidatePopover({
  panelRef,
  position,
  visible,
  selectedIndex,
  loading,
  error,
  notice,
  page,
  pageCount,
  totalCount,
  faded,
  prefillChars,
  peekKeyLabel,
  sampleKeyLabel,
  onHover,
  onPick,
  onRetry,
}: CandidatePopoverProps) {
  const rebuilding = loading && prefillChars > REBUILD_HINT_CHARS;

  return (
    <div
      ref={panelRef}
      className={`candidate-popover ${faded ? "is-faded" : ""}`}
      role="dialog"
      aria-label="下一词候选"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <div className="candidate-heading">
        <span className="candidate-heading-mark" aria-hidden="true">字</span>
        <span>接下来可以写</span>
        {loading && (
          <span className={`candidate-pending ${rebuilding ? "is-rebuilding" : ""}`}>
            {rebuilding ? `重建上下文 · 约 ${prefillChars} 字` : "生成中"}
          </span>
        )}
        {!loading && totalCount > 0 && (
          <span className="candidate-paging">
            {page + 1}/{pageCount} 页 · 共 {totalCount} 词
          </span>
        )}
      </div>

      {loading && visible.length === 0 ? (
        <div className="candidate-message">
          <span className="loading-line" />
          {rebuilding ? "上下文变化较大，正在重新计算" : "正在整理词语"}
        </div>
      ) : error ? (
        <div className="candidate-message candidate-error-message">
          <span>{error}</span>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onRetry}>
            重试
          </button>
        </div>
      ) : visible.length === 0 && notice ? (
        <div className="candidate-message candidate-notice-message">
          <span>{notice}</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="candidate-message">暂时没有候选词</div>
      ) : (
        <div className={`candidate-list ${loading ? "is-stale" : ""}`} role="listbox" aria-label="词语候选">
          {visible.map((candidate, index) => (
            <button
              type="button"
              role="option"
              aria-selected={selectedIndex === index}
              className={`candidate-row ${selectedIndex === index ? "is-selected" : ""}`}
              key={`${candidate.text}-${page}-${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(index)}
            >
              <span className="candidate-number">{index < 9 ? index + 1 : "0"}</span>
              <span className="candidate-word">{candidate.text === "\n" ? "↵ 换行" : candidate.text}</span>
              <span className="candidate-probability">
                <span className="probability-track">
                  <span style={{ width: `${Math.min(100, Math.round(candidate.prob * 100 * 6))}%` }} />
                </span>
                <span className="probability-value">{(candidate.prob * 100).toFixed(1)}%</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="candidate-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        {sampleKeyLabel && <span><kbd>{sampleKeyLabel}</kbd> 随机</span>}
        <span><kbd>PgUp</kbd><kbd>PgDn</kbd> 翻页</span>
        <span><kbd>{peekKeyLabel}</kbd> 长按穿透</span>
      </div>
    </div>
  );
}