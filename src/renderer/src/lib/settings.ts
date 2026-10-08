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
  theme: Theme;
  /** 快速模式：浮层常驻、零延迟。 */
  quickMode: boolean;
  /**
   * 浮窗常驻：开启后，用输入法组字时浮窗不会关闭，只会淡化（并且不拦截任何按键）；
   * 组字结束后自动恢复并刷新。关闭时组字会立刻收起浮窗。
   */
  keepPopover: boolean;

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
 * ★ 所有设置的默认值都在这里；每一项允许的取值范围在下面的 sanitizeSettings() 里
 *   （clampNumber 的 min/max 参数），设置面板滑杆的 min/max 在 SettingsPanel.tsx 里。
 *   三处要保持一致：默认值必须落在范围内，滑杆范围不要超过 sanitize 的范围。
 *   上下文窗口相关的默认常量（DEFAULT_MAX_BODY_LEN 等）定义在 promptBuilder.ts 顶部。
 */
export const DEFAULT_SETTINGS: SettingsValues = {
  candidateCount: 5,
  triggerDelay: 450,
  autoSaveInterval: 3000,
  autoSaveEnabled: true,
  fontSize: 18,
  theme: "light",
  quickMode: false,
  keepPopover: false,

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

const PEEK_KEYS: readonly PeekKey[] = ["Tab", "Shift", "Alt", "Control"];
const SAMPLE_KEYS: readonly SampleKey[] = ["Space", "Backquote", "Backslash", "Off"];

/** 类型守卫：运行时检查一个未知值是不是合法的 PeekKey（读 localStorage 时需要）。 */
export function isPeekKey(value: unknown): value is PeekKey {
  return typeof value === "string" && (PEEK_KEYS as readonly string[]).includes(value);
}

export function isSampleKey(value: unknown): value is SampleKey {
  return typeof value === "string" && (SAMPLE_KEYS as readonly string[]).includes(value);
}

/** 把任意值收敛成 [min, max] 之间的有限数字，不合法就用默认值。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
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
    candidateCount: Math.round(clampNumber(source.candidateCount, d.candidateCount, 3, 10)),
    triggerDelay: clampNumber(source.triggerDelay, d.triggerDelay, 200, 1000),
    autoSaveInterval: clampNumber(source.autoSaveInterval, d.autoSaveInterval, 1000, 30000),
    // 旧版设置里没有这个字段时按「开启」处理，不要让升级后的用户突然失去自动保存。
    autoSaveEnabled: source.autoSaveEnabled !== false,
    fontSize: clampNumber(source.fontSize, d.fontSize, 16, 22),
    theme: source.theme === "dark" ? "dark" : "light",
    quickMode: source.quickMode === true,
    keepPopover: source.keepPopover === true,

    modelContextLen: Math.round(clampNumber(source.modelContextLen, d.modelContextLen, 4096, 131072)),
    maxBodyLen: clampNumber(source.maxBodyLen, d.maxBodyLen, 4000, 20000),
    windowAdvanceMinChars: clampNumber(source.windowAdvanceMinChars, d.windowAdvanceMinChars, 100, 1000),
    anchorWarnLen: clampNumber(source.anchorWarnLen, d.anchorWarnLen, 2000, 10000),
    softenTemperature: clampNumber(source.softenTemperature, d.softenTemperature, 1, 4),
    eosScanTopN: Math.round(clampNumber(source.eosScanTopN, d.eosScanTopN, 5, 50)),
    eosMinProb: clampNumber(source.eosMinProb, d.eosMinProb, 0, 0.6),
    eosThreshold: Math.round(clampNumber(source.eosThreshold, d.eosThreshold, 1, 10)),
    prefillHintSeconds: clampNumber(source.prefillHintSeconds, d.prefillHintSeconds, 0, 60),
    fadeOpacity: clampNumber(source.fadeOpacity, d.fadeOpacity, 0.05, 0.6),
    peekKey: isPeekKey(source.peekKey) ? source.peekKey : d.peekKey,
    peekHoldMs: clampNumber(source.peekHoldMs, d.peekHoldMs, 150, 600),
    sampleKey: isSampleKey(source.sampleKey) ? source.sampleKey : d.sampleKey,
  };
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
