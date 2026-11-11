/**
 * 纠错（本地层）：不花算力的单调性提示，边写边算。
 *   - 短距离内重复的 ≥ 4 字片段（人名、常见虚词组合除外）；
 *   - 连续 ≥ 3 段用同样两个字开头；
 *   - 专名写法不一致：与某个角色名 / 别名只差一个字的罕见写法（莱奥拉 / 莱奥菈）。
 * 结果与 LLM 层共用 Issue 结构（kind = "local"），只是来源不同、底色更淡。
 */
import { issueKey, type Issue, type IssueRange } from "./proofread";

export const LOCAL_GRAM = 4;
export const LOCAL_SPAN = 1500;
export const LOCAL_MAX_PHRASE = 12;
const LOCAL_OPENER_RUN = 3;
const LOCAL_MAX_ISSUES = 40;

/** 片段里不能含标点 / 空白 / 数字 / 字母。 */
const BREAK = /[\s\d\p{P}\p{S}A-Za-z]/u;
/** 常见到不值得提醒的组合。 */
const STOP_PHRASES = new Set([
  "什么时候",
  "怎么回事",
  "有没有人",
  "不知道该",
  "是不是有",
  "这个时候",
  "那个时候",
  "的时候他",
  "的时候她",
  "的那一刻",
  "一时之间",
  "不由自主",
  "情不自禁",
  "不知不觉",
  "无论如何",
  "怎么可能",
  "有什么用",
  "没有什么",
  "什么也没",
  "什么都没",
  "还是没有",
  "已经没有",
  "也不知道",
  "不知道是",
  "就这样子",
  "怎么办呢",
]);

export interface LocalHintOptions {
  /** 人名与别名：含这些名字的片段不算重复。 */
  ignoreNames?: readonly string[];
  /** 「忽略」过的键。 */
  dismissed?: ReadonlySet<string>;
}

/** 在 text[from, to) 范围内找本地提示；偏移都是文档绝对偏移。 */
export function findLocalHints(text: string, from: number, to: number, options: LocalHintOptions = {}): Issue[] {
  const lo = Math.max(0, from);
  const hi = Math.min(text.length, to);
  if (hi - lo < LOCAL_GRAM * 2) return [];
  const names = (options.ignoreNames ?? []).filter((n) => n.length >= 2);
  const dismissed = options.dismissed;
  const repeats = [...findRepeats(text, lo, hi, names), ...findNameVariants(text, lo, hi, names)];
  // 开头雷同若已被某个重复片段整体覆盖（「她抬起头」×4 同时也是「她抬」开头），不再重复报
  const openers = findOpeners(text, lo, hi).filter(
    (issue) => !issue.ranges.every((r) => repeats.some((rep) => rep.ranges.some((c) => r.start >= c.start && r.end <= c.end))),
  );
  const issues: Issue[] = [...repeats, ...openers];
  const filtered = dismissed ? issues.filter((issue) => !dismissed.has(issue.key)) : issues;
  return filtered.sort((a, b) => a.ranges[0].start - b.ranges[0].start).slice(0, LOCAL_MAX_ISSUES);
}

function usable(gram: string, names: readonly string[]): boolean {
  if (BREAK.test(gram)) return false;
  if (STOP_PHRASES.has(gram)) return false;
  // 「哈哈哈哈」「……」这类叠字不算
  if (/^(.)\1+$/u.test(gram)) return false;
  return !names.some((name) => gram.includes(name) || name.includes(gram));
}

/** 最大化公共片段：从两处同时向右延伸，直到不同 / 碰到标点 / 达到上限。 */
function extend(text: string, a: number, b: number, limit: number): number {
  let len = LOCAL_GRAM;
  while (len < LOCAL_MAX_PHRASE && b + len < limit) {
    const ch = text[b + len];
    if (text[a + len] !== ch || BREAK.test(ch)) break;
    len += 1;
  }
  return len;
}

function findRepeats(text: string, lo: number, hi: number, names: readonly string[]): Issue[] {
  const lastSeen = new Map<string, number>();
  /** 片段 → 所有出现位置（相邻两处距离都在 LOCAL_SPAN 内）。 */
  const groups = new Map<string, IssueRange[]>();
  let skipUntil = lo;
  for (let i = lo; i + LOCAL_GRAM <= hi; i += 1) {
    const gram = text.slice(i, i + LOCAL_GRAM);
    if (!usable(gram, names)) continue;
    const prev = lastSeen.get(gram);
    lastSeen.set(gram, i);
    if (prev === undefined || i - prev > LOCAL_SPAN || i < skipUntil) continue;
    const len = extend(text, prev, i, hi);
    const phrase = text.slice(i, i + len);
    if (names.some((name) => phrase.includes(name))) continue;
    const group = groups.get(phrase);
    const range = { start: i, end: i + len };
    if (group) {
      if (group[group.length - 1].end <= i) group.push(range);
    } else {
      groups.set(phrase, [{ start: prev, end: prev + len }, range]);
    }
    skipUntil = i + len;
  }

  const issues: Issue[] = [];
  const covered: IssueRange[] = [];
  // 长片段优先：「她抬起头看向窗外」命中后，它内部的 4 字片段不再单独报
  const entries = [...groups.entries()].sort((a, b) => b[0].length - a[0].length || a[1][0].start - b[1][0].start);
  for (const [phrase, ranges] of entries) {
    if (ranges.some((r) => covered.some((c) => r.start >= c.start && r.end <= c.end))) continue;
    covered.push(...ranges);
    const span = ranges[ranges.length - 1].end - ranges[0].start;
    issues.push({
      id: crypto.randomUUID(),
      kind: "local",
      source: "local",
      ranges: ranges.slice(0, 8),
      quote: phrase,
      message: `「${phrase}」在 ${span} 字内出现了 ${ranges.length} 次`,
      key: issueKey("local", [phrase]),
    });
  }
  return issues;
}

/** 段落开头的前两个字（跳过引号等标点）。 */
function openerOf(text: string, start: number, end: number): IssueRange | null {
  let i = start;
  while (i < end && /[\s\p{P}]/u.test(text[i])) i += 1;
  if (i + 2 > end) return null;
  const two = text.slice(i, i + 2);
  if (BREAK.test(two)) return null;
  return { start: i, end: i + 2 };
}

/** 专名写法不一致：同长度、恰好一个字不同、且比正名少见得多的写法。两字名变体太多，只查 ≥ 3 字的名字。 */
export function findNameVariants(text: string, lo: number, hi: number, names: readonly string[]): Issue[] {
  const known = new Set(names);
  const issues: Issue[] = [];
  for (const name of names) {
    const len = name.length;
    if (len < 3 || BREAK.test(name)) continue;
    let nameCount = 0;
    const variants = new Map<string, IssueRange[]>();
    for (let i = lo; i + len <= hi; i += 1) {
      let diff = -1;
      let mismatches = 0;
      for (let k = 0; k < len; k += 1) {
        if (text.charCodeAt(i + k) !== name.charCodeAt(k)) {
          mismatches += 1;
          if (mismatches > 1) break;
          diff = k;
        }
      }
      if (mismatches === 0) {
        nameCount += 1;
        continue;
      }
      if (mismatches !== 1) continue;
      const variant = text.slice(i, i + len);
      if (known.has(variant) || BREAK.test(variant[diff])) continue;
      const list = variants.get(variant);
      if (list) list.push({ start: i, end: i + len });
      else variants.set(variant, [{ start: i, end: i + len }]);
    }
    for (const [variant, ranges] of variants) {
      // 比正名还常见的八成是另一个人；只报「少见得多」的
      if (ranges.length > 5 || ranges.length * 3 > nameCount) continue;
      issues.push({
        id: crypto.randomUUID(),
        kind: "local",
        source: "local",
        ranges: ranges.slice(0, 8),
        quote: variant,
        message: `「${variant}」疑为「${name}」的另一种写法（${ranges.length} 处）`,
        key: issueKey("local", [`专名:${name}:${variant}`]),
      });
    }
  }
  return issues;
}

function findOpeners(text: string, lo: number, hi: number): Issue[] {
  const issues: Issue[] = [];
  let run: IssueRange[] = [];
  let runText = "";
  const flush = () => {
    if (run.length >= LOCAL_OPENER_RUN) {
      issues.push({
        id: crypto.randomUUID(),
        kind: "local",
        source: "local",
        ranges: [...run],
        quote: runText,
        message: `连续 ${run.length} 段都以「${runText}」开头`,
        key: issueKey("local", [`开头:${runText}:${run.length}`]),
      });
    }
    run = [];
    runText = "";
  };
  let pos = lo;
  while (pos < hi) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 || nl >= hi ? hi : nl;
    if (end > pos) {
      const opener = openerOf(text, pos, end);
      if (opener) {
        const two = text.slice(opener.start, opener.end);
        if (two === runText) run.push(opener);
        else {
          flush();
          run = [opener];
          runText = two;
        }
      }
      // 空行不打断连续计数，只有「换了开头」才算
    }
    if (nl === -1 || nl >= hi) break;
    pos = nl + 1;
  }
  flush();
  return issues;
}
