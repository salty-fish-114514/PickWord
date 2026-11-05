/**
 * 大纲段（plan.md §5–6）：一段正文对应一段大纲。
 *
 *   - 起点 = 段首偏移 + 48 字指纹（editorText 的锚点机制），终点 = 下一段起点或章末（无章节则文末）。
 *   - 起点落在章节标记行上 / 文首 = 章首段（「开头」段）；没建段的章在界面上显示一张隐式的空卡（segment = null）。
 *   - 归属由位置决定：插入新章标记后原段在新章前结束；取消分章后原章首段退化为普通段（指纹失效 → 对齐段首）。
 *   - 注入：光标所在段有文字且开着（单段 inject + 总开关）才注入，正文从段起点一刀切（旧锚点语义），超硬上限退回滑窗。
 *   - 总纲（outlineText）只是备忘，永不注入。
 */
import { chapterAt, isChapterMarkLine, type Chapter, type ChapterIndex } from "./chapters";
import { makeFingerprint, mapAnchorThroughEdit, mapOffsetThroughEdit, paragraphStartAt, type EditSpan } from "./editorText";
import type { Anchor, OutlineSegment } from "./types";

export interface ResolvedSegment {
  /** 存储里的段；隐式的空章首段为 null。 */
  segment: OutlineSegment | null;
  chapter: Chapter;
  /** 本章内序号（1 起）与本章段数。 */
  ordinal: number;
  count: number;
  /** 正文起点（章首段 = chapter.bodyStart）与终点。 */
  start: number;
  end: number;
  isHead: boolean;
}

export interface OutlineLayout {
  /** 每章一组（第一张永远是章首段，可能是隐式空段），按章序。 */
  byChapter: ResolvedSegment[][];
  all: ResolvedSegment[];
}

/** 隐式章首段在界面里的键（没有 id）。 */
export function segmentKey(resolved: ResolvedSegment): string {
  return resolved.segment ? resolved.segment.id : `head:${resolved.chapter.markStart}`;
}

export function sortSegments(segments: OutlineSegment[]): OutlineSegment[] {
  return [...segments].sort((a, b) => a.anchor.offset - b.anchor.offset || a.id.localeCompare(b.id));
}

let lastText = "";
let lastIndex: ChapterIndex | null = null;
let lastSegments: OutlineSegment[] | null = null;
let lastLayout: OutlineLayout | null = null;

/** 本章第一个非空段落的段首（标记行后常有空行）；没有正文就是 bodyStart。 */
export function firstParagraphStart(text: string, chapter: Chapter): number {
  let offset = chapter.bodyStart;
  while (offset < chapter.end) {
    const lineEnd = text.indexOf("\n", offset);
    const end = lineEnd === -1 || lineEnd > chapter.end ? chapter.end : lineEnd;
    if (text.slice(offset, end).trim()) return offset;
    if (lineEnd === -1 || lineEnd >= chapter.end) break;
    offset = lineEnd + 1;
  }
  return chapter.bodyStart;
}

/** 把段按章归类、算出每段的正文区间。单槽缓存：一次按键里会被问多次。 */
export function layoutOutline(text: string, index: ChapterIndex, segments: OutlineSegment[]): OutlineLayout {
  if (lastLayout && lastText === text && lastIndex === index && lastSegments === segments) return lastLayout;
  const sorted = sortSegments(segments);
  const byChapter: ResolvedSegment[][] = [];
  const all: ResolvedSegment[] = [];
  let cursor = 0;
  for (const chapter of index.chapters) {
    const isLast = chapter.index === index.chapters.length - 1;
    const own: OutlineSegment[] = [];
    // 末章把越界的（文末 / 过期偏移）也收下，区间会被夹到章末
    while (cursor < sorted.length && (sorted[cursor].anchor.offset < chapter.end || isLast)) {
      if (sorted[cursor].anchor.offset >= chapter.markStart) own.push(sorted[cursor]);
      cursor += 1;
    }
    // 章首段 = 起点不晚于本章第一个非空段落的那一段（锚在标记行、空行或第一段段首都算）
    const headLimit = firstParagraphStart(text, chapter);
    let head: OutlineSegment | null = null;
    const rest: OutlineSegment[] = [];
    for (const segment of own) {
      if (head === null && segment.anchor.offset <= headLimit) head = segment;
      else rest.push(segment);
    }
    const list: ResolvedSegment[] = [{ segment: head, chapter, ordinal: 1, count: 0, start: chapter.bodyStart, end: chapter.end, isHead: true }];
    for (const segment of rest) {
      list.push({
        segment,
        chapter,
        ordinal: list.length + 1,
        count: 0,
        start: Math.min(Math.max(segment.anchor.offset, chapter.bodyStart), chapter.end),
        end: chapter.end,
        isHead: false,
      });
    }
    for (let i = 0; i < list.length; i += 1) {
      list[i].count = list.length;
      if (i + 1 < list.length) list[i].end = list[i + 1].start;
    }
    byChapter.push(list);
    all.push(...list);
  }
  lastText = text;
  lastIndex = index;
  lastSegments = segments;
  lastLayout = { byChapter, all };
  return lastLayout;
}

/** 光标所在段：光标还在标记行上（章首段起点之前）时也算章首段。 */
export function segmentAt(layout: OutlineLayout, index: ChapterIndex, caret: number): ResolvedSegment {
  const chapter = chapterAt(index, caret);
  const list = layout.byChapter[chapter.index];
  let found = list[0];
  for (const item of list) {
    if (item.start <= caret) found = item;
    else break;
  }
  return found;
}

/** offset 所在段落若正是某段的起点（章首位置算章首段，哪怕它还是空卡），返回那一段；否则 null。 */
export function segmentStartingAt(text: string, layout: OutlineLayout, index: ChapterIndex, offset: number): ResolvedSegment | null {
  const start = paragraphStartAt(text, offset);
  const chapter = chapterAt(index, start);
  const isHeadPosition = start <= firstParagraphStart(text, chapter);
  for (const item of layout.byChapter[chapter.index]) {
    if (item.isHead ? isHeadPosition : item.start === start) return item;
  }
  return null;
}

/** 这一段现在会不会注入：有文字、单段开着、总开关开着、光标已越过起点。 */
export function segmentInjects(resolved: ResolvedSegment, caret: number, outlineEnabled: boolean): boolean {
  const segment = resolved.segment;
  return Boolean(outlineEnabled && segment && segment.inject && segment.text.trim() && caret >= resolved.start);
}

/** 卡片标题：章首 / 开头固定文案，其余取区间内第一个非空段落的前几个字。 */
export function segmentLabel(text: string, resolved: ResolvedSegment, max = 12): string {
  if (resolved.isHead) return resolved.chapter.markStart < resolved.chapter.bodyStart ? "章首" : "开头";
  const body = text.slice(resolved.start, resolved.end).trimStart();
  const lineEnd = body.indexOf("\n");
  const head = (lineEnd === -1 ? body : body.slice(0, lineEnd)).trim();
  if (!head) return "（空段）";
  return head.length > max ? `${head.slice(0, max)}…` : head;
}

function anchorFor(text: string, offset: number): Anchor {
  return { offset, fingerprint: makeFingerprint(text, offset) };
}

/** 新段：起点对齐到所在段落的段首；章首位置（本章第一个非空段落及之前）则锚在标记行上。 */
export function createSegment(text: string, index: ChapterIndex, offset: number, initialText = ""): OutlineSegment {
  const start = paragraphStartAt(text, offset);
  const chapter = chapterAt(index, start);
  const anchorOffset = start <= firstParagraphStart(text, chapter) ? chapter.markStart : start;
  return { id: crypto.randomUUID(), anchor: anchorFor(text, anchorOffset), text: initialText, inject: true };
}

export interface SegmentMapResult {
  segments: OutlineSegment[];
  changed: boolean;
  notice: string | null;
}

/** 所有起点穿过一次编辑：文首的段钉在 0，其余走 mapAnchorThroughEdit（偏移平移 → 指纹校验 / 重找 → 对齐段首）。 */
export function mapSegmentsThroughEdit(segments: OutlineSegment[], newText: string, span: EditSpan): SegmentMapResult {
  let changed = false;
  let notice: string | null = null;
  const next = segments.map((segment) => {
    // 文首段钉死在 0；锚在标记行上的章首段只按偏移平移（标记行是结构，改名 / 重编号后指纹必然变，不能拿去全文搜）
    if (segment.anchor.offset === 0 || isChapterMarkLine(segment.anchor.fingerprint)) {
      const offset = segment.anchor.offset === 0 ? 0 : paragraphStartAt(newText, mapOffsetThroughEdit(segment.anchor.offset, span));
      const fingerprint = makeFingerprint(newText, offset);
      if (offset === segment.anchor.offset && fingerprint === segment.anchor.fingerprint) return segment;
      changed = true;
      return { ...segment, anchor: { offset, fingerprint } };
    }
    const result = mapAnchorThroughEdit(segment.anchor, newText, span);
    if (result.notice && !notice) notice = result.notice.replace("锚点", "大纲段起点");
    if (result.anchor.offset === segment.anchor.offset && result.anchor.fingerprint === segment.anchor.fingerprint) return segment;
    changed = true;
    return { ...segment, anchor: result.anchor };
  });
  return { segments: changed ? next : segments, changed, notice };
}

/** 程序化改动（分章 / 重编号 / 改名 / 取消分章）给了精确的偏移映射：直接平移、对齐段首、刷新指纹，不做指纹搜索。 */
export function remapSegments(segments: OutlineSegment[], newText: string, mapOffset: (offset: number) => number): OutlineSegment[] {
  return segments.map((segment) => {
    const offset = segment.anchor.offset === 0 ? 0 : paragraphStartAt(newText, Math.max(0, Math.min(mapOffset(segment.anchor.offset), newText.length)));
    return { ...segment, anchor: { offset, fingerprint: makeFingerprint(newText, offset) } };
  });
}

export interface LegacyOutline {
  outlineText: string;
  chapterOutlines: Record<string, string>;
  anchor: Anchor | null;
}

/**
 * 旧旁车（≤ v4）→ 大纲段：
 *   - chapterOutlines[标题] → 该章的章首段；标题已不存在的并入总纲备忘（不丢字）；
 *   - 无章节文稿的总纲原本靠它注入 → 搬进第一段（起点 = 旧锚点或文首），总纲清空；
 *   - 有章节文稿的总纲原样保留为备忘；旧手动锚点丢弃（章首段已覆盖其用途）。
 */
export function migrateLegacyOutline(text: string, index: ChapterIndex, legacy: LegacyOutline): { segments: OutlineSegment[]; notes: string } {
  const segments: OutlineSegment[] = [];
  const orphaned: string[] = [];
  const used = new Set<number>();
  for (const [title, value] of Object.entries(legacy.chapterOutlines)) {
    if (!value.trim()) continue;
    const chapter = index.chapters.find((c) => c.title === title && !used.has(c.index));
    if (chapter) {
      used.add(chapter.index);
      segments.push({ id: crypto.randomUUID(), anchor: anchorFor(text, chapter.markStart), text: value, inject: true });
    } else {
      orphaned.push(`（原「${title}」的分章大纲）\n${value.trim()}`);
    }
  }
  let notes = legacy.outlineText;
  if (!index.hasMarks && legacy.outlineText.trim()) {
    const offset = legacy.anchor && legacy.anchor.offset <= text.length ? paragraphStartAt(text, legacy.anchor.offset) : 0;
    segments.push({ id: crypto.randomUUID(), anchor: anchorFor(text, offset), text: legacy.outlineText, inject: true });
    notes = "";
  }
  if (orphaned.length > 0) notes = [notes.trim(), ...orphaned].filter(Boolean).join("\n\n");
  return { segments: sortSegments(segments), notes };
}
