import type { IconName } from "../Icon";

export type WorkbenchTab = "context" | "outline" | "characters" | "lore" | "proofread";

export const WORKBENCH_TABS: Array<{ id: WorkbenchTab; label: string; icon: IconName; eyebrow: string }> = [
  { id: "context", label: "上下文", icon: "sparkle", eyebrow: "送入模型的内容" },
  { id: "outline", label: "大纲", icon: "outline", eyebrow: "总纲与分章大纲" },
  { id: "characters", label: "角色", icon: "person", eyebrow: "人物卡片" },
  { id: "lore", label: "设定", icon: "lore", eyebrow: "地点 · 组织 · 物品" },
  { id: "proofread", label: "纠错", icon: "check", eyebrow: "语病 · 单调 · 重复" },
];
