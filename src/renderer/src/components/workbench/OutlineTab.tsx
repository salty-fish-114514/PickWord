import { useEffect, useRef, useState } from "react";

import { Block, Switch } from "./shared";
import { Icon } from "../Icon";
import { chapterLabel, type Chapter, type ChapterIndex } from "../../lib/chapters";
import { segmentKey, segmentLabel, type OutlineLayout, type ResolvedSegment } from "../../lib/outline";

export interface OutlineTabProps {
  /** 总纲：只给作者看，不注入。 */
  notes: string;
  onNotesChange: (text: string) => void;
  /** 注入大纲段的总开关。 */
  outlineEnabled: boolean;
  onOutlineEnabledChange: (next: boolean) => void;
  /** 全文（卡片标题取起点那一段的前几个字；由 useDeferredValue 包过）。 */
  text: string;
  chapterIndex: ChapterIndex;
  currentChapter: Chapter;
  layout: OutlineLayout;
  /** 光标所在段。 */
  current: ResolvedSegment;
  /** 光标所在段此刻是否真的在注入。 */
  injecting: boolean;
  anchorHardLimit: number;
  /** 要聚焦并高亮的卡片（segmentKey）；处理完回调 onFocusHandled。 */
  focusKey: string | null;
  onFocusHandled: () => void;
  onSegmentText: (resolved: ResolvedSegment, text: string) => void;
  onSegmentInject: (resolved: ResolvedSegment, inject: boolean) => void;
  onAddAtCaret: () => void;
  onMoveToCaret: (resolved: ResolvedSegment) => void;
  /** merge = 把这段的大纲文字并入上一段再删；否则直接丢。 */
  onRemove: (resolved: ResolvedSegment, merge: boolean) => void;
  onLocate: (resolved: ResolvedSegment) => void;
  onJumpToChapter: (chapter: Chapter) => void;
}

const fmt = (n: number) => n.toLocaleString("zh-CN");

/** 「0 – 1,240 字」 / 「2,980 字 – 章末（410 字）」，都相对本章正文起点。 */
function rangeText(resolved: ResolvedSegment, hasMarks: boolean): string {
  const base = resolved.chapter.bodyStart;
  const from = resolved.start - base;
  const to = resolved.end - base;
  if (resolved.ordinal === resolved.count) {
    return `${fmt(from)} 字 – ${hasMarks ? "章末" : "文末"}（${fmt(resolved.end - resolved.start)} 字）`;
  }
  return `${fmt(from)} – ${fmt(to)} 字`;
}

/**
 * 「大纲」：总纲（备忘）+ 当前章的大纲段卡片。
 *   - 每章第一张永远是章首 / 开头段（没建就是空卡，写了字才真正建段），不能删、不能移；
 *   - 其余段显示起点、区间，可定位 / 移到光标处 / 删除 / 并入上一段；
 *   - 单段「注入」开关 + 总开关；光标所在段标「当前」，正在注入的再加一个标记。
 */
export function OutlineTab({
  notes,
  onNotesChange,
  outlineEnabled,
  onOutlineEnabledChange,
  text,
  chapterIndex,
  currentChapter,
  layout,
  current,
  injecting,
  anchorHardLimit,
  focusKey,
  onFocusHandled,
  onSegmentText,
  onSegmentInject,
  onAddAtCaret,
  onMoveToCaret,
  onRemove,
  onLocate,
  onJumpToChapter,
}: OutlineTabProps) {
  const [showAll, setShowAll] = useState(false);
  const areaRefs = useRef(new Map<string, HTMLTextAreaElement>());

  // 外部要求聚焦某张卡（右键新起一段 / EOS 提醒）：聚焦、滚到可见、闪一下（只动 DOM class，不进状态）
  useEffect(() => {
    if (!focusKey) return;
    onFocusHandled();
    const area = areaRefs.current.get(focusKey);
    if (!area) return;
    area.focus();
    area.scrollIntoView({ block: "nearest" });
    area.classList.add("is-highlighted");
    // 不在 cleanup 里撤销：onFocusHandled 会立刻把 focusKey 清空、触发一次重跑，否则高亮刚加上就没了
    window.setTimeout(() => area.classList.remove("is-highlighted"), 1600);
  }, [focusKey, onFocusHandled]);

  const hasMarks = chapterIndex.hasMarks;
  const currentKey = segmentKey(current);
  const currentList = layout.byChapter[currentChapter.index] ?? [];
  const chapterCount = chapterIndex.chapters.length;

  function renderCard(resolved: ResolvedSegment) {
    const key = segmentKey(resolved);
    const isCurrent = key === currentKey;
    const segment = resolved.segment;
    const inject = segment?.inject ?? true;
    return (
      <div className={`chapter-outline segment-card ${isCurrent ? "is-current" : ""}`} key={key}>
        <div className="chapter-outline-head">
          <button className="link-button chapter-outline-title" type="button" title="定位到起点" onClick={() => onLocate(resolved)}>
            <span className="segment-ordinal">{resolved.ordinal}</span>
            {segmentLabel(text, resolved)}
          </button>
          <span className="segment-range">{rangeText(resolved, hasMarks)}</span>
          {isCurrent && <span className="chapter-outline-current">{injecting ? "当前 · 注入中" : "当前"}</span>}
        </div>
        <textarea
          ref={(el) => {
            if (el) areaRefs.current.set(key, el);
            else areaRefs.current.delete(key);
          }}
          className={`context-textarea ${!inject || !outlineEnabled ? "is-muted" : ""}`}
          value={segment?.text ?? ""}
          rows={4}
          aria-label={`大纲段 ${resolved.ordinal}`}
          placeholder={resolved.isHead ? "这一章开头要发生什么……光标在本段时送入模型。" : "这一段要发生什么……光标在本段时送入模型。"}
          onChange={(event) => onSegmentText(resolved, event.target.value)}
        />
        <div className="card-actions segment-actions">
          <span className="segment-inject">
            <Switch checked={inject} label="注入本段" onChange={(next) => onSegmentInject(resolved, next)} />
            <span>注入</span>
          </span>
          {!resolved.isHead && (
            <>
              <button className="link-button" type="button" onClick={() => onMoveToCaret(resolved)} title="把这段的起点改到光标所在段落">
                移到光标处
              </button>
              <button className="link-button" type="button" onClick={() => onRemove(resolved, true)} title="大纲文字接到上一段末尾，再去掉这个边界">
                并入上一段
              </button>
              <button className="link-button is-danger" type="button" onClick={() => onRemove(resolved, false)} title="去掉这个边界，大纲文字丢弃">
                删除
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <Block title="总纲（备忘，不送模型）">
        <textarea
          className="context-textarea is-notes"
          value={notes}
          rows={7}
          aria-label="总纲"
          placeholder="（可选）主线、结局走向、要埋的伏笔……只给自己看，模型不会读到。前后文照应请写进各段大纲。"
          onChange={(event) => onNotesChange(event.target.value)}
        />
      </Block>

      <Block
        title={hasMarks ? `${chapterLabel(currentChapter)} · ${currentList.length} 段` : `大纲段 · ${currentList.length} 段`}
        action={
          <span className="segment-head-actions">
            {hasMarks && chapterCount > 1 && (
              <button className="link-button" type="button" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "只看本章" : `全部 ${chapterCount} 章`}
              </button>
            )}
            <Switch checked={outlineEnabled} label="注入大纲段" onChange={onOutlineEnabledChange} />
          </span>
        }
        last
      >
        <p className="context-hint">
          {outlineEnabled
            ? `光标在哪一段就只注入哪一段，正文从段起点送到光标（超过约 ${fmt(anchorHardLimit)} 字退回滑窗）。想自由发挥时关掉右上角的开关。`
            : "已关闭注入：模型只参考光标前的正文。大纲仍可编辑，打开开关即恢复。"}
        </p>

        {!showAll && currentList.map(renderCard)}
        {showAll &&
          layout.byChapter.map((list, index) => {
            const chapter = chapterIndex.chapters[index];
            const isCurrentChapter = chapter.index === currentChapter.index;
            return (
              <details className="segment-chapter" key={chapter.markStart} open={isCurrentChapter}>
                <summary>
                  <button className="link-button chapter-outline-title" type="button" onClick={() => onJumpToChapter(chapter)} title="跳到本章">
                    {chapterLabel(chapter)}
                  </button>
                  <span className="segment-range">{list.length} 段</span>
                </summary>
                {list.map(renderCard)}
              </details>
            );
          })}

        <button className="quiet-button anchor-button segment-add" type="button" onClick={onAddAtCaret}>
          <Icon name="plus" size={15} />
          <span>在光标处新起一段</span>
        </button>
        <p className="anchor-hint">新段的起点对齐到光标所在段落的段首；终点到下一段起点或章末。右键菜单里也有「从这里新起大纲段」。</p>
      </Block>
    </>
  );
}
