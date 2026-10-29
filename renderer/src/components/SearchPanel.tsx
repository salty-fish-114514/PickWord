import { useEffect, useRef } from "react";

import { Icon } from "./Icon";
import type { SearchMatch } from "../lib/editorText";

interface SearchPanelProps {
  /**
   * 每按一次 Ctrl+F，App 就把这个数字 +1。
   * SearchPanel 监听它的变化，重新聚焦并全选查找框 —— 这样面板已经打开时再按 Ctrl+F 也有反应。
   */
  focusSignal: number;
  query: string;
  replacement: string;
  matches: SearchMatch[];
  activeIndex: number;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onSelectMatch: (match: SearchMatch, index: number) => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

/**
 * 左侧查找/替换面板：把所有命中逐条列出来（类似 Word 的导航窗格）。
 * 点击某条结果会把编辑器光标移到对应位置并选中它。
 */
export function SearchPanel({
  focusSignal,
  query,
  replacement,
  matches,
  activeIndex,
  onQueryChange,
  onReplacementChange,
  onSelectMatch,
  onReplaceCurrent,
  onReplaceAll,
  onClose,
}: SearchPanelProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

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
        <button className="icon-button panel-close" type="button" onClick={onClose} aria-label="关闭查找面板">
          <Icon name="close" />
        </button>
      </div>

      <label className="field-label" htmlFor="search-query">查找</label>
      <input
        ref={searchInputRef}
        id="search-query"
        className="text-field"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="输入要查找的文字"
      />

      <label className="field-label replace-label" htmlFor="replace-query">替换为</label>
      <input
        id="replace-query"
        className="text-field"
        type="text"
        value={replacement}
        onChange={(event) => onReplacementChange(event.target.value)}
        placeholder="输入替换文字"
      />

      <div className="replace-actions">
        <button className="quiet-button" type="button" onClick={onReplaceCurrent} disabled={matches.length === 0}>
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
        <span className="results-count">{query ? `${matches.length} 处` : "输入关键词"}</span>
      </div>

      <div className="search-results" role="list" aria-label="查找结果">
        {matches.map((match, index) => (
          <button
            className={`search-result ${activeIndex === index ? "is-active" : ""}`}
            type="button"
            role="listitem"
            key={`${match.start}-${match.end}`}
            onClick={() => onSelectMatch(match, index)}
          >
            <span className="result-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="result-context">
              {match.before && <span>{match.before}</span>}
              <mark>{match.text}</mark>
              {match.after && <span>{match.after}</span>}
            </span>
          </button>
        ))}
        {matches.length === 0 && (
          <div className="empty-results">{query ? "没有找到相符文字" : "查找结果会列在这里"}</div>
        )}
      </div>
    </aside>
  );
}
