/** 主进程与 renderer 都要用的纯文本小工具（统一「字数」口径与文件名规则）。 */

/** 字数：去掉所有空白后按 Unicode 码点计数（与编辑器状态栏、文库卡片一致）。 */
export function countChars(content: string): number {
  return Array.from(content.replace(/\s/g, '')).length
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
