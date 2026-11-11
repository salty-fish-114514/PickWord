/**
 * 纠错（LLM 层）：窗口选择、提示词与 GBNF 文法、输出解析、引用定位、问题随编辑平移。
 *
 * 设计要点：
 *   - 检查范围是「整个窗口」(4~6k 字)，起点固定、终点跟着光标段落走，这样 cache_prompt 能命中前缀；
 *     窗口超过上限时起点向前跳到 end - 4000 附近的段首。
 *   - 固定版本提示词：每次请求从 [0] 为段落编号；A/B 输出段号 + 原文短片段 + 简短原因；
 *     A 的改法必须与引用片段同范围，确保编辑器接受操作只替换该片段。
 *   - 引用定位：只接受模型指定段落中的精确连续子串，不跨段搜索、不模糊锚定。
 *   - 问题只存在内存里，随编辑用 EditSpan 平移；被改动波及的直接丢弃（作者多半已经改了）。
 *
 * ★ 人设校验（角色卡 × 正文找矛盾）已于 2026-10-25 删除：小模型做不稳，误报漏报都高。
 *   人物与设定从此不与模型交互，只保留 lib/materials.ts 的正则统计（命中展示 / 提及次数 / 建卡候选名）
 *   与 lib/monotony.ts 的专名变体提示。
 */
import type { PromptTemplate } from "./types";
import type { EditSpan } from "./editorText";
import { paragraphStartAt } from "./editorText";
import { isChapterMarkLine } from "./chapters";
import { PROOFREAD_DEFAULT_MAX_FINDINGS, PROOFREAD_FINDINGS_LIMITS } from "./settings";
export { PROOFREAD_DEFAULT_MAX_FINDINGS, PROOFREAD_FINDINGS_LIMITS };

/* ════════════════════════════ 类型 ════════════════════════════ */

export type IssueKind = "grammar" | "monotony" | "local";

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
  /** 语病的改法（只替换引用片段的最小改法）；为空表示模型没给。 */
  suggestion?: string;
  /** 「忽略」用的键：同一类 + 同一段引用再次被报出来时不再显示。 */
  key: string;
}

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  grammar: "语病",
  monotony: "单调",
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

function clampFindingLimit(value: number): number {
  return Math.min(PROOFREAD_FINDINGS_LIMITS.max, Math.max(PROOFREAD_FINDINGS_LIMITS.min, Math.round(value)));
}
/** 固定提示词协议版本；改正文案/格式时必须显式 bump，并同步 SFT 样本与 prompt probe。 */
export const PROOFREAD_PROMPT_VERSION = "proofread-paragraph-v2";

export interface NumberedProofParagraph {
  /** 本次请求窗口内的 0-based 序号；每次请求都从 0 重新编号。 */
  id: number;
  /** 原文段落，不包含编号标签。 */
  text: string;
  /** 在未编号 windowText 中的 UTF-16 偏移，end exclusive。 */
  start: number;
  end: number;
}

/** 每个非空文本行作为一个输入段落；跳过空行/被 mask 的章节行，但保留其偏移。 */
export function numberProofreadParagraphs(windowText: string): NumberedProofParagraph[] {
  const paragraphs: NumberedProofParagraph[] = [];
  let offset = 0;
  for (const line of windowText.split("\n")) {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.trim().length > 0) {
      paragraphs.push({ id: paragraphs.length, text, start: offset, end: offset + text.length });
    }
    offset += line.length + 1;
  }
  return paragraphs;
}

/** 固定的纠错 system 指令。仅按用户设置替换报告条数，不拼接其它请求级规则。 */
const SYSTEM_PROOFREAD = `你是中文小说的文字编辑。通读编号正文，只找两类问题，并严格按行格式输出：
A|段号|原文片段|问题原因|改法
  语病：病句、搭配不当、错别字、成分残缺或赘余、标点误用。段号是输入中 [n] 的整数，原文片段必须是在该段内逐字连续出现的短片段（4～40 字），改法只给对应片段的最小替换，不要抄整句。问题原因用简短、客观的一句话；改法没有把握时留空。
B|段号1|片段1|段号2|片段2|重复原因|
  单调：相近位置反复用同一个词、同一种句式或同样的开头；两个片段分别逐字取自对应编号段落，各 4～30 字。两个片段可来自同一段。重复原因简短客观。
段号从 0 开始，只能引用本次输入中存在的段号。不要改写作者风格，不要把口语、方言、粗口或有意重复当错误。每行一个问题，最多 {maxFindings} 行；没有把握或没有问题时只输出一个字：无。
不要输出长篇推理、检查过程、Markdown、JSON 或格式之外的文字。`;

/**
 * noThinkPrefix 与 assistant 回合格式必须固定：Qwen3.5 曾因缺少空思考块，
 * 在 GBNF 限制下于 predicted_n=2 直接输出「无」。
 * SFT 样本必须使用与 buildProofreadPrompt 完全相同的 system/user/assistant 拼接，
 * 包括模板、空思考块、段落标签、换行与正文标签；不能只训练 system 文案。
 */
export function buildProofreadPrompt(
  template: PromptTemplate,
  paragraphs: readonly NumberedProofParagraph[],
  noThinkPrefix = "",
  maxFindings = PROOFREAD_DEFAULT_MAX_FINDINGS,
): string {
  const body = paragraphs.map((paragraph) => `[${paragraph.id}] ${paragraph.text}`).join("\n\n");
  const systemPrompt = SYSTEM_PROOFREAD.replace("{maxFindings}", String(clampFindingLimit(maxFindings)));
  return (
    template.systemOpen +
    systemPrompt +
    template.systemClose +
    template.userOpen +
    `正文：\n${body}\n\n请按格式输出。` +
    template.userClose +
    template.assistantOpen +
    noThinkPrefix
  );
}

/**
 * GBNF 固定约束 A/B/无 行格式；程序仍会校验段号、原文片段与重复项。
 * 「无」是短答案逃生口：历史故障表明必须保留官方回合格式与 noThinkPrefix，
 * 否则短答案可能因约束解码偏好而压过有效问题行。
 */
export const PROOFREAD_GRAMMAR = `root ::= "无" | line+
line ::= (gline | mline) "\\n"
gline ::= "A|" index "|" aquote "|" note "|" fix
mline ::= "B|" index "|" bquote "|" index "|" bquote "|" note "|"
index ::= "0" | [1-9][0-9]{0,3}
aquote ::= qchar{4,40}
bquote ::= qchar{4,30}
qchar ::= [^|‖\\n]
note ::= nchar{1,40}
fix ::= nchar{0,100}
nchar ::= [^|\\n]
`;

export function proofreadSampling(maxFindings = PROOFREAD_DEFAULT_MAX_FINDINGS) {
  const limit = clampFindingLimit(maxFindings);
  return { temperature: 0.2, topP: 0.9, nPredict: Math.min(2048, 300 + limit * 60) } as const;
}

/* ════════════════════════════ 解析 ════════════════════════════ */

export interface Finding {
  kind: "grammar" | "monotony";
  /** 对应输入段落的 0-based ID；单调问题有两个。 */
  paragraphs: number[];
  /** 每个片段都只在对应段落中定位。 */
  quotes: string[];
  /** 短、可监督的错误原因，不是隐藏思维链。 */
  message: string;
  /** 语病的最小替换片段，与 quote 范围一一对应。 */
  suggestion?: string;
}

function parseParagraphId(value: string | undefined): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 容错解析：接受全角竖线和末尾竖线；段号/片段关系由定位阶段再校验。 */
export function parseFindings(output: string, maxFindings = PROOFREAD_DEFAULT_MAX_FINDINGS): Finding[] {
  const findings: Finding[] = [];
  // 兼容旧版无文法兜底时可能出现的思考块；运行时仍通过 noThinkPrefix 避免其产生。
  const body = output.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/｜/g, "|").trim();
    if (!line || line === "无") continue;
    const parts = line.split("|").map((part) => part.trim());
    if (parts[0] === "A" && parts.length >= 5) {
      const paragraph = parseParagraphId(parts[1]);
      const quote = parts[2];
      const message = parts[3];
      const suggestion = parts[4];
      if (paragraph === null || quote.length < 4 || quote.length > 40 || !message) continue;
      findings.push({
        kind: "grammar",
        paragraphs: [paragraph],
        quotes: [quote],
        message,
        suggestion: suggestion && suggestion !== quote ? suggestion : undefined,
      });
    } else if (parts[0] === "B" && parts.length >= 6) {
      const firstParagraph = parseParagraphId(parts[1]);
      const firstQuote = parts[2];
      const secondParagraph = parseParagraphId(parts[3]);
      const secondQuote = parts[4];
      const message = parts[5];
      if (
        firstParagraph === null ||
        secondParagraph === null ||
        firstQuote.length < 4 ||
        firstQuote.length > 30 ||
        secondQuote.length < 4 ||
        secondQuote.length > 30 ||
        !message
      ) continue;
      findings.push({
        kind: "monotony",
        paragraphs: [firstParagraph, secondParagraph],
        quotes: [firstQuote, secondQuote],
        message,
      });
    }
    if (findings.length >= clampFindingLimit(maxFindings)) break;
  }
  return findings;
}

/* ════════════════════════════ 引用定位 ════════════════════════════ */

const IGNORABLE = /[\s，。！？；：、“”‘’「」『』（）()《》〈〉【】…—\-·,.!?;:'"~～]/u;

function normalize(text: string): string {
  let chars = "";
  for (const ch of text) {
    if (IGNORABLE.test(ch)) continue;
    chars += ch;
  }
  return chars;
}

/** 段内精确定位器；引用只按连续原文匹配，不尝试近似/全窗口兜底。 */
export class QuoteLocator {
  constructor(
    private readonly text: string,
    private readonly base: number,
  ) {}

  /** 找一处；`from` 之后优先（用于同一段的多处相同引用）。找不到返回 null。 */
  locate(quote: string, from = 0): IssueRange | null {
    const q = quote.trim();
    if (q.length < 2) return null;
    const exact = this.text.indexOf(q, from);
    return exact === -1 ? null : this.abs(exact, exact + q.length);
  }

  /** 同一段引用在文中的所有精确出现，最多 limit 处。 */
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
}

/* ════════════════════════════ 结果 → Issue ════════════════════════════ */

export function issueKey(kind: IssueKind, quotes: readonly string[], paragraphs: readonly number[] = []): string {
  const location = paragraphs.length > 0 ? `${paragraphs.join(",")}@` : "";
  return `${kind}:${location}${quotes.map((q) => normalize(q)).join("‖")}`;
}

/**
 * 只在模型指定段落内定位短引文；不再对整个窗口做全局搜索。
 * 不使用规范化/LCS 兜底；错误段号、错引文和无法精确匹配的行都会被丢弃。
 */
export function findingsToIssues(
  findings: Finding[],
  paragraphs: readonly NumberedProofParagraph[],
  windowStart: number,
): Issue[] {
  const paragraphById = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const issues: Issue[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const targets = finding.paragraphs.map((id) => paragraphById.get(id));
    if (targets.length !== finding.quotes.length || targets.some((target) => !target)) continue;
    const ranges: IssueRange[] = [];

    for (let index = 0; index < finding.quotes.length; index += 1) {
      const paragraph = targets[index];
      if (!paragraph) break;
      const base = windowStart + paragraph.start;
      const locator = new QuoteLocator(paragraph.text, base);
      const from = index > 0 && targets[index - 1]?.id === paragraph.id && ranges[index - 1]
        ? ranges[index - 1].end - base
        : 0;
      const exactQuote = finding.quotes[index].trim();
      // 用户约定原文片段必须精确；不使用全窗/模糊兜底把错引文锚到别处。
      if (paragraph.text.indexOf(exactQuote, from) < 0) break;
      const range = locator.locate(exactQuote, from);
      if (!range) break;
      ranges.push(range);
    }
    if (ranges.length !== finding.quotes.length) continue;

    const key = issueKey(finding.kind, finding.quotes, finding.paragraphs);
    if (seen.has(key)) continue;
    seen.add(key);
    const firstParagraph = targets[0];
    if (!firstParagraph) continue;
    const quote = firstParagraph.text.slice(ranges[0].start - (windowStart + firstParagraph.start), ranges[0].end - (windowStart + firstParagraph.start));
    issues.push({
      id: crypto.randomUUID(),
      kind: finding.kind,
      source: "llm",
      ranges: dedupeRanges(ranges),
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

/** Map issue ranges through a precise programmatic edit (chapter insertion/renumbering), dropping changed quote text. */
export function mapIssuesThroughOffsetMap(
  issues: Issue[],
  oldText: string,
  newText: string,
  mapOffset: (offset: number) => number,
): Issue[] {
  if (oldText === newText) return issues;
  const out: Issue[] = [];
  for (const issue of issues) {
    let touched = false;
    const ranges = issue.ranges.map((range) => {
      const start = Math.max(0, Math.min(newText.length, Math.floor(mapOffset(range.start))));
      const end = Math.max(start, Math.min(newText.length, Math.floor(mapOffset(range.end))));
      if (end <= start || oldText.slice(range.start, range.end) !== newText.slice(start, end)) touched = true;
      return { start, end };
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
