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

/**
 * 长按触发的键。两个功能各自绑一个（隐藏浮窗 / 展开短句），短按一律当普通按键输入正文。
 * "Off" = 不绑定（隐藏浮窗还能用 Esc 收起；展开还能靠停笔自动与右键菜单）。
 */
export type HoldKey = "Space" | "Tab" | "Backslash" | "Off";

export const HOLD_KEY_LABEL: Record<HoldKey, string> = {
  Space: "空格（推荐）",
  Tab: "Tab",
  Backslash: "\\（反斜杠）",
  Off: "不绑定",
};

/** 随机取词键的选项：默认不绑定，作者自己绑了才有这个功能。 */
export const SAMPLE_KEY_LABEL: Record<HoldKey, string> = {
  Off: "不绑定（默认）",
  Space: "空格",
  Tab: "Tab",
  Backslash: "\\（反斜杠）",
};

/** 浮层底栏、状态栏用的短标签。 */
export const HOLD_KEY_SHORT: Record<HoldKey, string> = {
  Space: "空格",
  Tab: "Tab",
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
  /** 短句展开：开启后长按「展开键」，浮窗里的候选依次长成短句。 */
  expandEnabled: boolean;
  /** 停笔后自动展开：停够 expandIdleMs 且候选已就绪，就自动开始展开（不必长按）。 */
  expandAuto: boolean;
  /** 停笔多久后开始自动展开（毫秒）。最小档 250 ≈ 候选一出就展开。 */
  expandIdleMs: number;
  /** 纠错：停笔后自动把新写的窗口送去检查（需要 ≥ 2 个槽位）。 */
  proofreadAuto: boolean;
  /** 纠错：本地的重复 / 开头雷同 / 专名写法提示（不花算力）。 */
  proofreadLocal: boolean;

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
  /** 浮窗被淡化（长按隐藏浮窗键 / 「浮窗常驻」时输入法组字）的不透明度，0.05~0.6。 */
  fadeOpacity: number;
  /** 长按隐藏浮窗的键：按住期间浮窗走「浮窗淡化」（淡到 fadeOpacity 并让出鼠标）、按键全部放行，松开就恢复；短按照常输入这个键本身。 */
  hideKey: HoldKey;
  /** 长按多少毫秒算「长按」（隐藏浮窗与展开短句共用）。 */
  holdMs: number;
  /** 长按展开短句的键：按住到点就把当前页的候选逐行展开成短句；短按照常输入这个键本身。 */
  expandKey: HoldKey;
  /**
   * 随机取词键：浮窗打开时按它，按（软化后的）概率从全部候选里抽一个插入。
   * 默认不绑定——绑了才有这个功能；绑到长按键上时短按=取词、长按仍是隐藏/展开。
   */
  sampleKey: HoldKey;
}

/**
 * ★ 所有设置的默认值都在这里；每一项允许的取值范围在 SETTING_LIMITS 里，
 *   sanitizeSettings() 与设置面板的滑杆共用同一份范围，不会再出现两处不一致。
 *   上下文窗口相关的默认常量（DEFAULT_MAX_BODY_LEN 等）定义在 promptBuilder.ts 顶部。
 */
export const DEFAULT_SETTINGS: SettingsValues = {
  candidateCount: 5,
  // 预设管的六项默认 = 「静默」（WRITING_PRESETS.quiet）：新装即一套完整预设，不显示「自定义」。
  triggerDelay: 8000,
  autoSaveInterval: 3000,
  autoSaveEnabled: true,
  fontSize: 18,
  fontFamily: "",
  theme: "light",
  quickMode: false,
  keepPopover: false,
  expandEnabled: true,
  expandAuto: true,
  expandIdleMs: 30000,
  proofreadAuto: false,
  proofreadLocal: true,

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
  hideKey: "Space",
  holdMs: 260,
  expandKey: "Tab",
  sampleKey: "Off",
};

/** 数值型设置的允许范围（sanitize 与设置面板滑杆共用）。 */
export const SETTING_LIMITS = {
  candidateCount: { min: 3, max: 10, step: 1 },
  triggerDelay: { min: 200, max: 10000, step: 200 },
  expandIdleMs: { min: 250, max: 60000, step: 250 },
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
  holdMs: { min: 150, max: 600, step: 10 },
} as const satisfies Record<string, { min: number; max: number; step: number }>;

export type NumericSettingKey = keyof typeof SETTING_LIMITS;

const HOLD_KEYS: readonly HoldKey[] = ["Space", "Tab", "Backslash", "Off"];

/** 类型守卫：运行时检查一个未知值是不是合法的 HoldKey（读 localStorage 时需要）。 */
export function isHoldKey(value: unknown): value is HoldKey {
  return typeof value === "string" && (HOLD_KEYS as readonly string[]).includes(value);
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

/** 旧档的随机取词键：合法且不与两个长按键冲突才保留，否则回到「不绑定」。 */
function sanitizeSampleKey(raw: unknown, hideKey: HoldKey, expandKey: HoldKey): HoldKey {
  if (!isHoldKey(raw) || raw === "Off") return "Off";
  return raw === hideKey || raw === expandKey ? "Off" : raw;
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
    // 旧版设置里没有这些键时按 DEFAULT_SETTINGS（= 静默预设）处理
    expandAuto: source.expandAuto !== false,
    proofreadAuto: source.proofreadAuto === true,
    proofreadLocal: source.proofreadLocal !== false,

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
    hideKey: isHoldKey(source.hideKey) ? source.hideKey : d.hideKey,
    // 随机取词是「绑了才有」的功能：旧档的值若与隐藏/展开键撞车就直接关掉，避免短按语义打架。
    sampleKey: sanitizeSampleKey(source.sampleKey, isHoldKey(source.hideKey) ? source.hideKey : d.hideKey, isHoldKey(source.expandKey) ? source.expandKey : d.expandKey),
    // 旧版叫 peekHoldMs（穿透键长按判定）；升级后沿用作者的数值
    holdMs: clampNumber(source.holdMs ?? source.peekHoldMs, "holdMs"),
    expandKey: isHoldKey(source.expandKey) ? source.expandKey : d.expandKey,
  };
}

/* ── 写作节奏预设：一组选好的默认值，一键切换；之后仍可逐项调，调过任何一项就是「自定义」 ── */

export type PresetName = "quiet" | "engaged";

/** 预设管的六项；时间值存储仍是 ms，UI 一律按秒展示。 */
export type PresetKey = "triggerDelay" | "quickMode" | "keepPopover" | "expandAuto" | "expandIdleMs" | "proofreadAuto";

export const WRITING_PRESETS: Record<PresetName, Pick<SettingsValues, PresetKey>> = {
  /** 静默：停笔 8 秒才出候选、30 秒才展开、不自动纠错。 */
  quiet: { triggerDelay: 8000, quickMode: false, keepPopover: false, expandAuto: true, expandIdleMs: 30000, proofreadAuto: false },
  /** 高参与：停笔 0.2 秒就出候选、候选一出就展开、浮窗常驻、纠错常开。 */
  engaged: { triggerDelay: 200, quickMode: true, keepPopover: true, expandAuto: true, expandIdleMs: 250, proofreadAuto: true },
};

export const PRESET_LABEL: Record<PresetName, string> = { quiet: "静默", engaged: "高参与" };

/** 当前六项对应哪套预设；逐项全比（含数值），对不上就是自定义。不存预设名，机制与原档位一致。 */
export function detectPreset(values: Pick<SettingsValues, PresetKey>): PresetName | "custom" {
  for (const name of ["quiet", "engaged"] as const) {
    const preset = WRITING_PRESETS[name];
    if ((Object.keys(preset) as PresetKey[]).every((key) => preset[key] === values[key])) return name;
  }
  return "custom";
}

/** ms → 「N 秒」：整秒不带小数，0.2 / 0.25 这类保留有效位。 */
export function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))} 秒`;
}

/** 把一套预设逐项写入设置（值相同的项跳过，避免无谓落盘）。onChange 即设置面板那个逐项修改入口。 */
export function applyPreset(
  name: PresetName,
  values: Pick<SettingsValues, PresetKey>,
  onChange: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void,
): void {
  const preset = WRITING_PRESETS[name];
  for (const key of Object.keys(preset) as PresetKey[]) {
    if (values[key] !== preset[key]) onChange(key, preset[key] as SettingsValues[typeof key]);
  }
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

/** 判断一次 keydown / keyup 的 event.key 是否就是绑定的那个长按键。 */
export function matchesHoldKey(eventKey: string, key: HoldKey): boolean {
  switch (key) {
    case "Space":
      return eventKey === " ";
    case "Tab":
      return eventKey === "Tab";
    case "Backslash":
      return eventKey === "\\";
    case "Off":
      return false;
  }
}

/** 这个键短按时应该输入正文的字符（长按被功能吃掉，短按要补回来）。 */
export function holdKeyChar(key: HoldKey): string {
  switch (key) {
    case "Space":
      return " ";
    case "Tab":
      return "\t";case "Backslash":
      return "\\";
    case "Off":
      return "";
  }
}

/** 物理键码 -> HoldKey（IME 无关，适合长按判定）。 */
export const CODE_TO_HOLD_KEY: Record<string, HoldKey> = {
  Space: "Space",
  Tab: "Tab",
  Backslash: "Backslash",
};

/** 根据 event.code 判断是否为某个长按键（不受 IME 影响）。 */
export function matchesHoldKeyByCode(event: { code: string }, key: HoldKey): boolean {
  return CODE_TO_HOLD_KEY[event.code] === key;
}
