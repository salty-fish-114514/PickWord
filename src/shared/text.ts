/** 主进程与 renderer 都要用的纯文本小工具（统一「字数」口径与文件名规则）。 */

/** 字数：去掉所有空白后按 Unicode 码点计数（与编辑器状态栏、文库卡片一致）。 */
function isWhitespaceCodePoint(code: number): boolean {
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

export function countChars(content: string): number {
  let count = 0;
  for (let index = 0; index < content.length; ) {
    const code = content.codePointAt(index)!;
    if (!isWhitespaceCodePoint(code)) count += 1;
    index += code > 0xffff ? 2 : 1;
  }
  return count;
}

/** 精确计算单次 UTF-16 编辑对 Unicode 码点数的影响（含跨边界代理项）。 */
export function countCharsDelta(
  oldText: string,
  newText: string,
  changeStart: number,
  oldEnd: number,
  newEnd: number,
): number {
  const contextStart = Math.max(0, changeStart - 2);
  const oldContextEnd = Math.min(oldText.length, oldEnd + 2);
  const newContextEnd = Math.min(newText.length, newEnd + 2);
  return (
    countChars(newText.slice(contextStart, newContextEnd)) -
    countChars(oldText.slice(contextStart, oldContextEnd))
  );
}

/** 文库卡片预览：压缩空白，取前 160 字。 */
export function makeExcerpt(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** 标题 → 合法 Windows 文件名（不含扩展名）。 */
export function safeFileName(title: string): string {
  let name = title
    // eslint-disable-next-line no-control-regex -- 控制字符在 Windows 文件名里同样非法
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  if (!name) name = '未命名'
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `_${name}`
  return name
}

/** 预计需要重新 prefill 的字符数超过它，状态栏 / 候选面板给一句「上下文重算」提示。 */
export const REBUILD_HINT_CHARS = 400
