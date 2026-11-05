import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { editableChapterTitle } from "../lib/chapters";

interface ChapterTitleFieldProps {
  /** 正文标记行里的标题。 */
  value: string;
  /** 失焦或回车时提交；空标题不提交（标记行至少要有一个字）。 */
  onCommit: (title: string) => void;
  className?: string;
  ariaLabel: string;
  placeholder?: string;
}

/**
 * 章节标题的草稿输入框：编辑期间不回写正文，失焦 / 回车才提交。
 * 直接把 onChange 接到正文上会有两个问题：标记行会 trim，作者打的空格立刻被吃掉；
 * 删空的一瞬间标记行失效、输入框随之消失。
 */
export function ChapterTitleField({ value, onCommit, className, ariaLabel, placeholder }: ChapterTitleFieldProps) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectStartRef = useRef(0);
  const justFocusedRef = useRef(false);
  // 没在编辑时直接显示正文里的标题（撤销、面板改名、光标换章都会改 value）；聚焦后才用草稿
  const shown = focused ? draft : value;

  // 聚焦那一刻：编号章只选「第N章 」之后的标题部分（鼠标点进来时也一样），之后不再碰选区
  useLayoutEffect(() => {
    if (!focused) return;
    const input = inputRef.current;
    if (!input) return;
    input.setSelectionRange(selectStartRef.current, input.value.length);
  }, [focused]);

  function commit() {
    const title = draft.trim();
    if (title && title !== value) onCommit(title);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setDraft(value);
      event.currentTarget.blur();
    }
  }

  return (
    <input
      className={className}
      type="text"
      aria-label={ariaLabel}
      value={shown}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      ref={inputRef}
      onFocus={() => {
        const initial = editableChapterTitle(value);
        selectStartRef.current = initial.selectStart;
        justFocusedRef.current = true;
        window.setTimeout(() => {
          justFocusedRef.current = false;
        }, 300);
        setDraft(initial.value);
        setFocused(true);
      }}
      onMouseUp={(event) => {
        // 鼠标点进来的那一下：mouseup 会把光标放到点击处，覆盖掉刚设好的选区，只拦这一次
        if (justFocusedRef.current) {
          justFocusedRef.current = false;
          event.preventDefault();
        }
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={onKeyDown}
    />
  );
}
