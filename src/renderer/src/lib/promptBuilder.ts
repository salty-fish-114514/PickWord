/**
 * PromptBuilder —— 提示词动态拼接器
 *
 * 职责（纯函数，不碰 React、不碰 DOM）：
 *   1. 决定「正文窗口」的左边界（body 从文档的哪个字符开始），
 *   2. 按「风格开关 / 大纲开关」四种组合拼出最终 prompt，
 *   3. 把过程中的让步与风险以 notices（提示文案）返回给 UI。
 *
 * 两种正文来源，互斥：
 *   ● 锚点模式（大纲开启 + 已锚定）：
 *       body = docText[anchor, cursor)。绝不截断、绝不启动滑动窗口；
 *       如果光标在锚点之前，正文为空，绝不退回去取锚点前的文字，
 *       过长时（默认 4500 字）给一条持续性提醒；
 *       超过「硬上限」（由模型上下文长度推出，见下）时，由 App 自动退出锚点模式。
 *   ● 滑动窗口模式（其余所有情况）：
 *       body = docText[windowStart, cursor)，窗口上限默认 12000 字，
 *       左边界「懒更新」以保护 llama.cpp 的 KV cache。它是独立的上下文策略，
 *       不使用锚点模式的正文硬上限。
 *
 * 硬上限（本轮新增）：
 *   按「1 个字 = 1 个 token」这个最保守的估算（Qwen 的分词器实际远比它高效，所以这是安全冗余）：
 *       锚点正文硬上限 = 模型上下文长度 − 输出预留 − 风格/大纲/模板占用的字数
 *   只有会不断累积的锚点正文受这个硬上限保护；滑窗有自己的 maxBodyLen，不与之混用。
 *
 * 为什么要单独成文件：这是整个产品里最容易出 bug、也最需要单独测试的逻辑。
 * 与 UI 解耦后，你可以直接在 Node 里 import 它写单元测试。
 */

/** 无锚点时正文窗口的默认上限（字符数）。Qwen 小模型 + 本地推理，10000~15000 是合理区间。 */
export const DEFAULT_MAX_BODY_LEN = 12000;

/**
 * 滑动窗口「懒更新」阈值：
 * 只有自上次更新以来又写了 ≥ 这么多字、并且光标正好落在换行之后，才允许移动左边界。
 * 这样 KV cache 能长时间复用，不会每敲一个字就 reprefill。
 */
export const DEFAULT_WINDOW_ADVANCE_MIN_CHARS = 300;

/** 锚点模式下，正文超过这个长度就开始提醒「过长」。 */
export const DEFAULT_ANCHOR_WARN_LEN = 4500;

/** 默认模型上下文长度（token）。应当与 llama-server 的 -c 参数一致。 */
export const DEFAULT_MODEL_CONTEXT_LEN = 16384;

/** 给模型输出（n_predict: 1）与特殊 token 预留的 token 数。 */
export const OUTPUT_RESERVE_TOKENS = 256;

/** 无论风格/大纲多长，正文预算至少保留这么多字，避免出现 0 或负数。 */
const MIN_BODY_BUDGET = 1000;

/** 四种拼接模式。plain = 纯续写（不套 ChatML），最像输入法。 */
export type PromptMode = "plain" | "outline" | "style" | "full";

/** 滑动窗口的可变状态，由 App 持有，每次编辑后交给本模块更新。 */
export interface SlidingWindowState {
  /** 当前窗口左边界在文档中的字符偏移。 */
  start: number;
  /** 自上次移动左边界以来，新写入的字符数（只统计净增长）。 */
  writtenSinceUpdate: number;
}

export interface BuildPromptArgs {
  /** 已开启且非空的风格参考文本；未开启传 undefined。 */
  styleText?: string;
  /** 已开启且非空的大纲文本；未开启传 undefined。 */
  outlineText?: string;
  /** 编辑器全文。 */
  docText: string;
  /** 光标位置（字符偏移）。 */
  cursorOffset: number;
  /** 大纲锚点的偏移；null / undefined 表示用户没锚定（必须照常工作）。 */
  anchorOffset?: number | null;
  /** 滑动窗口左边界（由 App 维护）。 */
  windowStart?: number;
  /** 窗口上限，缺省用 DEFAULT_MAX_BODY_LEN。 */
  maxBodyLen?: number;
  /** 锚点模式过长提醒阈值，缺省用 DEFAULT_ANCHOR_WARN_LEN。 */
  anchorWarnLen?: number;
  /** 模型上下文长度（token），缺省用 DEFAULT_MODEL_CONTEXT_LEN。 */
  modelContextLen?: number;
}

export interface BuiltPrompt {
  /** 最终发给后端的字符串。 */
  prompt: string;
  /** 实际使用的模式，UI 用来显示「当前：纯续写 / 大纲 + 风格」。 */
  mode: PromptMode;
  /** 本次 body 在文档中的起止偏移（UI 用来给这段正文加浅背景）。 */
  bodyStart: number;
  bodyEnd: number;
  /** 本次是否处于锚点模式。 */
  anchored: boolean;
  /** 锚点正文已超过硬上限：本次 prompt 已按「无大纲、滑窗」兜底生成，App 应当退出锚点模式。 */
  anchorOverflow: boolean;
  /** 本次的正文硬上限（字符数，按 1 字 = 1 token 保守估算）。 */
  hardLimit: number;
  /** 非阻塞提示，比如「锚点正文过长」「大纲可能与正文不匹配」。 */
  notices: string[];
}

/** 大纲锚点在光标之后时的提示：正文临时改用光标前的滑动窗口。 */
export const ANCHOR_BEFORE_CURSOR_NOTICE =
  "光标位于锚点之前，本章正文暂时送不进去；已改用滑窗（只含光标前的文字）";

/* ════════════════════════════════════════════════════════════════
   一、四种模式的拼接
   ════════════════════════════════════════════════════════════════ */

/** 四种模式的 system 段落文案，集中放这里方便你后续调词。 */
const SYSTEM_OUTLINE = "根据给定大纲续写正文。直接输出正文，不要旁白、不要解释、不要确认语。";
const SYSTEM_STYLE = "请模仿下列文本的写作风格进行创作。直接输出正文，不要旁白、不要解释、不要确认语。";
const SYSTEM_FULL = "请模仿下列文本的写作风格，并根据给定大纲续写正文。直接输出正文，不要旁白、不要解释、不要确认语。";

/** 把空白字符串归一为 undefined，方便后面用「有没有值」判断开关。 */
function normalize(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 拼接核心：给定（已归一化的）风格 / 大纲 / 正文，返回 prompt 与模式。
 *
 * 模式 A（都不开）：直接返回正文，不套任何 ChatML 标签 —— KV cache 最干净。
 * 模式 B/C/D：按 Qwen ChatML 格式拼装，assistant 段以「正文：」结尾，让模型直接接着写。
 * 风格文本在 system 段最前面且不变，前缀缓存必然命中，所以它可以很长。
 */
function assemble(
  style: string | undefined,
  outline: string | undefined,
  body: string,
): { prompt: string; mode: PromptMode } {
  if (!style && !outline) return { prompt: body, mode: "plain" };

  if (outline && !style) {
    return {
      mode: "outline",
      prompt:
        `<|im_start|>system\n${SYSTEM_OUTLINE}<|im_end|>\n` +
        `<|im_start|>user\n请开始写作。<|im_end|>\n` +
        `<|im_start|>assistant\n大纲：\n${outline}\n\n正文：\n${body}`,
    };
  }

  if (style && !outline) {
    return {
      mode: "style",
      prompt:
        `<|im_start|>system\n${SYSTEM_STYLE}\n${style}<|im_end|>\n` +
        `<|im_start|>user\n请开始写作。<|im_end|>\n` +
        `<|im_start|>assistant\n正文：\n${body}`,
    };
  }

  return {
    mode: "full",
    prompt:
      `<|im_start|>system\n${SYSTEM_FULL}\n${style}<|im_end|>\n` +
      `<|im_start|>user\n请开始写作。<|im_end|>\n` +
      `<|im_start|>assistant\n大纲：\n${outline}\n\n正文：\n${body}`,
  };
}

/* ════════════════════════════════════════════════════════════════
   二、硬上限
   ════════════════════════════════════════════════════════════════ */

/** 风格 / 大纲 / 模板本身占用的字符数（= 正文为空时的 prompt 长度）。 */
export function promptOverheadChars(style?: string, outline?: string): number {
  return assemble(normalize(style), normalize(outline), "").prompt.length;
}

/** 正文硬上限（字符数）。 */
export function bodyHardLimit(modelContextLen: number, style?: string, outline?: string): number {
  return Math.max(
    MIN_BODY_BUDGET,
    modelContextLen - OUTPUT_RESERVE_TOKENS - promptOverheadChars(style, outline),
  );
}

function hardLimitFor(args: BuildPromptArgs): number {
  return bodyHardLimit(args.modelContextLen ?? DEFAULT_MODEL_CONTEXT_LEN, args.styleText, args.outlineText);
}

/** 滑动窗口自己的上限：只读滑窗设置，不套用锚点模式的正文硬上限。 */
export function slidingWindowMaxBodyLen(args: BuildPromptArgs): number {
  return args.maxBodyLen ?? DEFAULT_MAX_BODY_LEN;
}

/**
 * 锚点模式的正文是否已超过硬上限。
 * App 在每次编辑 / 光标移动后调用它；为真时清除锚点并关闭大纲，回退到滑窗。
 */
export function isAnchorOverflow(args: BuildPromptArgs): boolean {
  const outline = normalize(args.outlineText);
  const anchor = args.anchorOffset;
  if (!outline || typeof anchor !== "number" || !Number.isFinite(anchor) || anchor < 0) return false;

  const cursor = Math.max(0, Math.min(args.cursorOffset, args.docText.length));
  const safeAnchor = Math.min(anchor, args.docText.length);
  // 光标位于锚点之前时正文长度为 0，不算超限；但仍然是锚点模式，不能启用滑窗。
  if (cursor < safeAnchor) return false;
  return cursor - safeAnchor > hardLimitFor(args);
}

/* ════════════════════════════════════════════════════════════════
   三、段落对齐与滑动窗口
   ════════════════════════════════════════════════════════════════ */

/** 跳过一段文本开头的空行与空白，让窗口左边界落在真正的段首。 */
function skipLeadingBlank(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && (text[cursor] === "\n" || text[cursor] === "\r" || text[cursor] === " ")) {
    cursor += 1;
  }
  return cursor;
}

/**
 * 找到一个「段落对齐」的左边界：
 * 要求 cursorOffset - start <= maxBodyLen，同时 start 必须紧跟在某个换行之后。
 *
 * 如果从 target 到光标之间一个换行都没有（作者整章不分段），
 * 为了不切碎句子，退让为「保留这一整个完整段落」，此时长度可能超限。
 */
function findParagraphAlignedStart(
  docText: string,
  cursorOffset: number,
  maxBodyLen: number,
): { start: number; notice?: string } {
  const target = Math.max(0, cursorOffset - maxBodyLen);
  if (target === 0) return { start: 0 };

  // 从 target - 1 开始找换行：这样如果 target 本身就是段首（前一个字符是 \n），也能命中。
  const newlineIndex = docText.indexOf("\n", Math.max(0, target - 1));
  if (newlineIndex !== -1 && newlineIndex < cursorOffset) {
    return { start: skipLeadingBlank(docText, newlineIndex + 1) };
  }

  // 整段都没有换行：往前找这一段的段首，宁可超限也不切碎段落。
  const paragraphStart = docText.lastIndexOf("\n", Math.max(0, cursorOffset - 2)) + 1;
  return {
    start: paragraphStart,
    notice: "这一段尚未分段，为了不切碎句子，已完整保留当前段落，上下文略微超出上限。建议适当换行。",
  };
}

/**
 * 滑动窗口推进：决定「现在要不要丢弃最前面的旧段落」。
 *
 * 规则：
 *   - 光标跑到窗口左边界之前（跳回前文修改）→ 以光标为准重新对齐一个窗口；
 *   - 没超限 → 什么都不做；
 *   - 超限但「写得还不够多」或「光标不在换行后」→ 允许略微超限，继续复用 KV cache；
 *   - 超出一个硬上限（上限 + max(2×minChars, 600)）→ 立刻推进。
 *     这种情况只会在「大段粘贴」「打开新文件」或「从前文跳回末尾」时出现，
 *     此时 KV cache 本来就已失效，立刻推进没有额外代价；
 *   - 真要推进 → 一次性推进到严格 ≤ maxBodyLen，并且段落对齐。
 */
export function advanceSlidingWindow(
  docText: string,
  cursorOffset: number,
  state: SlidingWindowState,
  maxBodyLen: number = DEFAULT_MAX_BODY_LEN,
  minChars: number = DEFAULT_WINDOW_ADVANCE_MIN_CHARS,
): { state: SlidingWindowState; notice?: string } {
  const start = Math.max(0, state.start);

  if (cursorOffset < start) {
    const aligned = findParagraphAlignedStart(docText, cursorOffset, maxBodyLen);
    return { state: { start: aligned.start, writtenSinceUpdate: 0 }, notice: aligned.notice };
  }

  const length = cursorOffset - start;
  if (length <= maxBodyLen) {
    return { state: { start, writtenSinceUpdate: state.writtenSinceUpdate } };
  }

  const hardLimit = maxBodyLen + Math.max(2 * minChars, 600);
  const atLineBreak = docText[cursorOffset - 1] === "\n";
  if (length <= hardLimit && (state.writtenSinceUpdate < minChars || !atLineBreak)) {
    return { state: { start, writtenSinceUpdate: state.writtenSinceUpdate } };
  }

  const aligned = findParagraphAlignedStart(docText, cursorOffset, maxBodyLen);
  return {
    state: { start: Math.max(start, aligned.start), writtenSinceUpdate: 0 },
    notice: aligned.notice,
  };
}

/* ════════════════════════════════════════════════════════════════
   四、正文区间与主入口
   ════════════════════════════════════════════════════════════════ */

/**
 * 计算本次要送进 prompt 的正文区间。
 * 优先级：可用锚点范围 → 独立的滑动窗口 → 兜底「光标前滑窗上限字、段落对齐」。
 */
function resolveBodyRange(
  args: BuildPromptArgs,
  useOutline: boolean,
): { start: number; anchored: boolean; notices: string[] } {
  const maxBodyLen = slidingWindowMaxBodyLen(args);
  const warnLen = args.anchorWarnLen ?? DEFAULT_ANCHOR_WARN_LEN;
  const cursor = Math.max(0, Math.min(args.cursorOffset, args.docText.length));
  const anchor = args.anchorOffset;
  const notices: string[] = [];

  // ── 锚点模式：光标在锚点之后时只允许 [anchor, cursor) ──
  if (useOutline && typeof anchor === "number" && Number.isFinite(anchor) && anchor >= 0) {
    const safeAnchor = Math.min(anchor, args.docText.length);
    if (cursor < safeAnchor) {
      // 光标已回到锚点之前：大纲仍然可用，但本次正文改走独立滑窗，且严格止于光标。
      // 不能把锚点前的正文标成「锚点正文」，也不能把窗口起点误报为锚点。
      notices.push(ANCHOR_BEFORE_CURSOR_NOTICE);
    } else {
      const length = cursor - safeAnchor;
      if (length > warnLen) {
        notices.push(
          `本章正文已有 ${length} 字，超过建议的 ${warnLen} 字（硬上限约 ${hardLimitFor(args)} 字，超过后会自动退出锚点模式）。` +
            "锚点模式不会自动截断，过长会让每次预测变慢；可考虑在合适处收束本章，并把锚点重设到下一章起点。",
        );
      }
      return { start: safeAnchor, anchored: true, notices };
    }
  }

  if (useOutline && (anchor === null || anchor === undefined)) {
    notices.push("尚未锚定本章起点，已自动参考光标前最近的文字。若大纲与这段正文不匹配，辅助效果会变差。");
  }

  // ── 滑动窗口模式 ──
  const windowStart = args.windowStart;
  if (typeof windowStart === "number" && windowStart >= 0 && windowStart <= cursor) {
    if (cursor - windowStart > maxBodyLen) {
      notices.push(`上下文已略微超出 ${maxBodyLen} 字上限，待你写满一段并换行后会自动丢弃最前面的段落。`);
    }
    return { start: windowStart, anchored: false, notices };
  }

  const aligned = findParagraphAlignedStart(args.docText, cursor, maxBodyLen);
  if (aligned.notice) notices.push(aligned.notice);
  return { start: aligned.start, anchored: false, notices };
}

/**
 * 主入口：把前端状态拼成最终 prompt。
 *
 * 安全网：如果锚点正文已超过硬上限，这里**不会**把超长正文送出去，
 * 而是按「关闭大纲 + 滑窗」重新生成（anchorOverflow = true）。
 * 真正的状态清理（清除锚点、关闭大纲、给作者提示）由 App 完成，
 * 正常情况下 App 已经先一步处理，这里只是防止漏网。
 */
export function buildPrompt(args: BuildPromptArgs): BuiltPrompt {
  if (isAnchorOverflow(args)) {
    const fallback = buildPrompt({ ...args, outlineText: undefined, anchorOffset: null });
    return { ...fallback, anchorOverflow: true };
  }

  const style = normalize(args.styleText);
  const outline = normalize(args.outlineText);

  const { start, anchored, notices } = resolveBodyRange(args, Boolean(outline));
  const bodyEnd = Math.max(0, Math.min(args.cursorOffset, args.docText.length));
  const bodyStart = Math.min(Math.max(0, start), bodyEnd);
  const body = args.docText.slice(bodyStart, bodyEnd);

  const { prompt, mode } = assemble(style, outline, body);
  return {
    prompt,
    mode,
    bodyStart,
    bodyEnd,
    anchored,
    anchorOverflow: false,
    hardLimit: hardLimitFor(args),
    notices,
  };
}

/** 模式的中文名，状态栏 / 侧边栏直接用。 */
export const PROMPT_MODE_LABEL: Record<PromptMode, string> = {
  plain: "纯续写",
  outline: "大纲模式",
  style: "风格模式",
  full: "风格 + 大纲",
};
