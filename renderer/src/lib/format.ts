/** 界面用的小格式化函数。 */

/** 把秒数变成「约 12 秒」「约 1 分 05 秒」这样的中文。 */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 1) return "不到 1 秒";
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return rest === 0 ? `约 ${minutes} 分钟` : `约 ${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
}
