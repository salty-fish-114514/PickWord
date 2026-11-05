export interface PageSlice {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface PageMetrics {
  width: number;
  height: number;
  inset: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
}

/**
 * Split plain text into fixed-height page slices. Paragraphs stay together where possible;
 * unusually long paragraphs are split at Unicode code-point boundaries. Page boundaries
 * are renderer-only and never become part of the saved document text.
 */
export function paginateText(text: string, metrics: PageMetrics): PageSlice[] {
  const innerWidth = Math.max(80, metrics.width - metrics.inset * 2 - 2);
  const innerHeight = Math.max(
    metrics.lineHeight,
    metrics.height - metrics.inset * 2 - 2,
  );
  const linesPerPage = Math.max(
    1,
    Math.floor(innerHeight / metrics.lineHeight),
  );
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context) context.font = `${metrics.fontSize}px ${metrics.fontFamily}`;

  const paragraphRanges: Array<{
    start: number;
    end: number;
    bodyEnd: number;
  }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    paragraphRanges.push({
      start,
      end,
      bodyEnd: newline === -1 ? end : end - 1,
    });
    start = end;
  }
  if (text.length === 0 || text.endsWith("\n"))
    paragraphRanges.push({
      start: text.length,
      end: text.length,
      bodyEnd: text.length,
    });

  const pages: PageSlice[] = [];
  let pageStart = 0;
  let usedLines = 0;
  const flush = (end: number) => {
    pages.push({
      index: pages.length,
      start: pageStart,
      end,
      text: text.slice(pageStart, end),
    });
    pageStart = end;
    usedLines = 0;
  };

  const countCodePoints = (value: string) => {
    let count = 0;
    for (let index = 0; index < value.length; count += 1) {
      const codePoint = value.codePointAt(index)!;
      index += codePoint > 0xffff ? 2 : 1;
    }
    return count;
  };

  const widthOf = (value: string) => {
    if (!value) return 0;
    const codePointCount = countCodePoints(value);
    if (!context) return codePointCount * metrics.fontSize;

    // Avoid asking Canvas to measure a multi-megabyte single line in one call.
    let measuredWidth = 0;
    const chunkSize = 8192;
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + chunkSize);
      const lastCodeUnit = value.charCodeAt(end - 1);
      if (
        end < value.length &&
        lastCodeUnit >= 0xd800 &&
        lastCodeUnit <= 0xdbff
      )
        end -= 1;
      measuredWidth += context.measureText(value.slice(start, end)).width;
      start = end;
    }
    return measuredWidth + codePointCount * metrics.fontSize * 0.025;
  };

  const advanceCodePoints = (
    value: string,
    start: number,
    end: number,
    count: number,
  ) => {
    let cursor = start;
    for (let index = 0; index < count && cursor < end; index += 1) {
      const codePoint = value.codePointAt(cursor)!;
      cursor += codePoint > 0xffff ? 2 : 1;
    }
    return cursor;
  };

  for (const paragraph of paragraphRanges) {
    const body = text.slice(paragraph.start, paragraph.bodyEnd);
    const width = widthOf(body);
    const lineCount = Math.max(1, Math.ceil(width / innerWidth));

    if (lineCount > linesPerPage) {
      if (paragraph.start > pageStart) flush(paragraph.start);
      const codePointCount = countCodePoints(body);
      const averageWidth = Math.max(
        metrics.fontSize * 0.25,
        width / Math.max(1, codePointCount),
      );
      const chunkSize = Math.max(
        1,
        Math.floor((innerWidth * linesPerPage) / averageWidth),
      );
      let cursor = paragraph.start;
      while (cursor < paragraph.end) {
        const next = advanceCodePoints(text, cursor, paragraph.end, chunkSize);
        pages.push({
          index: pages.length,
          start: cursor,
          end: next,
          text: text.slice(cursor, next),
        });
        cursor = next;
      }
      pageStart = paragraph.end;
      usedLines = 0;
      continue;
    }

    if (usedLines > 0 && usedLines + lineCount > linesPerPage)
      flush(paragraph.start);
    usedLines += lineCount;
  }

  if (pageStart < text.length || pages.length === 0) flush(text.length);
  return pages;
}

export interface PaginationEdit {
  changeStart: number;
}

/**
 * Reflow from the page containing the paragraph touched by an edit, while reusing all
 * earlier page slices by identity. This preserves a stable front-of-document prefix for
 * ordinary edits near the end of a long manuscript.
 */
export function repaginateAfterEdit(
  text: string,
  metrics: PageMetrics,
  previousText: string,
  previousPages: PageSlice[],
  edit: PaginationEdit,
): PageSlice[] {
  if (previousPages.length === 0) return paginateText(text, metrics);

  const offset = Math.max(0, Math.min(previousText.length, edit.changeStart));
  const paragraphStart =
    previousText.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  let dirtyPageIndex = previousPages.findIndex(
    (page) => paragraphStart <= page.end,
  );
  if (dirtyPageIndex === -1) dirtyPageIndex = previousPages.length - 1;

  const prefix = previousPages.slice(0, dirtyPageIndex);
  const reflowStart = previousPages[dirtyPageIndex].start;
  const localPages = paginateText(text.slice(reflowStart), metrics);
  const suffix = localPages.map((page, index) => ({
    index: prefix.length + index,
    start: reflowStart + page.start,
    end: reflowStart + page.end,
    text: page.text,
  }));
  return [...prefix, ...suffix];
}

export function spreadPages(pages: PageSlice[]): PageSlice[][] {
  const spreads: PageSlice[][] = [];
  for (let index = 0; index < pages.length; index += 2)
    spreads.push(pages.slice(index, index + 2));
  return spreads;
}
