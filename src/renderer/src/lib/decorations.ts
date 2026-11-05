/**
 * 高亮层的通用「装饰」描述。
 *
 * 高亮层是一个与 textarea 排版完全一致、文字透明的 div；装饰 = 给某个字符区间套一个带 class 的 span。
 * 所有需要在正文上做标记的功能（锚点、校对结果、单调提示……）都只产出 Decoration，渲染只写一次。
 *
 *   anchor  零宽：在该偏移所在行的上方画一条横线（章节 / 锚点起点）
 *   band    区间：加深背景（例如「用词单调」）
 *   wavy    区间：波浪下划线（例如校对疑点）
 */

export type DecorationKind = "anchor" | "band" | "wavy";

export interface Decoration {
  start: number;
  /** 零宽装饰 end === start。 */
  end: number;
  kind: DecorationKind;
  /** 可选：同类装饰的细分（渲染成 data-tone，供 CSS 区分强弱）。 */
  tone?: string;
  /** 可选：当前关注的那一处（光标落在上面），渲染成 data-active。 */
  active?: boolean;
  /** 可选：零宽装饰旁边的小标签（渲染成 data-label，CSS 用 attr() 显示）。 */
  label?: string;
}

export interface DecorationSegment {
  text: string;
  /** 本段覆盖的区间装饰（已按 start 去重、不重叠）；零宽装饰单独成段，text 为空。 */
  decoration: Decoration | null;
  key: number;
}

/**
 * 把正文按装饰切成若干段，供渲染层逐段生成 span。
 * 约定区间装饰互不重叠（调用方保证；若重叠，后者会被裁到前者之后）。
 */
export function splitByDecorations(text: string, decorations: Decoration[]): DecorationSegment[] {
  if (decorations.length === 0) return [{ text, decoration: null, key: 0 }];

  const sorted = [...decorations]
    .map((d) => ({
      ...d,
      start: Math.max(0, Math.min(d.start, text.length)),
      end: Math.max(0, Math.min(d.end, text.length)),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const segments: DecorationSegment[] = [];
  let cursor = 0;
  let key = 0;
  for (const decoration of sorted) {
    const start = Math.max(decoration.start, cursor);
    const end = Math.max(decoration.end, start);
    if (start > cursor) segments.push({ text: text.slice(cursor, start), decoration: null, key: key++ });
    if (end === start) {
      if (decoration.end === decoration.start) segments.push({ text: "", decoration, key: key++ });
      continue; // 被前一个区间完全盖住的区间装饰：跳过
    }
    segments.push({ text: text.slice(start, end), decoration, key: key++ });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), decoration: null, key: key++ });
  return segments;
}
