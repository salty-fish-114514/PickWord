/**
 * 角色卡 / 设定条目（统称「素材」）的数据结构与运行时校验。
 *
 * 主进程（旁车 / book.json 读写）、renderer（面板编辑、提示词注入）、浏览器演示文库三方共用，
 * 所以只放纯数据与纯函数，不 import 任何 Electron / DOM。
 *
 * 存放位置由主进程决定：长篇的所有卷共用 book.json 里的一份；独立短篇放在自己的 .writer.json。
 * 编辑器不关心这一点，素材随 DocumentPayload 一起读写。
 */

import type { OutlineSegment } from './ipc'

export type CharacterGroup = 'main' | 'minor'

export interface CustomField {
  label: string
  text: string
}

export interface CharacterCard {
  id: string
  name: string
  /** 别名 / 昵称 / 称谓，用于在正文里识别「这个角色出场了」。 */
  aliases: string[]
  group: CharacterGroup
  background: string
  personality: string
  appearance: string
  /** 作者自行追加的字段（「+」按钮）。 */
  extra: CustomField[]
  /** 是否允许注入提示词；关掉后只作为资料保存。 */
  inject: boolean
}

export type LoreCategory = 'place' | 'org' | 'item' | 'other'

export interface LoreEntry {
  id: string
  name: string
  aliases: string[]
  category: LoreCategory
  text: string
  inject: boolean
}

export interface Materials {
  characters: CharacterCard[]
  lore: LoreEntry[]
}

export const EMPTY_MATERIALS: Materials = { characters: [], lore: [] }

export const LORE_CATEGORY_LABEL: Record<LoreCategory, string> = {
  place: '地点',
  org: '组织',
  item: '物品',
  other: '其他'
}

export const CHARACTER_GROUP_LABEL: Record<CharacterGroup, string> = {
  main: '主要角色',
  minor: '次要角色'
}

/* ───────── 运行时校验 ───────── */

const MAX_CARDS = 2000
const MAX_FIELD = 20_000

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max = MAX_FIELD): string => (typeof v === 'string' ? v.slice(0, max) : '')
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 50) : []

function parseCharacter(raw: unknown): CharacterCard | null {
  if (!isObj(raw)) return null
  const id = str(raw.id, 100)
  if (!id) return null
  return {
    id,
    name: str(raw.name, 200),
    aliases: strList(raw.aliases),
    group: raw.group === 'minor' ? 'minor' : 'main',
    background: str(raw.background),
    personality: str(raw.personality),
    appearance: str(raw.appearance),
    extra: Array.isArray(raw.extra)
      ? raw.extra
          .filter(isObj)
          .map((f) => ({ label: str(f.label, 100), text: str(f.text) }))
          .slice(0, 30)
      : [],
    inject: raw.inject !== false
  }
}

function parseLore(raw: unknown): LoreEntry | null {
  if (!isObj(raw)) return null
  const id = str(raw.id, 100)
  if (!id) return null
  const c = raw.category
  return {
    id,
    name: str(raw.name, 200),
    aliases: strList(raw.aliases),
    category: c === 'place' || c === 'org' || c === 'item' ? c : 'other',
    text: str(raw.text),
    inject: raw.inject !== false
  }
}

/** 任意 JSON → 规范化的 Materials；缺失 / 损坏的部分退为空数组，绝不抛错。 */
export function parseMaterials(raw: unknown): Materials {
  if (!isObj(raw)) return { characters: [], lore: [] }
  const characters = Array.isArray(raw.characters)
    ? raw.characters.map(parseCharacter).filter((c): c is CharacterCard => c !== null).slice(0, MAX_CARDS)
    : []
  const lore = Array.isArray(raw.lore)
    ? raw.lore.map(parseLore).filter((l): l is LoreEntry => l !== null).slice(0, MAX_CARDS)
    : []
  return { characters, lore }
}

/** 分章大纲：{ 章标题: 大纲 }，过滤非字符串。 */
/** 大纲段（v5）。字段缺失返回 undefined（表示要迁移），存在但不合法按空数组。 */
export function parseOutlineSegments(raw: unknown): OutlineSegment[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) return []
  const out: OutlineSegment[] = []
  for (const item of raw) {
    if (!isObj(item) || !isObj(item.anchor)) continue
    const offset = item.anchor.offset
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) continue
    const id = typeof item.id === 'string' ? item.id.slice(0, 64) : ''
    if (!id) continue
    out.push({
      id,
      anchor: { offset, fingerprint: typeof item.anchor.fingerprint === 'string' ? item.anchor.fingerprint.slice(0, 64) : '' },
      text: typeof item.text === 'string' ? item.text.slice(0, MAX_FIELD) : '',
      inject: item.inject !== false
    })
    if (out.length >= 2000) break
  }
  return out
}

export function parseChapterOutlines(raw: unknown): Record<string, string> {
  if (!isObj(raw)) return {}
  const out: Record<string, string> = {}
  let n = 0
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !key) continue
    out[key.slice(0, 200)] = value.slice(0, MAX_FIELD)
    if (++n >= 5000) break
  }
  return out
}

export function isEmptyMaterials(m: Materials): boolean {
  return m.characters.length === 0 && m.lore.length === 0
}
