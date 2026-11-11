import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import type { SearchMatchStarts } from "../lib/editorText";

const RESULTS_PER_PAGE = 75;

interface SearchPanelProps {
  /**
   * 每按一次 Ctrl+F，App 就把这个数字 +1。
   * SearchPanel 监听它的变化，重新聚焦并全选查找框 —— 这样面板已经打开时再按 Ctrl+F 也有反应。
   */
  focusSignal: number;
  query: string;
  content: string;
  replacement: string;
  matches: SearchMatchStarts;
  searching?: boolean;
  activeIndex: number;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onSelectMatch: (start: number, index: number) => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

/**
 * 左侧查找/替换面板：完整统计所有命中，但每页只创建 75 条结果 DOM。
 * 点击某条结果会把编辑器光标移到对应位置并选中它。
 */
export function SearchPanel({
  focusSignal,
  query,
  content,
  replacement,
  matches,
  searching = false,
  activeIndex,
  onQueryChange,
  onReplacementChange,
  onSelectMatch,
  onReplaceCurrent,
  onReplaceAll,
  onClose,
}: SearchPanelProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [manualPage, setManualPage] = useState<{
    query: string;
    index: number;
    activeIndex: number;
  } | null>(null);
  const pageCount = Math.ceil(matches.length / RESULTS_PER_PAGE);
  const activePage =
    activeIndex >= 0 ? Math.floor(activeIndex / RESULTS_PER_PAGE) : 0;
  const requestedPage =
    manualPage?.query === query && manualPage.activeIndex === activeIndex
      ? manualPage.index
      : activePage;
  const safePageIndex =
    pageCount === 0 ? 0 : Math.min(requestedPage, pageCount - 1);
  const firstIndex = safePageIndex * RESULTS_PER_PAGE;
  const pageEnd = Math.min(matches.length, firstIndex + RESULTS_PER_PAGE);

  // useEffect(fn, [x]) 表示「挂载后执行一次，之后每当 x 变化再执行」。
  // 这里让查找框获得焦点并全选：从编辑器带入的选中文字会被选中，直接打字就能替换掉它。
  useEffect(() => {
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusSignal]);

  return (
    <aside className="side-panel search-panel" aria-label="查找与替换">
      <div className="panel-heading">
        <div>
          <span className="panel-eyebrow">文稿工具</span>
          <h2>查找与替换</h2>
        </div>
        <button
          className="icon-button panel-close"
          type="button"
          onClick={onClose}
          aria-label="关闭查找面板"
        >
          <Icon name="close" />
        </button>
      </div>

      <label className="field-label" htmlFor="search-query">
        查找
      </label>
      <input
        ref={searchInputRef}
        id="search-query"
        className="text-field"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="输入要查找的文字"
      />

      <label className="field-label replace-label" htmlFor="replace-query">
        替换为
      </label>
      <input
        id="replace-query"
        className="text-field"
        type="text"
        value={replacement}
        onChange={(event) => onReplacementChange(event.target.value)}
        placeholder="输入替换文字"
      />

      <div className="replace-actions">
        <button
          className="quiet-button"
          type="button"
          onClick={onReplaceCurrent}
          disabled={matches.length === 0}
        >
          替换当前
        </button>
        <button
          className="quiet-button quiet-button-accent"
          type="button"
          onClick={onReplaceAll}
          disabled={matches.length === 0}
        >
          全部替换
        </button>
      </div>

      <div className="results-heading">
        <span>匹配结果</span>
        <div className="search-result-pagination">
          <span className="results-count">
            {query
              ? searching
                ? "查找中…"
                : matches.length === 0
                  ? "0 处"
                  : `${matches.length} 处 · ${firstIndex + 1}–${pageEnd}`
              : "输入关键词"}
          </span>
          {matches.length > 0 && (
            <div className="search-page-controls" aria-label="结果页码">
              <button
                className="search-page-button"
                type="button"
                aria-label="上一页搜索结果"
                title="上一页"
                disabled={safePageIndex === 0}
                onClick={() =>
                  setManualPage({
                    query,
                    activeIndex,
                    index: Math.max(0, safePageIndex - 1),
                  })
                }
              >
                ‹
              </button>
              <span className="search-page-number">
                {safePageIndex + 1}/{pageCount}
              </span>
              <button
                className="search-page-button"
                type="button"
                aria-label="下一页搜索结果"
                title="下一页"
                disabled={safePageIndex >= pageCount - 1}
                onClick={() =>
                  setManualPage({
                    query,
                    activeIndex,
                    index: Math.min(pageCount - 1, safePageIndex + 1),
                  })
                }
              >
                ›
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="search-results" role="list" aria-label="查找结果">
        {Array.from(
          matches.subarray(firstIndex, pageEnd),
          (start, visibleIndex) => {
            const index = firstIndex + visibleIndex;
            const end = start + query.length;
            const before = content.slice(Math.max(0, start - 22), start);
            const after = content.slice(
              end,
              Math.min(content.length, end + 30),
            );
            return (
              <button
                className={`search-result ${activeIndex === index ? "is-active" : ""}`}
                type="button"
                role="listitem"
                key={`${start}-${end}`}
                onClick={() => onSelectMatch(start, index)}
              >
                <span className="result-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="result-context">
                  {before && <span>{before}</span>}
                  <mark>{query}</mark>
                  {after && <span>{after}</span>}
                </span>
              </button>
            );
          },
        )}
        {matches.length === 0 && (
          <div className="empty-results">
            {searching
              ? "正在搜索全文…"
              : query
                ? "没有找到相符文字"
                : "查找结果会列在这里"}
          </div>
        )}
      </div>
    </aside>
  );
}
