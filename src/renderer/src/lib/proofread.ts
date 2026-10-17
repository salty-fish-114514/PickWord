/**
 * 纠错（LLM 层）：窗口选择、提示词与 GBNF 文法、输出解析、引用定位、问题随编辑平移。
 *
 * 设计要点（见 plan.md §2.3）：
 *   - 检查范围是「整个窗口」(4~6k 字)，起点固定、终点跟着光标段落走，这样 cache_prompt 能命中前缀；
 *     窗口超过上限时起点向前跳到 end - 4000 附近的段首。
 *   - 模型输出被文法锁成行格式：
 *       A|原文引用|问题|改法        （语病，改法可空）
 *       B|引用1‖引用2|重复了什么|   （单调：句式 / 用词雷同）
 *       无
 *   - 引用定位：精确 → 去标点规范化 → ≥ 8 字最长公共子串 → 放弃。
 *   - 问题只存在内存里，随编辑用 EditSpan 平移；被改动波及的直接丢弃（作者多半已经改了）。
 *   - 人设校验（plan.md §2.4）走同一条管线：只换提示词 / 文法 / 行格式（角色名|引用|冲突项），结果 kind = consistency。
 */
import type { PromptTemplate } from "./types";
import type { EditSpan } from "./editorText";
import { paragraphStartAt } from "./editorText";
import { isChapterMarkLine } from "./chapters";

/* ════════════════════════════ 类型 ════════════════════════════ */

export type IssueKind = "grammar" | "monotony" | "consistency" | "local";

export interface IssueRange {
  start: number;
  end: number;
}

export interface Issue {
  id: string;
  kind: IssueKind;
  source: "llm" | "local";
  /** 文档内的绝对偏移，至少一个；单调类问题会有多处。 */
  ranges: IssueRange[];
  /** 第一处引用的原文。 */
  quote: string;
  message: string;
  /** 语病的改法（整句改写）；为空表示模型没给。 */
  suggestion?: string;
  /** 「忽略」用的键：同一类 + 同一段引用再次被报出来时不再显示。 */
  key: string;
}

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  grammar: "语病",
  monotony: "单调",
  consistency: "人设",
  local: "重复",
};

/* ════════════════════════════ 窗口 ════════════════════════════ */

/** 窗口上限：超过就把起点向前跳。 */
export const PROOF_WINDOW_MAX = 6000;
/** 起点跳跃后的目标长度。 */
export const PROOF_WINDOW_TARGET = 4000;
/** 自动检查：距上次检查至少新增这么多字。 */
export const PROOF_MIN_NEW_CHARS = 600;
/** 自动检查：停笔多久后触发。 */
export const PROOF_IDLE_MS = 3000;
/** 少于这么多字的窗口不值得送检。 */
export const PROOF_MIN_WINDOW = 80;

export interface ProofWindow {
  start: number;
  end: number;
}

/**
 * 决定这次检查的窗口。
 *   end   = 光标所在段的段首（自动，正在写的那段不查）或段尾（手动）；
 *   start = 上次的起点（前缀不变 → KV cache 命中），越界或超长时重新落到 end - TARGET 的段首。
 */
export function resolveProofWindow(text: string, caret: number, prevStart: number | null, manual: boolean): ProofWindow {
  const end = manual ? paragraphEndAt(text, caret) : paragraphStartAt(text, caret);
  let start = prevStart === null ? null : paragraphStartAt(text, prevStart);
  if (start === null || start < 0 || start >= end || end - start > PROOF_WINDOW_MAX) {
    start = paragraphStartAt(text, Math.max(0, end - PROOF_WINDOW_TARGET));
  }
  // 起点落在章节标记行上就跳过它：窗口里不留一行无意义的空白
  while (start < end) {
    const lineEnd = text.indexOf("\n", start);
    const line = text.slice(start, lineEnd === -1 ? end : lineEnd);
    if (!isChapterMarkLine(line) || lineEnd === -1) break;
    start = lineEnd + 1;
  }
  return { start, end };
}

export function paragraphEndAt(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const nl = text.indexOf("\n", clamped);
  return nl === -1 ? text.length : nl + 1;
}

/** 章节标记行换成等长空格：模型看不到它，偏移却一个都不变。 */
export function maskChapterMarks(text: string): string {
  if (!text.includes("--")) return text;
  return text
    .split("\n")
    .map((line) => (isChapterMarkLine(line) ? " ".repeat(line.length) : line))
    .join("\n");
}

/* ════════════════════════════ 提示词 ════════════════════════════ */

export const PROOFREAD_MAX_LINES = 8;

const SYSTEM_PROOFREAD = `你是中文小说的文字编辑。通读「正文」，只找两类问题，并严格按行格式输出：
A|原文引用|问题|改法
  语病：病句、搭配不当、错别字、成分残缺或赘余、标点误用。引用必须是正文里连续的一段（6～40 字），一字不差；改法给出改好的整句，没有把握就留空。
B|引用1‖引用2|重复了什么|
  单调：相近位置反复用同一个词、同一种句式或同样的开头；两处引用各 4～30 字，同样一字不差。
每行一个问题，最多 ${PROOFREAD_MAX_LINES} 行，只报有把握的问题，不改写作者的风格。没有问题就只输出一个字：无
不要解释，不要输出格式之外的任何文字。`;

/**
 * noThinkPrefix：有思考开关的模型（Qwen3.5 等）要在 assistant 回合开头放空思考块 `<think>\n\n</think>\n\n`，
 * 模型才处于训练时的「直接作答」分布。
 *
 * ★ 没有它 + 下面的文法 = 纠错一律回「无」（2026-10-14 实机事故，详见 structure.md 开头 / ModelProfile.noThinkPrefix）：
 *   模型自然首 token 是 `<think>`，文法判非法后只剩「无 / A / B」，单 token 的「无」直接胜出，predicted_n=2。
 *   微调时样本必须用与这里逐字节相同的拼法：systemOpen + 系统文案 + … + assistantOpen + noThinkPrefix + 输出。
 */
export function buildProofreadPrompt(template: PromptTemplate, windowText: string, noThinkPrefix = ""): string {
  return (
    template.systemOpen +
    SYSTEM_PROOFREAD +
    template.systemClose +
    template.userOpen +
    `正文：\n${windowText.trimEnd()}\n\n请按格式输出。` +
    template.userClose +
    template.assistantOpen +
    noThinkPrefix
  );
}

/**
 * GBNF：把输出锁成上面的行格式。引用里不允许出现分隔符与换行，长度也有上下限，
 * 这样解析永远不会歧义；模型「没话说」时只能输出「无」。
 *
 * ★ 注意「无」是单 token 逃生口：文法只在合法 token 里重新归一化，若 prompt 的回合格式与模型训练分布不一致
 *   （见 buildProofreadPrompt 的 noThinkPrefix），模型会在第一个 token 就坍缩到「无」。排查顺序：
 *   先看主进程 [llm] 日志的 predicted_n 与 content 原话，再怀疑模型能力；若仍偏「无」，备选是让格式先写一行
 *   「概览：…」再逐条列出，或微调时平衡「无」样本比例。
 */
export const PROOFREAD_GRAMMAR = `root ::= "无" | line+
line ::= (gline | mline) "\\n"
gline ::= "A|" quote "|" note "|" fix
mline ::= "B|" quote ("‖" quote)? ("‖" quote)? "|" note "|"
quote ::= qchar{4,60}
qchar ::= [^|‖\\n]
note ::= nchar{1,40}
fix ::= nchar{0,100}
nchar ::= [^|\\n]
`;

export const PROOFREAD_SAMPLING = { temperature: 0.2, topP: 0.9, nPredict: 400 } as const;

/* ── 人设一致性校验：同一管线，只换提示词与行格式 ── */

export const CONSISTENCY_MAX_LINES = 6;

const SYSTEM_CONSISTENCY = `你是小说的设定编辑。下面给出几位角色的设定卡和一段正文。只找正文与设定卡**明确矛盾**的地方（外观、身份、关系、能力、已经发生过的事实等），严格按行格式输出：
角色名|原文引用|冲突项
引用必须是正文里连续的一段（10～40 字），一字不差；冲突项不超过 30 字，写清设定里是怎么说的。
每行一个问题，最多 ${CONSISTENCY_MAX_LINES} 行，只报有把握的矛盾；正文没有提到的设定不算矛盾。没有矛盾就只输出一个字：无
不要解释，不要输出格式之外的任何文字。`;

/** cardsText 只放窗口里命中的角色卡（materials.buildMaterialsText），正文与纠错用同一个窗口。 */
export function buildConsistencyPrompt(template: PromptTemplate, cardsText: string, windowText: string, noThinkPrefix = ""): string {
  return (
    template.systemOpen +
    SYSTEM_CONSISTENCY +
    template.systemClose +
    template.userOpen +
    `设定卡：\n${cardsText.trim()}\n\n正文：\n${windowText.trimEnd()}\n\n请按格式输出。` +
    template.userClose +
    template.assistantOpen +
    noThinkPrefix
  );
}

export const CONSISTENCY_GRAMMAR = `root ::= "无" | line+
line ::= name "|" quote "|" note "\n"
name ::= nchar{1,12}
quote ::= qchar{6,60}
note ::= nchar{1,40}
qchar ::= [^|‖\n]
nchar ::= [^|\n]
`;

export const CONSISTENCY_SAMPLING = { temperature: 0.2, topP: 0.9, nPredict: 320 } as const;

/* ════════════════════════════ 解析 ════════════════════════════ */

export interface Finding {
  kind: "grammar" | "monotony" | "consistency";
  quotes: string[];
  message: string;
  suggestion?: string;
}

/** 人设校验的行格式：角色名|引用|冲突项。 */
export function parseConsistencyFindings(output: string): Finding[] {
  const findings: Finding[] = [];
  const body = output.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/｜/g, "|").trim();
    if (!line || line === "无") continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3 || !parts[1] || !parts[2]) continue;
    const name = parts[0].slice(0, 12);
    findings.push({ kind: "consistency", quotes: [parts[1]], message: name ? `${name}：${parts[2]}` : parts[2] });
    if (findings.length >= CONSISTENCY_MAX_LINES) break;
  }
  return findings;
}

/** 容错解析：接受全角竖线、多余空白、缺少末尾竖线；格式不对的行直接跳过。 */
export function parseFindings(output: string): Finding[] {
  const findings: Finding[] = [];
  // 无文法兜底时模型可能先思考一段：整块去掉（未闭合的也去掉）
  const body = output.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/｜/g, "|").trim();
    if (!line || line === "无") continue;
    const parts = line.split("|").map((p) => p.trim());
    const tag = parts[0];
    if (tag === "A" && parts.length >= 3 && parts[1]) {
      const quote = parts[1];
      const suggestion = parts[3]?.trim() || undefined;
      findings.push({
        kind: "grammar",
        quotes: [quote],
        message: parts[2] || "语病",
        suggestion: suggestion && suggestion !== quote ? suggestion : undefined,
      });
    } else if (tag === "B" && parts.length >= 2 && parts[1]) {
      const quotes = parts[1]
        .split(/‖|\|\|/)
        .map((q) => q.trim())
        .filter((q) => q.length > 0);
      if (quotes.length === 0) continue;
      findings.push({ kind: "monotony", quotes, message: parts[2] || "重复" });
    }
    if (findings.length >= PROOFREAD_MAX_LINES) break;
  }
  return findings;
}

/* ════════════════════════════ 引用定位 ════════════════════════════ */

const IGNORABLE = /[\s，。！？；：、“”‘’「」『』（）()《》〈〉【】…—\-·,.!?;:'"~～]/u;

interface NormalizedText {
  chars: string;
  /** 规范化后的第 i 个字符在原文里的偏移。 */
  map: number[];
}

function normalize(text: string): NormalizedText {
  let chars = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (IGNORABLE.test(ch)) continue;
    chars += ch;
    map.push(i);
  }
  return { chars, map };
}

/** 窗口文本的定位器：规范化只做一次，多条引用复用。 */
export class QuoteLocator {
  private normalized: NormalizedText | null = null;

  constructor(
    private readonly text: string,
    private readonly base: number,
  ) {}

  /** 找一处；`from` 之后优先（用于同一引用的多次出现）。找不到返回 null。 */
  locate(quote: string, from = 0): IssueRange | null {
    const q = quote.trim();
    if (q.length < 2) return null;
    const exact = this.text.indexOf(q, from);
    if (exact !== -1) return this.abs(exact, exact + q.length);

    const norm = this.normalizedText();
    const nq = normalize(q).chars;
    if (nq.length >= 2) {
      const fromNorm = lowerBound(norm.map, from);
      const hit = norm.chars.indexOf(nq, fromNorm);
      if (hit !== -1) return this.abs(norm.map[hit], norm.map[hit + nq.length - 1] + 1);
    }

    const lcs = longestCommonSubstring(this.text, q);
    const minLen = Math.max(8, Math.ceil(q.length * 0.6));
    if (lcs && lcs.length >= minLen) return this.abs(lcs.start, lcs.start + lcs.length);
    return null;
  }

  /** 同一引用在窗口里的所有出现（精确匹配），最多 limit 处。 */
  locateAll(quote: string, limit = 6): IssueRange[] {
    const q = quote.trim();
    const out: IssueRange[] = [];
    if (q.length < 2) return out;
    let from = 0;
    while (out.length < limit) {
      const at = this.text.indexOf(q, from);
      if (at === -1) break;
      out.push(this.abs(at, at + q.length));
      from = at + q.length;
    }
    return out;
  }

  private abs(start: number, end: number): IssueRange {
    return { start: this.base + start, end: this.base + end };
  }

  private normalizedText(): NormalizedText {
    if (!this.normalized) this.normalized = normalize(this.text);
    return this.normalized;
  }
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 最长公共子串（滚动数组 DP，窗口 6k × 引用 60 字，开销可忽略）。返回在 text 里的位置。 */
export function longestCommonSubstring(text: string, quote: string): { start: number; length: number } | null {
  const n = text.length;
  const m = quote.length;
  if (n === 0 || m === 0) return null;
  let prev = new Int16Array(m + 1);
  let cur = new Int16Array(m + 1);
  let best = 0;
  let bestEnd = -1;
  for (let i = 1; i <= n; i += 1) {
    const tc = text.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      if (tc === quote.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) {
          best = v;
          bestEnd = i;
        }
      } else {
        cur[j] = 0;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return best > 0 ? { start: bestEnd - best, length: best } : null;
}

/* ════════════════════════════ 结果 → Issue ════════════════════════════ */

export function issueKey(kind: IssueKind, quotes: readonly string[]): string {
  return `${kind}:${quotes.map((q) => normalize(q).chars).join("‖")}`;
}

/**
 * 把模型的 findings 落到文档偏移上。定位不到的丢掉；单调类只要有一处定位成功就保留，
 * 只给了一条引用时把窗口里所有出现处都标出来。
 */
export function findingsToIssues(findings: Finding[], windowText: string, windowStart: number): Issue[] {
  const locator = new QuoteLocator(windowText, windowStart);
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    let ranges: IssueRange[] = [];
    if (finding.kind === "grammar" || finding.kind === "consistency") {
      const range = locator.locate(finding.quotes[0]);
      if (range) ranges = [range];
    } else if (finding.quotes.length === 1) {
      ranges = locator.locateAll(finding.quotes[0]);
      if (ranges.length === 0) {
        const range = locator.locate(finding.quotes[0]);
        if (range) ranges = [range];
      }
    } else {
      let from = 0;
      for (const quote of finding.quotes) {
        const range = locator.locate(quote, from);
        if (!range) continue;
        ranges.push(range);
        from = range.end - windowStart;
      }
      // 两条引用一样时 locate 会退回第一处：按出现顺序补齐
      ranges = dedupeRanges(ranges);
    }
    if (ranges.length === 0) continue;
    const key = issueKey(finding.kind, finding.quotes);
    if (seen.has(key)) continue;
    seen.add(key);
    const quote = windowText.slice(ranges[0].start - windowStart, ranges[0].end - windowStart);
    issues.push({
      id: crypto.randomUUID(),
      kind: finding.kind,
      source: "llm",
      ranges,
      quote,
      message: finding.message,
      suggestion: finding.kind === "grammar" ? finding.suggestion : undefined,
      key,
    });
  }
  return issues;
}

function dedupeRanges(ranges: IssueRange[]): IssueRange[] {
  const out: IssueRange[] = [];
  for (const r of ranges) {
    if (!out.some((o) => o.start === r.start && o.end === r.end)) out.push(r);
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ════════════════════════════ 随编辑平移 ════════════════════════════ */

/** 被这次改动碰到的问题直接丢弃，其余按 delta 平移。 */
export function mapIssuesThroughEdit(issues: Issue[], span: EditSpan): Issue[] {
  if (span.changeStart === span.oldEnd && span.delta === 0) return issues;
  const out: Issue[] = [];
  for (const issue of issues) {
    let touched = false;
    const ranges = issue.ranges.map((r) => {
      if (r.end > span.changeStart && r.start < span.oldEnd) touched = true;
      if (r.start >= span.oldEnd) return { start: r.start + span.delta, end: r.end + span.delta };
      return r;
    });
    if (!touched) out.push({ ...issue, ranges });
  }
  return out;
}

/** 光标落在哪个问题里（多处命中时取范围最小的那个）。 */
export function issueAtOffset(issues: readonly Issue[], offset: number): Issue | null {
  let best: Issue | null = null;
  let bestLen = Number.POSITIVE_INFINITY;
  for (const issue of issues) {
    for (const r of issue.ranges) {
      if (offset >= r.start && offset <= r.end && r.end - r.start < bestLen) {
        best = issue;
        bestLen = r.end - r.start;
      }
    }
  }
  return best;
}

/** 把窗口内同类的旧 LLM 问题换成新结果：窗口外 / 其它类别的保留，忽略过的不再出现。 */
export function mergeLlmIssues(
  prev: Issue[],
  fresh: Issue[],
  window: ProofWindow,
  dismissed: ReadonlySet<string>,
  kinds: ReadonlySet<IssueKind>,
): Issue[] {
  const kept = prev.filter(
    (issue) =>
      issue.source !== "llm" || !kinds.has(issue.kind) || issue.ranges.every((r) => r.end <= window.start || r.start >= window.end),
  );
  const incoming = fresh.filter((issue) => !dismissed.has(issue.key));
  return [...kept, ...incoming].sort((a, b) => a.ranges[0].start - b.ranges[0].start);
}
