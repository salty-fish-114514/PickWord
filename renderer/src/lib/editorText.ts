/**
 * 与「文本 + DOM 测量」相关的纯工具函数。
 * 这些函数都不依赖 React，便于单独理解与测试。
 *
 * 本文件的重点是「锚点如何在编辑中保持稳定」（第二节）。
 */

import type { Anchor } from "./types";

/* ════════════════════════════════════════════════════════════════
   一、光标像素测量 / 查找
   ════════════════════════════════════════════════════════════════ */

export interface CaretPoint {
  left: number;
  top: number;
  bottom: number;
}

export interface SearchMatch {
  start: number;
  end: number;
  text: string;
  before: string;
  after: string;
}

/**
 * 段落高度缓存：镜像测量时不再把「光标之前的全部文字」整段排版，只排光标所在的那一段，
 * 前面各段的高度从缓存里累加。缓存键是段落文本本身（同样的文字在同样的宽度 / 字体下高度一定相同），
 * 宽度或字体变了（layoutKey 不同）整体作废。全文 1 MB 时，一次测量的成本从「排版 1 MB」降到「排版一段」。
 */
export interface CaretLayoutCache {
  layoutKey: string;
  heights: Map<string, number>;
  /** 上一次 split 的结果：正文字符串没变就不重新 split。 */
  text: string;
  paragraphs: string[];
}

export function createCaretLayoutCache(): CaretLayoutCache {
  return { layoutKey: "", heights: new Map(), text: "", paragraphs: [""] };
}

function copyTypography(mirror: HTMLDivElement, textarea: HTMLTextAreaElement, computed: CSSStyleDeclaration) {
  const bounds = textarea.getBoundingClientRect();
  mirror.style.position = "fixed";
  // 减去滚动量：镜像是「完整铺开」的，textarea 则是带滚动的视口。
  mirror.style.left = `${bounds.left - textarea.scrollLeft}px`;
  mirror.style.top = `${bounds.top - textarea.scrollTop}px`;
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = "auto";
  mirror.style.boxSizing = "border-box";
  mirror.style.padding = computed.padding;
  mirror.style.border = "0";
  mirror.style.fontFamily = computed.fontFamily;
  mirror.style.fontSize = computed.fontSize;
  mirror.style.fontWeight = computed.fontWeight;
  mirror.style.fontStyle = computed.fontStyle;
  mirror.style.fontVariant = computed.fontVariant;
  mirror.style.lineHeight = computed.lineHeight;
  mirror.style.letterSpacing = computed.letterSpacing;
  mirror.style.wordSpacing = computed.wordSpacing;
  mirror.style.textIndent = computed.textIndent;
  mirror.style.textAlign = computed.textAlign;
  mirror.style.textTransform = computed.textTransform;
  mirror.style.direction = computed.direction;
  mirror.style.tabSize = computed.tabSize;
  mirror.style.wordBreak = computed.wordBreak;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.overflow = "hidden";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.zIndex = "-1";
}

/** 段落块：空段落放一个零宽空格，保证仍占一行。 */
function paragraphBlock(text: string): HTMLDivElement {
  const block = document.createElement("div");
  block.textContent = text.length === 0 ? "\u200b" : text;
  return block;
}

/**
 * 镜像 div 测量光标像素坐标。
 *
 * 浏览器没有给 <textarea> 提供「第 N 个字符在屏幕哪个位置」的 API，
 * 所以经典做法是：造一个隐藏的 <div>，把 textarea 的字体、行高、宽度、padding、
 * 换行规则全部复制过去，再把文本塞进去，最后在光标处放一个零宽的 <span> 标记。
 * 这个 span 的 getBoundingClientRect()（浏览器 API：返回元素相对视口的矩形）就是光标所在的位置。
 *
 * 这里的版本只排版光标所在段落，其余段落的高度走 cache（见 CaretLayoutCache）。
 */
export function measureCaretPoint(
  textarea: HTMLTextAreaElement,
  mirror: HTMLDivElement,
  text: string,
  caret: number,
  cache: CaretLayoutCache,
): CaretPoint | null {
  const computed = window.getComputedStyle(textarea);
  copyTypography(mirror, textarea, computed);

  const layoutKey = [
    textarea.clientWidth,
    computed.padding,
    computed.font,
    computed.lineHeight,
    computed.letterSpacing,
    computed.wordSpacing,
    computed.tabSize,
    computed.textIndent,
  ].join("|");
  if (cache.layoutKey !== layoutKey) {
    cache.layoutKey = layoutKey;
    cache.heights.clear();
  }
  if (cache.text !== text) {
    cache.text = text;
    cache.paragraphs = text.split("\n");
  }
  const paragraphs = cache.paragraphs;

  // 光标在第几段、段内偏移多少
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  let paragraphIndex = 0;
  let paragraphStart = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const end = paragraphStart + paragraphs[i].length;
    if (safeCaret <= end) {
      paragraphIndex = i;
      break;
    }
    paragraphStart = end + 1;
  }

  // ① 先把前面还没量过高度的段落一次性排版（一次 layout，多次读 offsetHeight）
  const missing: Array<{ text: string; block: HTMLDivElement }> = [];
  for (let i = 0; i < paragraphIndex; i += 1) {
    const paragraph = paragraphs[i];
    if (!cache.heights.has(paragraph)) missing.push({ text: paragraph, block: paragraphBlock(paragraph) });
  }
  if (missing.length > 0) {
    mirror.replaceChildren(...missing.map((item) => item.block));
    for (const item of missing) cache.heights.set(item.text, item.block.offsetHeight);
  }
  if (cache.heights.size > paragraphs.length * 2 + 256) {
    // 编辑过的旧段落文本会残留在缓存里；超过两倍就重建，只留当前正文里的段落
    const live = new Map<string, number>();
    for (const paragraph of paragraphs) {
      const height = cache.heights.get(paragraph);
      if (height !== undefined) live.set(paragraph, height);
    }
    cache.heights = live;
  }

  let above = 0;
  for (let i = 0; i < paragraphIndex; i += 1) above += cache.heights.get(paragraphs[i]) ?? 0;

  // ② 用一个固定高度的占位块代替前面的段落，再排版光标所在段落
  const spacer = document.createElement("div");
  spacer.style.height = `${above}px`;
  const current = document.createElement("div");
  current.append(document.createTextNode(paragraphs[paragraphIndex].slice(0, safeCaret - paragraphStart)));

  const marker = document.createElement("span");
  marker.textContent = "\u200b"; // 零宽空格，占位但不可见
  marker.style.display = "inline-block";
  marker.style.width = "1px";
  marker.style.height = computed.lineHeight;
  marker.style.verticalAlign = "top";
  current.append(marker);
  mirror.replaceChildren(spacer, current);

  const markerBounds = marker.getBoundingClientRect();
  if (markerBounds.width === 0 && markerBounds.height === 0) return null;
  return { left: markerBounds.left, top: markerBounds.top, bottom: markerBounds.bottom };
}

/** 普通字符串查找，返回每处命中的位置和一小段上下文（供左侧结果列表展示）。 */
export function findMatches(content: string, query: string): SearchMatch[] {
  if (!query) return [];

  const matches: SearchMatch[] = [];
  let cursor = 0;

  while (cursor <= content.length - query.length) {
    const start = content.indexOf(query, cursor);
    if (start === -1) break;
    const end = start + query.length;
    matches.push({
      start,
      end,
      text: content.slice(start, end),
      before: content.slice(Math.max(0, start - 22), start),
      after: content.slice(end, Math.min(content.length, end + 30)),
    });
    cursor = end;
  }
  return matches;
}

/** 两个字符串的公共前缀长度。用于估算「这次请求有多少 prompt 能命中 KV cache」。 */
export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

/* ════════════════════════════════════════════════════════════════
   二、编辑差分与锚点稳定
   ════════════════════════════════════════════════════════════════

   textarea 的一次 onChange 几乎总是「一段连续区间被另一段替换」
   （打字 = 插入 0→1 字；删除 = 1→0；选中后粘贴 = m→n）。
   所以用「公共前缀 + 公共后缀」就能精确还原这次改动的区间，
   不需要通用的 diff 算法。 */

/** 一次编辑的区间描述：旧文本 [changeStart, oldEnd) 被替换成新文本 [changeStart, newEnd)。 */
export interface EditSpan {
  changeStart: number;
  oldEnd: number;
  newEnd: number;
  /** 新长度 - 旧长度 */
  delta: number;
}

export function diffEditSpan(oldText: string, newText: string): EditSpan {
  const oldLen = oldText.length;
  const newLen = newText.length;
  const minLen = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix += 1;
  }

  return { changeStart: prefix, oldEnd: oldLen - suffix, newEnd: newLen - suffix, delta: newLen - oldLen };
}

/**
 * 把一个字符偏移「穿过」一次编辑映射到新文本里：
 *   - 偏移在改动之前 → 不变；
 *   - 偏移在改动之后 → 平移 delta；
 *   - 偏移落在被改写的区间里 → 收缩到改动起点（原位置已不存在）。
 */
export function mapOffsetThroughEdit(offset: number, span: EditSpan): number {
  if (offset <= span.changeStart) return offset;
  if (offset >= span.oldEnd) return offset + span.delta;
  return span.changeStart;
}

/** 返回包含 offset 的那个段落的段首偏移（紧跟在上一个 \n 之后，或 0）。 */
export function paragraphStartAt(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === 0) return 0;
  return text.lastIndexOf("\n", clamped - 1) + 1;
}

/** 手动锚定时使用：把光标位置对齐到所在段落的段首。 */
export function snapAnchorOffset(text: string, offset: number): number {
  return paragraphStartAt(text, offset);
}

/** 指纹长度：取段首最多 48 个字。太短容易误匹配，太长则段首一改就失效。 */
export const FINGERPRINT_LEN = 48;
/** 指纹至少要这么长才拿去全文搜索，否则「的」「了」之类会到处命中。 */
const MIN_FINGERPRINT_LEN = 6;

/** 取某个段首开始、不跨越换行的最多 FINGERPRINT_LEN 个字作为指纹。 */
export function makeFingerprint(text: string, offset: number): string {
  const lineEnd = text.indexOf("\n", offset);
  const stop = lineEnd === -1 ? text.length : lineEnd;
  return text.slice(offset, Math.min(stop, offset + FINGERPRINT_LEN));
}

/** 在 text 里找 needle 的所有出现位置中，离 near 最近的那个；找不到返回 -1。 */
function nearestOccurrence(text: string, needle: string, near: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    const distance = Math.abs(index - near);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    // 已经越过 near 且距离开始变大，后面只会更远
    if (index > near && distance > bestDistance) break;
    from = index + 1;
  }
  return best;
}

export interface AnchorMapResult {
  anchor: Anchor;
  /** 偏移是否发生了变化（纯平移也算）。 */
  moved: boolean;
  /** 需要让作者知道的事；null 表示这次映射干净利落，不值得打扰。 */
  notice: string | null;
}

/**
 * 让锚点「穿过」一次编辑，尽可能仍指向原来那一段的段首。
 *
 * 三步走：
 *   1. 按偏移平移（mapOffsetThroughEdit），指纹若在新位置原样存在 → 直接命中；
 *   2. 指纹对不上 → 在全文里找离旧位置最近的一处指纹（段落被整体移动 / 跨锚点替换都能救回来）；
 *   3. 还找不到（段首被改写或段落被删）→ 对齐到最近段首，刷新指纹，视情况提醒作者。
 *
 * 为什么不直接只用偏移：偏移在「跨锚点大段替换」「撤销重做」时会落到错误的位置；
 * 为什么不只用指纹：作者修改段首第一句时指纹必然失效，此时要靠偏移兜底。
 * 两者结合，覆盖日常写作里几乎所有情况。
 */
export function mapAnchorThroughEdit(anchor: Anchor, newText: string, span: EditSpan): AnchorMapResult {
  const mapped = Math.min(mapOffsetThroughEdit(anchor.offset, span), newText.length);
  const fingerprint = anchor.fingerprint;
  const fingerprintUsable = fingerprint.length >= MIN_FINGERPRINT_LEN;

  // ① 指纹仍在映射后的位置
  if (fingerprintUsable && newText.startsWith(fingerprint, mapped)) {
    const start = paragraphStartAt(newText, mapped);
    if (start === mapped) {
      return { anchor: { offset: mapped, fingerprint }, moved: mapped !== anchor.offset, notice: null };
    }
    // 锚点前的换行被删掉了：这段并入了上一段
    return {
      anchor: { offset: start, fingerprint: makeFingerprint(newText, start) },
      moved: true,
      notice: "锚点所在段落已并入上一段，锚点移到了合并后的段首。",
    };
  }

  // ② 全文搜索指纹（段落被整体挪动）
  if (fingerprintUsable) {
    const found = nearestOccurrence(newText, fingerprint, mapped);
    if (found !== -1) {
      const start = paragraphStartAt(newText, found);
      const moved = start !== anchor.offset;
      return {
        anchor: { offset: start, fingerprint: makeFingerprint(newText, start) },
        moved,
        notice: moved ? "锚点已跟随原段落移动到新位置。" : null,
      };
    }
  }

  // ③ 兜底：对齐最近段首并刷新指纹
  const start = paragraphStartAt(newText, mapped);
  const moved = start !== anchor.offset;
  // 「被改写区间」真的覆盖了锚点那个字符（纯插入时 oldEnd == changeStart，不算）
  const touched = span.oldEnd > span.changeStart && anchor.offset >= span.changeStart && anchor.offset < span.oldEnd;

  let notice: string | null = null;
  if (moved) notice = "锚点所在段落被改动，已对齐到最近的段首，请到侧边栏确认。";
  else if (touched) notice = "锚点段落的开头被改动，锚点仍在原位置，请确认它依然是本章起点。";

  return { anchor: { offset: start, fingerprint: makeFingerprint(newText, start) }, moved, notice };
}
