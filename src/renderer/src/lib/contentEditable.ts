import type { CaretPoint } from "./editorText";
import type { SelectionRange } from "./types";

function isInside(root: HTMLElement, node: Node): boolean {
  return node === root || root.contains(node);
}

function pagedChildren(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-page-start][data-page-end]"),
  );
}

function localText(root: HTMLElement): string {
  if (root.childNodes.length === 1 && root.firstChild instanceof Text)
    return root.textContent ?? "";
  return root.innerText.replace(/\r\n?/g, "\n");
}

function closestPage(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const page =
    element?.closest<HTMLElement>("[data-page-start][data-page-end]") ?? null;
  return page && root.contains(page) ? page : null;
}

function measureOffset(
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, nodeOffset);
  } catch {
    return 0;
  }
  const probe = document.createElement("div");
  probe.append(range.cloneContents());
  return plainText(probe).length;
}

function pointAt(root: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let last: Text | null = null;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    last = text;
    const length = text.data.length;
    if (remaining <= length) return [text, remaining];
    remaining -= length;
  }
  if (last) return [last, last.data.length];
  return [root, 0];
}

/** contenteditable 的纯文本值；分页 DOM 的纸页边界不属于正文。 */
export function plainText(root: HTMLElement): string {
  const pages = pagedChildren(root);
  if (pages.length > 0) return pages.map(localText).join("");
  return localText(root);
}

/** 将 DOM 选区转换成正文中的字符偏移（分页模式仍使用全局 UTF-16 偏移）。 */
export function readEditableSelection(root: HTMLElement): SelectionRange {
  const selection = document.getSelection();
  const anchorNode = selection?.anchorNode ?? null;
  const focusNode = selection?.focusNode ?? null;
  if (
    !selection?.rangeCount ||
    !anchorNode ||
    !focusNode ||
    !isInside(root, anchorNode) ||
    !isInside(root, focusNode)
  ) {
    return { start: 0, end: 0 };
  }
  const read = (node: Node, offset: number) => {
    const page = closestPage(root, node);
    const local = measureOffset(page ?? root, node, offset);
    return page ? Number(page.dataset.pageStart ?? 0) + local : local;
  };
  const anchor = read(anchorNode, selection.anchorOffset);
  const focus = read(focusNode, selection.focusOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

export function setEditableSelection(
  root: HTMLElement,
  selection: SelectionRange,
): void {
  const pages = pagedChildren(root);
  const clamp = (value: number) =>
    Math.max(0, Math.min(plainText(root).length, value));
  const locate = (value: number): [HTMLElement, number] | null => {
    if (pages.length === 0) return [root, clamp(value)];
    const offset = clamp(value);
    let chosen = pages[pages.length - 1];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const start = Number(page.dataset.pageStart ?? 0);
      const end = Number(page.dataset.pageEnd ?? start);
      if (offset < end || (offset === end && index === pages.length - 1)) {
        chosen = page;
        break;
      }
    }
    const pageStart = Number(chosen.dataset.pageStart ?? 0);
    return [chosen, Math.max(0, offset - pageStart)];
  };

  const start = locate(selection.start);
  const end = locate(selection.end);
  if (!start || !end) return;
  const [startNode, startOffset] = pointAt(start[0], start[1]);
  const [endNode, endOffset] = pointAt(end[0], end[1]);
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const nativeSelection = document.getSelection();
  nativeSelection?.removeAllRanges();
  nativeSelection?.addRange(range);
}

/** 内容光标的视口坐标，供双页模式候选浮窗锚定。 */
export function editableCaretPoint(
  root: HTMLElement,
  caret: number,
): CaretPoint | null {
  const range = document.createRange();
  const selection = document.getSelection();
  const nativeRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (nativeRange && isInside(root, nativeRange.startContainer)) {
    range.setStart(nativeRange.startContainer, nativeRange.startOffset);
  } else {
    const pages = pagedChildren(root);
    if (pages.length > 0) {
      const offset = Math.max(0, Math.min(plainText(root).length, caret));
      const page =
        pages.find((candidate, index) => {
          const end = Number(candidate.dataset.pageEnd ?? 0);
          return offset < end || (offset === end && index === pages.length - 1);
        }) ?? pages[pages.length - 1];
      const [node, local] = pointAt(
        page,
        offset - Number(page.dataset.pageStart ?? 0),
      );
      range.setStart(node, local);
    } else {
      const [node, local] = pointAt(root, caret);
      range.setStart(node, local);
    }
  }
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height)
    return { left: rect.left, top: rect.top, bottom: rect.bottom };
  const bounds = root.getBoundingClientRect();
  const lineHeight =
    Number.parseFloat(window.getComputedStyle(root).lineHeight) || 28;
  return {
    left: bounds.left,
    top: bounds.top,
    bottom: bounds.top + lineHeight,
  };
}
