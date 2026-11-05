/**
 * 撤销 / 重做栈。
 *
 * 栈里存的是**差分帧**而不是整篇快照：一帧 = 「位置 start 处，removed 被换成了 inserted」+ 前后光标。
 * 全文 1 MB 时每帧仍只有几十字节，深度可以放心给到上千。
 *
 * 帧在编辑**之前**由 record() 登记（此时只能拿到编辑前的正文），编辑完成后才知道「变成了什么」，
 * 所以帧是**延迟定稿**的：record() 把编辑前快照暂存为 pending，下一次 record / undo / redo / breakGroup
 * 再读一次当前正文，用公共前缀 + 公共后缀算出差分（diffEditSpan）。连续同类编辑（打字 / 删除）在
 * GROUP_WINDOW_MS 内共用一个 pending，自然就合并成一步。
 *
 * 栈放在 ref 里（不触发渲染），只把「能否撤销 / 重做」两个布尔量放进 state 供按钮渲染。
 */
import { useRef, useState } from "react";

import { diffEditSpan } from "./editorText";
import type { EditorSnapshot, SelectionRange } from "./types";

const GROUP_WINDOW_MS = 850;
const MAX_DEPTH = 1000;

interface HistoryFrame {
  start: number;
  removed: string;
  inserted: string;
  before: SelectionRange;
  after: SelectionRange;
}

export interface EditHistory {
  /** 记录一帧（在应用编辑**之前**调用）。groupable=true 的同类编辑会合并。 */
  record: (kind: string, groupable?: boolean) => void;
  /** 光标移动等动作：下一次打字另起一组。 */
  breakGroup: () => void;
  /** 弹出上一帧；返回要恢复的快照，没有则 null。 */
  undo: () => EditorSnapshot | null;
  redo: () => EditorSnapshot | null;
  canUndo: boolean;
  canRedo: boolean;
}

/** 把帧应用到 text 上：forward=true 重做（removed→inserted），false 撤销。文本对不上时返回 null。 */
function applyFrame(text: string, frame: HistoryFrame, forward: boolean): string | null {
  const expect = forward ? frame.removed : frame.inserted;
  const replacement = forward ? frame.inserted : frame.removed;
  if (text.slice(frame.start, frame.start + expect.length) !== expect) return null;
  return text.slice(0, frame.start) + replacement + text.slice(frame.start + expect.length);
}

/** @param current 返回编辑器此刻的快照（正文 + 选区），从 ref 里读。 */
export function useEditHistory(current: () => EditorSnapshot): EditHistory {
  const undoStack = useRef<HistoryFrame[]>([]);
  const redoStack = useRef<HistoryFrame[]>([]);
  /** 已登记、尚未定稿的编辑：编辑前的快照 + 分组信息。 */
  const pending = useRef<{ kind: string; time: number; groupable: boolean; before: EditorSnapshot } | null>(null);
  const [availability, setAvailability] = useState({ canUndo: false, canRedo: false });

  const bump = () => {
    const next = {
      canUndo: undoStack.current.length > 0 || pending.current !== null,
      canRedo: redoStack.current.length > 0,
    };
    setAvailability((prev) => (prev.canUndo === next.canUndo && prev.canRedo === next.canRedo ? prev : next));
  };

  /** 把 pending 定稿成差分帧压栈；正文没变就丢弃。 */
  function commitPending() {
    const open = pending.current;
    if (!open) return;
    pending.current = null;
    const now = current();
    if (now.text === open.before.text) return;
    const span = diffEditSpan(open.before.text, now.text);
    undoStack.current.push({
      start: span.changeStart,
      removed: open.before.text.slice(span.changeStart, span.oldEnd),
      inserted: now.text.slice(span.changeStart, span.newEnd),
      before: { start: open.before.start, end: open.before.end },
      after: { start: now.start, end: now.end },
    });
    if (undoStack.current.length > MAX_DEPTH) undoStack.current.shift();
  }

  function record(kind: string, groupable = false) {
    const now = Date.now();
    const open = pending.current;
    const continues =
      groupable && open !== null && open.groupable && open.kind === kind && now - open.time <= GROUP_WINDOW_MS;
    if (continues && open) {
      open.time = now; // 同组继续：保留组开始时的快照，只刷新时间
    } else {
      commitPending();
      pending.current = { kind, time: now, groupable, before: current() };
    }
    redoStack.current = [];
    bump();
  }

  function breakGroup() {
    commitPending();
    bump();
  }

  function undo(): EditorSnapshot | null {
    commitPending();
    const frame = undoStack.current.pop();
    if (!frame) {
      bump();
      return null;
    }
    const now = current();
    const text = applyFrame(now.text, frame, false);
    if (text === null) {
      // 正文与历史对不上（理论上不会发生）：清空历史，宁可不撤销也不写坏正文。
      undoStack.current = [];
      redoStack.current = [];
      bump();
      return null;
    }
    redoStack.current.push(frame);
    bump();
    return { text, start: frame.before.start, end: frame.before.end };
  }

  function redo(): EditorSnapshot | null {
    commitPending();
    const frame = redoStack.current.pop();
    if (!frame) {
      bump();
      return null;
    }
    const now = current();
    const text = applyFrame(now.text, frame, true);
    if (text === null) {
      undoStack.current = [];
      redoStack.current = [];
      bump();
      return null;
    }
    undoStack.current.push(frame);
    bump();
    return { text, start: frame.after.start, end: frame.after.end };
  }

  return { record, breakGroup, undo, redo, canUndo: availability.canUndo, canRedo: availability.canRedo };
}
