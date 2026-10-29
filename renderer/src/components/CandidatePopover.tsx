import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { REBUILD_HINT_CHARS } from "../../../shared/text";
import { createCaretLayoutCache, measureCaretPoint } from "../lib/editorText";
import type { Candidate } from "../lib/types";
import type { ExpansionRow } from "../lib/useExpander";

interface CandidatePopoverProps {
  /** 要贴着光标定位的 textarea。 */
  editorRef: RefObject<HTMLTextAreaElement | null>;
  /** 编辑器当前全文与光标（用隐藏镜像层测量光标坐标）。 */
  text: string;
  caret: number;
  /** 任何会改变光标像素位置、又不体现在 text/caret 上的值（字号、翻页……）。 */
  relayoutKey: string | number;
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
  /** 长按它隐藏浮窗（空串 = 没绑定）。 */
  hideKeyLabel: string;
  /** 长按它把候选展开成短句（空串 = 没绑定 / 与隐藏键同一个）。 */
  expandKeyLabel: string;
  /** 按它随机取词（空串 = 没绑定）。 */
  sampleKeyLabel: string;
  /** 与 visible 对齐：该行已展开的短句（null = 还是词）。 */
  expansions: Array<ExpansionRow | null>;
  /** 正在逐行展开（标题栏提示）。 */
  expanding: boolean;
  /** 长按展开键可展开（页脚提示；关闭功能或没有绑定键时为 false）。 */
  expandHint: boolean;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  onRetry: () => void;
}

export interface CandidatePopoverHandle {
  /** 编辑区滚动时由编辑器调用：光标像素位置变了但 text/caret 没变。 */
  relayout: () => void;
}

/**
 * 候选浮层。自己负责：贴着光标定位（含边缘翻转）、窗口 resize 时重排、光标测量用的镜像层。
 * 编辑器只提供 textarea ref + 文本 / 光标，不再关心像素坐标。
 */
export const CandidatePopover = forwardRef<CandidatePopoverHandle, CandidatePopoverProps>(function CandidatePopover(
  {
    editorRef,
    text,
    caret,
    relayoutKey,
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
    hideKeyLabel,
    expandKeyLabel,
    sampleKeyLabel,
    expansions,
    expanding,
    expandHint,
    onHover,
    onPick,
    onRetry,
  },
  ref,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const layoutCacheRef = useRef(createCaretLayoutCache());
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const relayoutRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const editor = editorRef.current;
      const mirror = mirrorRef.current;
      const panel = panelRef.current;
      if (!editor || !mirror || !panel) return;

      const point = measureCaretPoint(editor, mirror, text, caret, layoutCacheRef.current);
      if (!point) return;

      const bounds = panel.getBoundingClientRect();
      const edge = 14;
      const footerRoom = 62;
      let left = point.left;
      let top = point.bottom + 8;

      // 右边放不下就翻到左侧
      if (left + bounds.width > window.innerWidth - edge) left = point.left - bounds.width;
      left = Math.max(edge, Math.min(left, window.innerWidth - bounds.width - edge));

      // 下边放不下就翻到光标上方
      if (top + bounds.height > window.innerHeight - footerRoom) top = point.top - bounds.height - 8;
      top = Math.max(edge, Math.min(top, window.innerHeight - bounds.height - edge));

      setPosition((prev) => (prev && Math.abs(prev.left - left) < 1 && Math.abs(prev.top - top) < 1 ? prev : { left, top }));
    };

    updatePosition();
    relayoutRef.current = updatePosition;
    window.addEventListener("resize", updatePosition);
    return () => {
      relayoutRef.current = () => undefined;
      window.removeEventListener("resize", updatePosition);
    };
  }, [editorRef, text, caret, relayoutKey, visible, loading, error, notice, page]);

  useImperativeHandle(ref, () => ({ relayout: () => relayoutRef.current() }), []);

  const rebuilding = loading && prefillChars > REBUILD_HINT_CHARS;
  const hasExpansions = expansions.some((row) => row !== null);

  return (
    <>
      <div
        ref={panelRef}
        className={`candidate-popover ${faded ? "is-faded" : ""} ${hasExpansions ? "has-expansions" : ""}`}
        role="dialog"
        aria-label="下一词候选"
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          visibility: position ? "visible" : "hidden",
        }}
      >
        <div className="candidate-heading">
          <span className="candidate-heading-mark" aria-hidden="true">
            字
          </span>
          <span>接下来可以写</span>
          {loading && (
            <span className={`candidate-pending ${rebuilding ? "is-rebuilding" : ""}`}>
              {rebuilding ? `重建上下文 · 约 ${prefillChars} 字` : "生成中"}
            </span>
          )}
          {!loading && expanding && <span className="candidate-pending">展开中</span>}
          {!loading && !expanding && totalCount > 0 && (
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
            {visible.map((candidate, index) => {
              const row = expansions[index] ?? null;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedIndex === index}
                  className={`candidate-row ${selectedIndex === index ? "is-selected" : ""} ${row ? "is-expanded" : ""}`}
                  key={`${candidate.text}-${page}-${index}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onPick(index)}
                  title={row?.error ? `展开失败：${row.error}` : undefined}
                >
                  <span className="candidate-number">{index < 9 ? index + 1 : "0"}</span>
                  <span className="candidate-word">
                    {candidate.text === "\n\n" ? "↵↵ 段落" : candidate.text === "\n" ? "↵ 换行" : candidate.text}
                    {row && <span className="candidate-expansion">{row.text}</span>}
                    {row && !row.done && <span className="candidate-cursor" aria-hidden="true" />}
                  </span>
                  <span className="candidate-probability">
                    <span className="probability-track">
                      <span
                        style={{
                          width: `${Math.min(100, Math.round(candidate.prob * 100 * 6))}%`,
                        }}
                      />
                    </span>
                    <span className="probability-value">{(candidate.prob * 100).toFixed(1)}%</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="candidate-footer">
          <span>
            <kbd>1</kbd>…<kbd>9</kbd> 插入
          </span>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>PgUp</kbd>
            <kbd>PgDn</kbd> 翻页
          </span>
          {expandHint && expandKeyLabel && (
            <span>
              长按 <kbd>{expandKeyLabel}</kbd> 展开短句
            </span>
          )}
          {sampleKeyLabel && (
            <span>
              <kbd>{sampleKeyLabel}</kbd> 随机
            </span>
          )}
          {hideKeyLabel && (
            <span>
              长按 <kbd>{hideKeyLabel}</kbd> 隐藏
            </span>
          )}
        </div>
      </div>

      {/* 测量光标用的隐藏镜像层 */}
      <div ref={mirrorRef} className="caret-mirror" aria-hidden="true" />
    </>
  );
});
