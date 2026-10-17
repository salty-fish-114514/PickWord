/**
 * 角色卡 / 设定条目在编辑器里的三件事：
 *   ① 命中检测 —— 哪些卡片的名字（或别名）出现在送入模型的正文窗口里；
 *   ② 注入文本 —— 把命中的卡片压成一段紧凑的「人物与设定」文本，放进提示词；
 *   ③ 候选提取 —— 从正文里找高频的 2~4 字片段，帮作者快速建卡（纯本地统计，不调模型）。
 *
 * 注入放在大纲之前、正文之后的位置之外（见 promptBuilder.assemble），所以命中集合一变，
 * 正文的 KV 缓存就要重算。为了少折腾，命中集合是「黏性」的：窗口起点不动时只增不减，
 * 新角色出场才会触发一次重算（与滑窗推进 / 锚点变化本来就会触发的重算同级）。
 */

import type { CharacterCard, LoreEntry, Materials } from "./types";

/* ───────── ① 命中检测 ───────── */

export interface MaterialHit {
  kind: "character" | "lore";
  id: string;
  name: string;
  /** 在窗口正文里出现的次数（名字 + 别名合计）。 */
  count: number;
  /** 首次出现的偏移（相对全文），用于按出场顺序排序。 */
  first: number;
}

function namesOf(card: { name: string; aliases: string[] }): string[] {
  const names = [card.name, ...card.aliases].map((n) => n.trim()).filter((n) => n.length > 0);
  return [...new Set(names)];
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 一张卡片的所有称呼合起来数一遍：按长度降序做交替匹配，
 * 这样「林雨晴」不会同时被别名「雨晴」再数一次。
 */
function countOccurrences(haystack: string, names: string[]): { count: number; first: number } {
  if (names.length === 0 || !haystack) return { count: 0, first: -1 };
  const pattern = new RegExp([...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "g");
  let count = 0;
  let first = -1;
  for (const match of haystack.matchAll(pattern)) {
    if (first === -1) first = match.index;
    count += 1;
  }
  return { count, first };
}

/** 在 text[start, end) 里找出现过的卡片（只看 inject=true 且有名字的）。 */
export function findMaterialHits(materials: Materials, text: string, start: number, end: number): MaterialHit[] {
  const body = text.slice(Math.max(0, start), Math.max(start, end));
  if (!body) return [];
  const hits: MaterialHit[] = [];
  const scan = (kind: MaterialHit["kind"], cards: Array<CharacterCard | LoreEntry>) => {
    for (const card of cards) {
      if (!card.inject) continue;
      const { count, first } = countOccurrences(body, namesOf(card));
      if (count > 0) hits.push({ kind, id: card.id, name: card.name || card.aliases[0] || "", count, first: start + first });
    }
  };
  scan("character", materials.characters);
  scan("lore", materials.lore);
  return hits.sort((a, b) => a.first - b.first);
}

/** 每张卡片在全文各章节的提及次数（面板「提及」用），返回 Map<cardId, count>。 */
export function countMentions(cards: Array<CharacterCard | LoreEntry>, text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const card of cards) out.set(card.id, countOccurrences(text, namesOf(card)).count);
  return out;
}

/* ───────── ② 注入文本 ───────── */

/** 一次最多注入多少张卡、每张卡最多多少字（超出的从末尾截断，不改前面的文字以保住缓存）。 */
export const MAX_INJECTED_CARDS = 6;
export const MAX_CARD_CHARS = 400;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function characterCardText(card: CharacterCard): string {
  const parts: string[] = [];
  if (card.aliases.length > 0) parts.push(`别名：${card.aliases.join("、")}`);
  if (card.background.trim()) parts.push(`背景：${card.background.trim()}`);
  if (card.personality.trim()) parts.push(`性格：${card.personality.trim()}`);
  if (card.appearance.trim()) parts.push(`外观：${card.appearance.trim()}`);
  for (const field of card.extra) {
    if (field.text.trim()) parts.push(`${field.label.trim() || "补充"}：${field.text.trim()}`);
  }
  return clip(`${card.name}${parts.length > 0 ? "｜" : ""}${parts.join("；")}`, MAX_CARD_CHARS);
}

export function loreEntryText(entry: LoreEntry): string {
  const alias = entry.aliases.length > 0 ? `（${entry.aliases.join("、")}）` : "";
  return clip(`${entry.name}${alias}：${entry.text.trim()}`, MAX_CARD_CHARS);
}

/** 把命中的卡片拼成提示词里的「人物与设定」段；没有命中返回空串。 */
export function buildMaterialsText(materials: Materials, hits: MaterialHit[]): string {
  const picked = hits.slice(0, MAX_INJECTED_CARDS);
  const lines: string[] = [];
  for (const hit of picked) {
    if (hit.kind === "character") {
      const card = materials.characters.find((c) => c.id === hit.id);
      if (card) lines.push(characterCardText(card));
    } else {
      const entry = materials.lore.find((l) => l.id === hit.id);
      if (entry) lines.push(loreEntryText(entry));
    }
  }
  return lines.join("\n");
}

/**
 * 黏性命中集合：窗口起点没变时，旧命中保留、新命中追加；窗口起点变了就重算。
 * 返回新的集合（顺序稳定：先旧后新）。
 */
export function mergeStickyHits(previous: { bodyStart: number; hits: MaterialHit[] } | null, bodyStart: number, fresh: MaterialHit[]): MaterialHit[] {
  if (!previous || previous.bodyStart !== bodyStart) return fresh;
  const known = new Set(previous.hits.map((h) => `${h.kind}:${h.id}`));
  const merged = [...previous.hits];
  for (const hit of fresh) {
    const key = `${hit.kind}:${hit.id}`;
    if (!known.has(key)) {
      merged.push(hit);
      known.add(key);
    }
  }
  return merged;
}

/* ───────── ③ 候选提取 ───────── */

export interface ExtractedName {
  text: string;
  count: number;
}

/** 常见的高频非名字片段（量词、虚词组合），按需补充。 */
const STOP_FRAGMENTS = new Set([
  "我们", "你们", "他们", "她们", "自己", "什么", "这个", "那个", "这些", "那些", "一个", "一下", "一样", "一些",
  "没有", "不是", "就是", "但是", "可是", "还是", "只是", "已经", "可以", "知道", "觉得", "看着", "说道", "起来",
  "出来", "过来", "过去", "回来", "下来", "上来", "时候", "现在", "然后", "因为", "所以", "如果", "这样", "那样",
  "怎么", "为什么", "的时候", "一会儿", "一点", "有点", "一直", "一边", "一起", "不过", "而且", "虽然", "突然",
  "眼睛", "声音", "地方", "东西", "事情", "问题", "样子", "手里", "心里", "脸上", "身上", "头发", "嘴角",
]);

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * 统计 2~4 字的汉字片段出现次数，用「左右邻字多样性」过滤掉只是某个长词一部分的片段：
 * 真正的名字前后会接各种不同的字（「林雨说」「见到林雨」），而固定搭配的一部分前后总是同样的字。
 */
export function extractCandidateNames(text: string, known: Iterable<string>, minCount = 3, limit = 40): ExtractedName[] {
  // 第一遍只计数（Map<string, number>），取样 20 万字足够长篇用；
  // 第二遍只对达到次数门槛的片段统计左右邻字多样性，避免为几十万个一次性片段各建两个 Set。
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text;
  const length = sample.length;
  const counts = new Map<string, number>();

  const eachGram = (visit: (gram: string, at: number) => void) => {
    for (let i = 0; i < length; i += 1) {
      if (!CJK.test(sample[i])) continue;
      for (let n = 2; n <= 4; n += 1) {
        if (i + n > length || !CJK.test(sample[i + n - 1])) break; // 遇到非汉字就不再延长
        visit(sample.slice(i, i + n), i);
      }
    }
  };

  eachGram((gram) => counts.set(gram, (counts.get(gram) ?? 0) + 1));

  const knownSet = new Set(Array.from(known, (k) => k.trim()).filter(Boolean));
  const neighbors = new Map<string, { left: Set<string>; right: Set<string> }>();
  for (const [gram, count] of counts) {
    if (count >= minCount && !STOP_FRAGMENTS.has(gram) && !knownSet.has(gram)) {
      neighbors.set(gram, { left: new Set(), right: new Set() });
    }
  }
  counts.clear();
  if (neighbors.size === 0) return [];

  const candidateCounts = new Map<string, number>();
  eachGram((gram, at) => {
    const entry = neighbors.get(gram);
    if (!entry) return;
    candidateCounts.set(gram, (candidateCounts.get(gram) ?? 0) + 1);
    entry.left.add(at > 0 ? sample[at - 1] : "^");
    entry.right.add(at + gram.length < length ? sample[at + gram.length] : "$");
  });

  const results: ExtractedName[] = [];
  for (const [gram, entry] of neighbors) {
    const count = candidateCounts.get(gram) ?? 0;
    // 邻字多样性：左右至少有两种不同邻字（出现次数很多时要求更多）
    const need = count >= 10 ? 3 : 2;
    if (entry.left.size < need || entry.right.size < need) continue;
    results.push({ text: gram, count });
  }

  // 去掉被更长片段「包含且次数几乎相同」的短片段（「林雨」 vs 「林雨晴」）
  results.sort((a, b) => b.count - a.count || b.text.length - a.text.length);
  const kept: ExtractedName[] = [];
  for (const item of results) {
    const shadowed = kept.some(
      (k) => k.text.length > item.text.length && k.text.includes(item.text) && k.count >= item.count * 0.8,
    );
    const shadows = kept.findIndex(
      (k) => k.text.length < item.text.length && item.text.includes(k.text) && item.count >= k.count * 0.8,
    );
    if (shadowed) continue;
    if (shadows !== -1) kept.splice(shadows, 1);
    kept.push(item);
  }
  return kept.slice(0, limit);
}

/* ───────── 小工具 ───────── */

export function newCharacterCard(name: string): CharacterCard {
  return {
    id: crypto.randomUUID(),
    name,
    aliases: [],
    group: "main",
    background: "",
    personality: "",
    appearance: "",
    extra: [],
    inject: true,
  };
}

export function newLoreEntry(name: string, category: LoreEntry["category"] = "other"): LoreEntry {
  return { id: crypto.randomUUID(), name, aliases: [], category, text: "", inject: true };
}

export function parseAliases(raw: string): string[] {
  return [...new Set(raw.split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean))];
}
