/**
 * 偏好设置的定义、默认值与校验。
 *
 * 分两层：
 *   基本：作家一眼能懂的（每页候选数、触发延迟、自动保存周期、字号、主题、快速模式、浮窗常驻）
 *   高级：圈外作家不需要碰的（模型上下文长度、窗口、概率软化温度、EOS 阈值、淡化透明度、键位……）
 * 两层放在同一个对象里持久化，UI 上用「高级设置」页面分隔。
 */

import {
  DEFAULT_ANCHOR_WARN_LEN,
  DEFAULT_MAX_BODY_LEN,
  DEFAULT_MODEL_CONTEXT_LEN,
  DEFAULT_WINDOW_ADVANCE_MIN_CHARS,
} from "./promptBuilder";
import type { Theme } from "./types";

/** 「穿透键」：长按它让浮层淡出并放行所有按键。 */
export type PeekKey = "Tab" | "Shift" | "Alt" | "Control";
/** 「随机取词键」：浮层打开时按它按概率抽一个候选插入。 */
export type SampleKey = "Space" | "Backquote" | "Backslash" | "Off";

export const PEEK_KEY_LABEL: Record<PeekKey, string> = {
  Tab: "Tab（推荐）",
  Shift: "Shift",
  Alt: "Alt",
  Control: "Ctrl",
};

export const SAMPLE_KEY_LABEL: Record<SampleKey, string> = {
  Space: "空格",
  Backquote: "`（反引号）",
  Backslash: "\\（反斜杠）",
  Off: "关闭",
};

/** 浮层底栏、状态栏用的短标签。 */
export const PEEK_KEY_SHORT: Record<PeekKey, string> = {
  Tab: "Tab",
  Shift: "Shift",
  Alt: "Alt",
  Control: "Ctrl",
};

export const SAMPLE_KEY_SHORT: Record<SampleKey, string> = {
  Space: "空格",
  Backquote: "`",
  Backslash: "\\",
  Off: "",
};

export interface SettingsValues {
  /* ── 基本 ── */
  /** 每页显示几个候选（后端固定返回 100 个，这里只影响分页）。 */
  candidateCount: number;
  /** 普通模式下，停止输入多少毫秒后请求候选。 */
  triggerDelay: number;
  /** 自动保存周期（毫秒）。 */
  autoSaveInterval: number;
  /** 自动保存开关。顶栏的开关直接改它，所以退出前关掉、下次启动仍是关的。 */
  autoSaveEnabled: boolean;
  fontSize: number;
  /** 编辑器正文字体（本机字体族名；空串 = 默认衬线）。只影响显示，不写进文稿、不进提示词。 */
  fontFamily: string;
  theme: Theme;
  /** 快速模式：浮层常驻、零延迟。 */
  quickMode: boolean;
  /**
   * 浮窗常驻：开启后，用输入法组字时浮窗不会关闭，只会淡化（并且不拦截任何按键）；
   * 组字结束后自动恢复并刷新。关闭时组字会立刻收起浮窗。
   */
  keepPopover: boolean;
  /** 短句展开：开启后长按随机取词键，浮窗里的候选依次长成短句。 */
  expandEnabled: boolean;
  /** 停笔后自动展开：停够 expandIdleMs 且候选已就绪，就自动开始展开（不必长按）。 */
  expandAuto: boolean;
  /** 停笔多久后开始自动展开（毫秒）。最小档 250 ≈ 候选一出就展开。 */
  expandIdleMs: number;
  /** 纠错：停笔后自动把新写的窗口送去检查（需要 ≥ 2 个槽位）。 */
  proofreadAuto: boolean;
  /** 纠错：本地的重复 / 开头雷同 / 专名写法提示（不花算力）。 */
  proofreadLocal: boolean;
  /** 人设校验：纠错跑完同一窗口后顺带校验命中的角色卡（≥ 3 槽位时并行，否则排在纠错后面）。 */
  consistencyAuto: boolean;

  /* ── 高级 ── */
  /**
   * 模型上下文长度（token）。应与 llama-server 的 -c 一致。
   * 前端按「1 字 = 1 token」最保守估算，据此推出锚点模式的正文硬上限。
   */
  modelContextLen: number;
  /** 无锚点时，正文窗口的上限字符数。 */
  maxBodyLen: number;
  /** 滑动窗口推进前至少要新写多少字（保护 KV cache）。 */
  windowAdvanceMinChars: number;
  /** 锚点模式下，正文超过多少字开始提醒「过长」。 */
  anchorWarnLen: number;
  /** 概率软化温度：越大分布越平，低频词的百分比越「好看」。 */
  softenTemperature: number;
  /** 在候选的前 N 个里扫描终止符。 */
  eosScanTopN: number;
  /**
   * 终止符的「软化后概率」至少要达到这个值（0~1）才算一次命中。
   * 原始 softmax 下 EOS 常年在 0.x% 徘徊，软化后更能反映它的相对排名；
   * 低于这个阈值说明模型只是「想到了收尾」而不是「觉得该收尾了」。
   */
  eosMinProb: number;
  /** 连续命中终止符多少次后弹提醒。 */
  eosThreshold: number;
  /**
   * 重算上下文的预计耗时超过多少秒才在界面上提示（0 = 总是提示）。
   * 小于它的重算对作者几乎无感，不值得打扰。
   */
  prefillHintSeconds: number;
  /** 浮窗被淡化（长按穿透键 / 组字时保留）时的不透明度，0.05~0.6。 */
  fadeOpacity: number;
  /** 穿透键。 */
  peekKey: PeekKey;
  /** 长按多少毫秒算「长按」。 */
  peekHoldMs: number;
  /** 随机取词键。 */
  sampleKey: SampleKey;
}

/**
 * ★ 所有设置的默认值都在这里；每一项允许的取值范围在 SETTING_LIMITS 里，
 *   sanitizeSettings() 与设置面板的滑杆共用同一份范围，不会再出现两处不一致。
 *   上下文窗口相关的默认常量（DEFAULT_MAX_BODY_LEN 等）定义在 promptBuilder.ts 顶部。
 */
export const DEFAULT_SETTINGS: SettingsValues = {
  candidateCount: 5,
  triggerDelay: 450,
  autoSaveInterval: 3000,
  autoSaveEnabled: true,
  fontSize: 18,
  fontFamily: "",
  theme: "light",
  quickMode: false,
  keepPopover: false,
  expandEnabled: true,
  expandAuto: true,
  expandIdleMs: 2000,
  proofreadAuto: true,
  proofreadLocal: true,
  consistencyAuto: false,

  modelContextLen: DEFAULT_MODEL_CONTEXT_LEN,
  maxBodyLen: DEFAULT_MAX_BODY_LEN,
  windowAdvanceMinChars: DEFAULT_WINDOW_ADVANCE_MIN_CHARS,
  anchorWarnLen: DEFAULT_ANCHOR_WARN_LEN,
  softenTemperature: 2.2,
  eosScanTopN: 20,
  eosMinProb: 0.1,
  eosThreshold: 3,
  prefillHintSeconds: 5,
  fadeOpacity: 0.12,
  peekKey: "Tab",
  peekHoldMs: 260,
  sampleKey: "Space",
};

/** 数值型设置的允许范围（sanitize 与设置面板滑杆共用）。 */
export const SETTING_LIMITS = {
  candidateCount: { min: 3, max: 10, step: 1 },
  triggerDelay: { min: 200, max: 1000, step: 50 },
  expandIdleMs: { min: 250, max: 10000, step: 250 },
  autoSaveInterval: { min: 1000, max: 30000, step: 1000 },
  fontSize: { min: 16, max: 22, step: 1 },
  modelContextLen: { min: 4096, max: 131072, step: 2048 },
  maxBodyLen: { min: 4000, max: 20000, step: 1000 },
  windowAdvanceMinChars: { min: 100, max: 1000, step: 50 },
  anchorWarnLen: { min: 2000, max: 10000, step: 500 },
  softenTemperature: { min: 1, max: 4, step: 0.1 },
  eosScanTopN: { min: 5, max: 50, step: 5 },
  eosMinProb: { min: 0, max: 0.6, step: 0.01 },
  eosThreshold: { min: 1, max: 10, step: 1 },
  prefillHintSeconds: { min: 0, max: 60, step: 1 },
  fadeOpacity: { min: 0.05, max: 0.6, step: 0.01 },
  peekHoldMs: { min: 150, max: 600, step: 10 },
} as const satisfies Record<string, { min: number; max: number; step: number }>;

export type NumericSettingKey = keyof typeof SETTING_LIMITS;

const PEEK_KEYS: readonly PeekKey[] = ["Tab", "Shift", "Alt", "Control"];
const SAMPLE_KEYS: readonly SampleKey[] = ["Space", "Backquote", "Backslash", "Off"];

/** 类型守卫：运行时检查一个未知值是不是合法的 PeekKey（读 localStorage 时需要）。 */
export function isPeekKey(value: unknown): value is PeekKey {
  return typeof value === "string" && (PEEK_KEYS as readonly string[]).includes(value);
}

export function isSampleKey(value: unknown): value is SampleKey {
  return typeof value === "string" && (SAMPLE_KEYS as readonly string[]).includes(value);
}

/** font-family 里不允许出现的字符：双引号（0x22）、单引号（0x27）、反斜杠（0x5c）。 */
const FONT_FAMILY_FORBIDDEN = new Set([0x22, 0x27, 0x5c]);

/**
 * 字体族名最终只会作为一个带引号的字体名拼进 font-family，所以在这里清掉引号 / 反斜杠 /
 * 控制字符（用码点判断，避免转义层级）；长得不像正常字体名的直接退回默认。
 */
export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f && !FONT_FAMILY_FORBIDDEN.has(code);
    })
    .join("")
    .trim();
  return cleaned.length > 48 ? "" : cleaned;
}

/**
 * 按 SETTING_LIMITS 现算某个数值设置的可选值（min → max，步长 step，例如字号 16…22 每格 1）。
 * 下拉列表用它，范围一旦调整，界面会自动跟着变；当前值不在格点上时补进去，避免列表里没有选中项。
 */
export function numericOptions(key: NumericSettingKey, current?: number): number[] {
  const { min, max, step } = SETTING_LIMITS[key];
  const decimals = (String(step).split(".")[1] ?? "").length;
  const values: number[] = [];
  for (let value = min; value <= max + step / 1000; value += step) values.push(Number(value.toFixed(decimals)));
  if (current !== undefined && !values.includes(current)) values.push(current);
  return values.sort((a, b) => a - b);
}

/** 把任意值收敛成该设置项允许范围内的有限数字，不合法就用默认值。 */
function clampNumber(value: unknown, key: NumericSettingKey): number {
  const { min, max } = SETTING_LIMITS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * 把从存储里读出来的「可能不完整 / 可能被旧版本写坏」的对象，修成一份合法设置。
 * 永远不要信任持久化数据的形状 —— 这和 C 里读文件后要校验每个字段是一个道理。
 */
export function sanitizeSettings(raw: unknown): SettingsValues {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    candidateCount: Math.round(clampNumber(source.candidateCount, "candidateCount")),
    triggerDelay: clampNumber(source.triggerDelay, "triggerDelay"),
    autoSaveInterval: clampNumber(source.autoSaveInterval, "autoSaveInterval"),
    // 旧版设置里没有这个字段时按「开启」处理，不要让升级后的用户突然失去自动保存。
    autoSaveEnabled: source.autoSaveEnabled !== false,
    fontSize: clampNumber(source.fontSize, "fontSize"),
    fontFamily: sanitizeFontFamily(source.fontFamily),
    theme: source.theme === "dark" ? "dark" : "light",
    quickMode: source.quickMode === true,
    keepPopover: source.keepPopover === true,
    expandEnabled: source.expandEnabled !== false,
    expandIdleMs: clampNumber(source.expandIdleMs, "expandIdleMs"),
    // 以下三项的默认值 = 「中」档（见 TIER_PRESETS）；旧版设置里没有时按默认处理
    expandAuto: source.expandAuto !== false,
    proofreadAuto: source.proofreadAuto !== false,
    proofreadLocal: source.proofreadLocal !== false,
    consistencyAuto: source.consistencyAuto === true,

    modelContextLen: Math.round(clampNumber(source.modelContextLen, "modelContextLen")),
    maxBodyLen: clampNumber(source.maxBodyLen, "maxBodyLen"),
    windowAdvanceMinChars: clampNumber(source.windowAdvanceMinChars, "windowAdvanceMinChars"),
    anchorWarnLen: clampNumber(source.anchorWarnLen, "anchorWarnLen"),
    softenTemperature: clampNumber(source.softenTemperature, "softenTemperature"),
    eosScanTopN: Math.round(clampNumber(source.eosScanTopN, "eosScanTopN")),
    eosMinProb: clampNumber(source.eosMinProb, "eosMinProb"),
    eosThreshold: Math.round(clampNumber(source.eosThreshold, "eosThreshold")),
    prefillHintSeconds: clampNumber(source.prefillHintSeconds, "prefillHintSeconds"),
    fadeOpacity: clampNumber(source.fadeOpacity, "fadeOpacity"),
    peekKey: isPeekKey(source.peekKey) ? source.peekKey : d.peekKey,
    peekHoldMs: clampNumber(source.peekHoldMs, "peekHoldMs"),
    sampleKey: isSampleKey(source.sampleKey) ? source.sampleKey : d.sampleKey,
  };
}

/* ── 算力档位（plan.md §2.6）：一个总开关替作者把几个自动项一起拨好；单项仍可再改，改了就显示「自定义」 ── */

export type ComputeTier = "low" | "mid" | "high";

export type TierKey = "expandAuto" | "expandIdleMs" | "proofreadAuto" | "consistencyAuto";

export const TIER_PRESETS: Record<ComputeTier, Pick<SettingsValues, TierKey>> = {
  low: { expandAuto: false, expandIdleMs: 2000, proofreadAuto: false, consistencyAuto: false },
  mid: { expandAuto: true, expandIdleMs: 2000, proofreadAuto: true, consistencyAuto: false },
  high: { expandAuto: true, expandIdleMs: 250, proofreadAuto: true, consistencyAuto: true },
};

/** 各档位建议的 llama-server 槽位数（槽 0 候选 + 展开，槽 1 纠错，槽 2 人设校验）。 */
export const TIER_SLOTS: Record<ComputeTier, number> = { low: 2, mid: 2, high: 3 };

export const TIER_LABEL: Record<ComputeTier, string> = { low: "低", mid: "中", high: "高" };

/** 当前三个开关对应哪一档；都对不上就是自定义（expandIdleMs 不参与判断）。 */
export function detectTier(values: Pick<SettingsValues, TierKey>): ComputeTier | "custom" {
  for (const tier of ["low", "mid", "high"] as const) {
    const preset = TIER_PRESETS[tier];
    if (
      preset.expandAuto === values.expandAuto &&
      preset.proofreadAuto === values.proofreadAuto &&
      preset.consistencyAuto === values.consistencyAuto
    ) {
      return tier;
    }
  }
  return "custom";
}

/** 从 localStorage 读取设置；读不到或解析失败都回退默认值。 */
export function loadSettings(storageKey: string): SettingsValues {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_SETTINGS;
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** 判断一次 keydown 的 event.key 是否就是配置的随机取词键。 */
export function matchesSampleKey(eventKey: string, sampleKey: SampleKey): boolean {
  switch (sampleKey) {
    case "Space":
      return eventKey === " ";
    case "Backquote":
      return eventKey === "`";
    case "Backslash":
      return eventKey === "\\";
    case "Off":
      return false;
  }
}
