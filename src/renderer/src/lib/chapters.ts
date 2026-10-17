/**
 * 章节标记：正文里独占一行的 `--标题--`。
 *
 * 为什么用正文内标记而不是旁车元数据：txt 必须保持可移植，且任何「按偏移量记录章节起点」的方案
 * 都要在每次编辑后同步偏移；标记行跟着文字一起移动，天然稳定。
 * 标记只在编辑器内有意义：送入模型前整行删掉（见 stripChapterMarks）——模型只该看到正文，章标题与序号
 * 会干扰它对局部语境的判断；字数统计也不计入标记行。
 */

import { countChars } from "../../../shared/text";

/** 标记行：行首 `--`、至少一个字符的标题、`--`、可选的行尾空白。 */
const MARK_LINE_RE = /^--(.+?)--[ \t]*$/gm;

export interface Chapter {
  /** 在 chapters 数组里的下标。 */
  index: number;
  /** 标题（不含 `--`）。标记行之前的散文算作一个无标题的「开头」章节，title 为空串。 */
  title: string;
  /** 标记行首的偏移（开头章节为 0）。 */
  markStart: number;
  /** 正文起点：标记行换行符之后（开头章节为 0）。 */
  bodyStart: number;
  /** 本章结束（下一章 markStart，或文末）。 */
  end: number;
  /** 本章正文字数（不含标记行）。 */
  chars: number;
}

export interface ChapterIndex {
  chapters: Chapter[];
  /** 是否至少有一个标记行（决定编辑器要不要显示章节相关 UI）。 */
  hasMarks: boolean;
  /** 全文字数（不含标记行）。 */
  totalChars: number;
}

let lastText = "";
let lastIndex: ChapterIndex | null = null;

/**
 * 解析全文的章节结构。按字符串同一性做单槽缓存：一次按键里 syncWindow / 预览 / 状态栏会多次询问同一份正文。
 */
export function parseChapters(text: string): ChapterIndex {
  if (lastIndex && lastText === text) return lastIndex;

  const chapters: Chapter[] = [];
  MARK_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARK_LINE_RE.exec(text)) !== null) {
    const markStart = match.index;
    const lineEnd = markStart + match[0].length;
    const bodyStart = text.charCodeAt(lineEnd) === 10 ? lineEnd + 1 : lineEnd;
    chapters.push({ index: chapters.length, title: match[1].trim(), markStart, bodyStart, end: text.length, chars: 0 });
  }

  const hasMarks = chapters.length > 0;
  if (hasMarks && (chapters[0].markStart > 0 ? text.slice(0, chapters[0].markStart).trim().length > 0 : false)) {
    chapters.unshift({ index: 0, title: "", markStart: 0, bodyStart: 0, end: chapters[0].markStart, chars: 0 });
  }
  if (!hasMarks) {
    chapters.push({ index: 0, title: "", markStart: 0, bodyStart: 0, end: text.length, chars: 0 });
  }

  let totalChars = 0;
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i];
    chapter.index = i;
    chapter.end = i + 1 < chapters.length ? chapters[i + 1].markStart : text.length;
    chapter.chars = countChars(text.slice(chapter.bodyStart, chapter.end));
    totalChars += chapter.chars;
  }

  lastText = text;
  lastIndex = { chapters, hasMarks, totalChars };
  return lastIndex;
}

/** 光标所在章节（偏移落在标记行上也算该章）。 */
export function chapterAt(index: ChapterIndex, offset: number): Chapter {
  const { chapters } = index;
  let low = 0;
  let high = chapters.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (chapters[mid].markStart <= offset) low = mid;
    else high = mid - 1;
  }
  return chapters[low];
}

/** 面板 / 标题区显示用：开头章节没有标题，显示为「开头」。 */
export function chapterLabel(chapter: Chapter): string {
  return chapter.title || "开头";
}

export function makeChapterMark(title: string): string {
  return `--${title.trim()}--`;
}

export function isChapterMarkLine(line: string): boolean {
  return /^--(.+?)--[ \t]*$/.test(line);
}

/**
 * 送入模型前把标记行连同换行整行删掉：模型只看到正文，前后两段仍以一个换行相接。
 * 正文末尾若停在一个写了一半的标记行上（作者正在改标题），那半行也不送。
 */
export function stripChapterMarks(text: string): string {
  return text.replace(/^--(.+?)--[ \t]*(\n|$)/gm, "").replace(/(^|\n)--[^\n]*$/, "$1");
}

/* ───────── 标题编辑框 ───────── */

export interface EditableTitle {
  /** 编辑框里的初始文字（无标题的「第N章」会补上一个空格）。 */
  value: string;
  /** 选区起点：编号章只选「第N章 」之后的标题部分，其余全选。 */
  selectStart: number;
}

/**
 * 双击 / 点击改名时编辑框的初始状态：
 *   「第3章 夜航船」→ 第3章 [夜航船]   「第4章」→ 第4章 |（补空格、光标在末尾）   「楔子」→ [楔子]
 * 「第4章夜航船」这种没有空格的旧写法不动，只把选区放到标题部分。
 * 作者若手动改掉「第N章」部分，提交后该章自然退出编号（parseNumberedTitle 不再认它）。
 */
export function editableChapterTitle(title: string): EditableTitle {
  const match = NUMBER_PREFIX_RE.exec(title);
  if (!match) return { value: title, selectStart: 0 };
  const rest = title.slice(match[0].length);
  if (rest.length === 0) return { value: `${title} `, selectStart: title.length + 1 };
  return { value: title, selectStart: match[0].length + (rest.startsWith(" ") ? 1 : 0) };
}

/* ───────── 章节编号 ───────── */

/** 标题开头的「第N章」：N 可以是阿拉伯数字或中文数字；其余标题（楔子 / 尾声…）不参与编号。 */
const NUMBER_PREFIX_RE = /^第([0-9０-９]+|[零〇一二两三四五六七八九十百千]+)章/;
const CN_DIGITS = "零一二三四五六七八九";

function toChineseNumeral(n: number): string {
  if (n <= 0 || n >= 10000) return String(n);
  const units = ["", "十", "百", "千"];
  const digits = String(n).split("").map(Number);
  let out = "";
  let pendingZero = false;
  digits.forEach((digit, i) => {
    const unit = units[digits.length - 1 - i];
    if (digit === 0) {
      pendingZero = out.length > 0;
      return;
    }
    if (pendingZero) out += "零";
    pendingZero = false;
    out += CN_DIGITS[digit] + unit;
  });
  // 一十一 → 十一
  return out.replace(/^一十/, "十");
}

function parseChineseNumeral(raw: string): number {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of raw) {
    if (ch === "零" || ch === "〇") continue;
    const d = CN_DIGITS.indexOf(ch === "两" ? "二" : ch);
    if (d >= 0) {
      digit = d;
      continue;
    }
    const unit = ch === "十" ? 10 : ch === "百" ? 100 : ch === "千" ? 1000 : 0;
    section += (digit || 1) * unit;
    digit = 0;
  }
  total = section + digit;
  return total;
}

interface NumberedTitle {
  value: number;
  style: "arabic" | "chinese";
  /** 「第N章」之后的部分（含前导空格）。 */
  rest: string;
}

function parseNumberedTitle(title: string): NumberedTitle | null {
  const match = NUMBER_PREFIX_RE.exec(title);
  if (!match) return null;
  const raw = match[1];
  const arabic = /^[0-9０-９]+$/.test(raw);
  const value = arabic ? Number(raw.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10))) : parseChineseNumeral(raw);
  return { value, style: arabic ? "arabic" : "chinese", rest: title.slice(match[0].length) };
}

export function formatChapterNumber(n: number, style: "arabic" | "chinese" = "arabic"): string {
  return `第${style === "chinese" ? toChineseNumeral(n) : n}章`;
}

/**
 * 在 offset 处插入新章时的默认标题：序号 = 它前面已编号的章数 + 1，数字风格跟随前一章；
 * 插入后调用 renumberChapters 把后面的章节顺延。
 */
export function defaultChapterTitleAt(index: ChapterIndex, offset: number): string {
  let count = 0;
  let style: "arabic" | "chinese" = "arabic";
  for (const chapter of index.chapters) {
    if (chapter.markStart > offset || (chapter.markStart === offset && chapter.markStart > 0)) break;
    const parsed = parseNumberedTitle(chapter.title);
    if (parsed) {
      count += 1;
      style = parsed.style;
    }
  }
  return formatChapterNumber(count + 1, style);
}

/** 已编号章节是否正好按文中顺序为 1、2、3…（面板据此决定要不要显示「重新编号」）。 */
export function isNumberingSequential(index: ChapterIndex): boolean {
  let expected = 1;
  for (const chapter of index.chapters) {
    const parsed = parseNumberedTitle(chapter.title);
    if (!parsed) continue;
    if (parsed.value !== expected) return false;
    expected += 1;
  }
  return true;
}

export interface RenumberResult {
  text: string;
  /** 把旧文本里的偏移映射到新文本（用于平移光标）。 */
  map: (offset: number) => number;
  /** 标题变化清单（分章大纲的键要跟着改）。 */
  renames: Array<{ from: string; to: string }>;
}

/** 把所有「第N章…」按文中顺序重编为 1、2、3…，保留各自的数字风格与标题其余部分。 */
export function renumberChapters(text: string): RenumberResult {
  const index = parseChapters(text);
  const edits: Array<{ start: number; end: number; next: string }> = [];
  const renames: RenumberResult["renames"] = [];
  let expected = 1;
  for (const chapter of index.chapters) {
    const parsed = parseNumberedTitle(chapter.title);
    if (!parsed) continue;
    if (parsed.value !== expected) {
      const nextTitle = formatChapterNumber(expected, parsed.style) + parsed.rest;
      const lineEnd = text.indexOf("\n", chapter.markStart);
      edits.push({ start: chapter.markStart, end: lineEnd === -1 ? text.length : lineEnd, next: makeChapterMark(nextTitle) });
      renames.push({ from: chapter.title, to: nextTitle });
    }
    expected += 1;
  }
  if (edits.length === 0) return { text, map: (offset) => offset, renames };

  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + edit.next;
    cursor = edit.end;
  }
  out += text.slice(cursor);

  const map = (offset: number) => {
    let shifted = offset;
    for (const edit of edits) {
      if (edit.end <= offset) shifted += edit.next.length - (edit.end - edit.start);
      else if (edit.start < offset) return shifted - (offset - edit.start) + edit.next.length; // 落在标记行内：挪到行尾
      else break;
    }
    return shifted;
  };
  return { text: out, map, renames };
}

/**
 * 在 offset 所在段落之前（或文末）插入一行新标记，返回新文本与光标应落的位置（标记行之后）。
 * 保证标记前后各有空行分隔，不吞掉已有文字。
 */
export function insertChapterMark(text: string, offset: number, title: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  // 光标停在一段末尾（后面是换行或文末）时，作者的意思是「这段之后开新章」；否则对齐到本段段首
  const atLineEnd = at > 0 && text.charCodeAt(at - 1) !== 10 && (at === text.length || text.charCodeAt(at) === 10);
  let lineStart = at;
  if (atLineEnd) {
    lineStart = at;
  } else {
    while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10) lineStart -= 1;
  }
  const before = text.slice(0, lineStart);
  const after = text.slice(lineStart);
  const lead = before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const mark = makeChapterMark(title);
  const tail = after.length === 0 ? "\n" : after.startsWith("\n") ? "\n" : "\n\n";
  const nextText = `${before}${lead}${mark}${tail}${after}`;
  const caret = before.length + lead.length + mark.length + 1;
  return { text: nextText, caret };
}

/** 改写某章的标记行标题，返回新文本；开头章节（没有标记行）返回 null。 */
export function renameChapterMark(text: string, chapter: Chapter, title: string): string | null {
  if (chapter.bodyStart === chapter.markStart) return null;
  const lineEnd = text.indexOf("\n", chapter.markStart);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return text.slice(0, chapter.markStart) + makeChapterMark(title) + text.slice(end);
}

/**
 * 取消分章：删掉某章的标记行（含其换行），正文并入上一章。开头章节没有标记行，返回 null。
 * 标记行前后若因此出现三个以上连续换行，收敛为一个空行。
 */
export function removeChapterMark(text: string, chapter: Chapter): string | null {
  if (chapter.markStart >= chapter.bodyStart) return null;
  let before = text.slice(0, chapter.markStart);
  let after = text.slice(chapter.bodyStart);
  while (before.endsWith("\n\n") && after.startsWith("\n")) after = after.slice(1);
  if (before.endsWith("\n\n\n")) before = before.replace(/\n+$/, "\n\n");
  return before + after;
}

/* ───────── 卷（目录面板用） ───────── */

/** 一卷的摘要：由 App 从文库列表取，当前卷的标题 / 字数以编辑器里的实时值为准。 */
export interface VolumeSummary {
  id: string;
  title: string;
  /** 从 0 起的卷序号。 */
  volume: number;
  characterCount: number;
}

/** 「第N卷 · 标题」；标题就是默认的「第N卷」时不重复显示。 */
export function volumeLabel(volume: VolumeSummary): string {
  const fallback = `第${volume.volume + 1}卷`;
  const title = volume.title.trim();
  return title && title !== fallback ? `${fallback} · ${title}` : fallback;
}
