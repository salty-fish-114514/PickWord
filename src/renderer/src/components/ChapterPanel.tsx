import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Icon } from "./Icon";
import { chapterLabel, editableChapterTitle, isNumberingSequential, volumeLabel, type Chapter, type ChapterIndex, type VolumeSummary } from "../lib/chapters";

interface ChapterPanelProps {
  index: ChapterIndex;
  /** 光标所在章节的下标。 */
  currentIndex: number;
  /** 长篇时为书名；短篇为 null。 */
  bookTitle: string | null;
  /** 长篇时全书各卷（按卷序号升序）；短篇不传。 */
  volumes?: VolumeSummary[];
  currentVolumeId?: string;
  /** 卷操作都会先保存当前卷再切换，由编辑器负责。 */
  onSwitchVolume?: (id: string) => void;
  onCreateVolume?: () => void;
  busy?: boolean;
  onJump: (chapter: Chapter) => void;
  /** 在光标处 / 文末插入一个新章节标记。 */
  onInsertAtCaret: () => void;
  onInsertAtEnd: () => void;
  onRenameChapter: (chapter: Chapter, title: string) => void;
  /** 删掉标记行，把该章并入上一章。 */
  onRemoveChapter: (chapter: Chapter) => void;
  /** 「第N章」序号按文中顺序重排（手动输入的标记乱序时才显示）。 */
  onRenumber: () => void;
  onClose: () => void;
}

/**
 * 左侧结构面板：长篇时上半是卷（切换 / 新建），下半是本卷章节；短篇只有章节。
 * 章节由正文里的 `--标题--` 标记决定；这里的改名 / 取消分章都只是改写那一行。
 */
export function ChapterPanel({
  index,
  currentIndex,
  bookTitle,
  volumes,
  currentVolumeId,
  onSwitchVolume,
  onCreateVolume,
  busy = false,
  onJump,
  onInsertAtCaret,
  onInsertAtEnd,
  onRenameChapter,
  onRemoveChapter,
  onRenumber,
  onClose,
}: ChapterPanelProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [editing, setEditing] = useState<{ markStart: number; value: string; selectStart: number } | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  // 只在开始编辑的那一刻设选区（编号章只选标题部分，「第N章 」留着），之后每次按键不再碰选区
  // （否则输入法每上屏一个词就把旧字覆盖掉）
  const editingMark = editing?.markStart ?? null;
  const editingSelectStart = editing?.selectStart ?? 0;
  useEffect(() => {
    if (editingMark === null) return;
    const input = editInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(editingSelectStart, input.value.length);
  }, [editingMark, editingSelectStart]);

  function startRename(chapter: Chapter) {
    const initial = editableChapterTitle(chapter.title);
    setEditing({ markStart: chapter.markStart, value: initial.value, selectStart: initial.selectStart });
  }

  function commitRename(chapter: Chapter) {
    if (!editing) return;
    const title = editing.value.trim();
    setEditing(null);
    if (title && title !== chapter.title) onRenameChapter(chapter, title);
  }

  function chapterMenuItems(chapter: Chapter): ContextMenuItem[] {
    const hasMark = chapter.markStart < chapter.bodyStart;
    return [
      { id: "jump", label: "跳到本章", icon: "chapters", onSelect: () => onJump(chapter) },
      { id: "rename", label: "重命名", icon: "edit", disabled: !hasMark, onSelect: () => startRename(chapter) },
      {
        id: "remove",
        label: "取消分章（并入上一章）",
        icon: "trash",
        disabled: !hasMark,
        danger: true,
        separator: true,
        onSelect: () => onRemoveChapter(chapter),
      },
    ];
  }

  function openChapterMenu(event: MouseEvent, chapter: Chapter) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items: chapterMenuItems(chapter) });
  }

  function onEditKeyDown(event: KeyboardEvent<HTMLInputElement>, chapter: Chapter) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") commitRename(chapter);
    if (event.key === "Escape") setEditing(null);
  }

  const needsRenumber = index.hasMarks && !isNumberingSequential(index);

  const isBook = Boolean(bookTitle && volumes);

  return (
    <aside className="side-panel chapter-panel" aria-label="目录">
      <div className="panel-heading">
        <div>
          <span className="panel-eyebrow">{isBook ? "长篇" : "文稿结构"}</span>
          <h2>{isBook ? bookTitle : "章节"}</h2>
        </div>
        <button className="icon-button panel-close" type="button" onClick={onClose} aria-label="关闭目录面板">
          <Icon name="close" />
        </button>
      </div>

      {isBook && volumes && (
        <section className="structure-section" aria-label="卷">
          <div className="structure-caption">
            <span>卷</span>
            <span className="structure-caption-meta">{volumes.length} 卷</span>
          </div>
          <div className="chapter-list volume-list" role="list">
            {volumes.map((volume) => {
              const active = volume.id === currentVolumeId;
              return (
                <button
                  className={`chapter-item volume-item ${active ? "is-active" : ""}`}
                  type="button"
                  role="listitem"
                  key={volume.id}
                  disabled={busy}
                  aria-current={active ? "true" : undefined}
                  title={active ? "当前卷" : "保存当前卷并切换"}
                  onClick={() => {
                    if (!active) onSwitchVolume?.(volume.id);
                  }}
                >
                  <Icon name="book" size={14} />
                  <span className="chapter-item-title">{volumeLabel(volume)}</span>
                  <span className="chapter-item-count">{volume.characterCount.toLocaleString("zh-CN")} 字</span>
                </button>
              );
            })}
          </div>
          <div className="chapter-actions">
            <button className="quiet-button" type="button" disabled={busy} onClick={onCreateVolume}>
              <Icon name="plus" size={15} />
              <span>{busy ? "正在保存…" : "新建一卷"}</span>
            </button>
          </div>
        </section>
      )}

      <section className="structure-section" aria-label="章节">
        {isBook && (
          <div className="structure-caption">
            <span>本卷章节</span>
            {index.hasMarks && <span className="structure-caption-meta">{index.chapters.filter((c) => c.title).length} 章</span>}
          </div>
        )}

        {index.hasMarks ? (
          <>
            <div className="chapter-list" role="list" aria-label="章节列表">
              {index.chapters.map((chapter) => {
                const isEditing = editing?.markStart === chapter.markStart && chapter.markStart < chapter.bodyStart;
                return (
                  <div
                    className={`chapter-item chapter-row ${chapter.index === currentIndex ? "is-active" : ""}`}
                    role="listitem"
                    key={`${chapter.markStart}-${chapter.title}`}
                    onContextMenu={(event) => openChapterMenu(event, chapter)}
                  >
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        className="chapter-item-input"
                        aria-label="章节标题"
                        value={editing.value}
                        maxLength={80}
                        onChange={(event) => setEditing((prev) => prev && { ...prev, value: event.target.value })}
                        onKeyDown={(event) => onEditKeyDown(event, chapter)}
                        onBlur={() => commitRename(chapter)}
                      />
                    ) : (
                      <button
                        className="chapter-item-main"
                        type="button"
                        title={chapterLabel(chapter)}
                        onClick={() => onJump(chapter)}
                        onDoubleClick={() => chapter.markStart < chapter.bodyStart && startRename(chapter)}
                      >
                        <span className="chapter-item-title">{chapterLabel(chapter)}</span>
                        <span className="chapter-item-count">{chapter.chars.toLocaleString("zh-CN")} 字</span>
                      </button>
                    )}
                    <button
                      className="icon-button chapter-item-more"
                      type="button"
                      aria-label={`${chapterLabel(chapter)} 的操作`}
                      aria-haspopup="menu"
                      onClick={(event) => openChapterMenu(event, chapter)}
                    >
                      <Icon name="more" size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="chapter-actions">
              <button className="quiet-button" type="button" onClick={onInsertAtCaret}>
                <Icon name="plus" size={15} />
                <span>在光标处分章</span>
              </button>
              <button className="quiet-button quiet-button-accent" type="button" onClick={onInsertAtEnd}>
                <Icon name="plus" size={15} />
                <span>文末新建一章</span>
              </button>
              {needsRenumber && (
                <button className="quiet-button" type="button" title="把「第N章」按文中顺序重排为 1、2、3…" onClick={onRenumber}>
                  <Icon name="chapters" size={15} />
                  <span>重新编号</span>
                </button>
              )}
            </div>
            <p className="context-hint">
              章节由正文里独占一行的 <code>--标题--</code> 标记决定。双击或右键章节可改名、取消分章；从中间插入时后面的「第N章」会自动顺延。
            </p>
          </>
        ) : (
          <div className="chapter-empty">
            <p>{isBook ? "这一卷还没有分章。" : "这篇文稿还没有分章。"}</p>
            <p className="chapter-empty-hint">
              在正文里写一行 <code>--第1章 标题--</code>，或点下面的按钮，就能按章节浏览、写分章大纲。{isBook ? "" : "短篇不分章也完全可以。"}
            </p>
            <button className="quiet-button quiet-button-accent" type="button" onClick={onInsertAtCaret}>
              <Icon name="plus" size={15} />
              <span>在光标处插入第一章</span>
            </button>
          </div>
        )}
      </section>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
