/**
 * 多篇文稿文库。
 *
 * 目录：默认「文档/PickWord/manuscripts」（用户可见，卸载 / 升级不会被安装器删除）；
 *   可在设置里迁移到别处，配置存 userData/library-config.json。
 *   旧版本默认目录是 exe 同级 manuscripts，首次启动时若那里有文稿且尚无配置，自动搬到新默认目录。
 *
 * 目录布局：
 *   <文库>/<短篇>.txt + <短篇>.writer.json            —— 独立短篇（与 1.0 完全一致）
 *   <文库>/<书名>/book.json                             —— 一部长篇一个子目录
 *   <文库>/<书名>/<书名>_<N>卷.txt + .writer.json        —— 各卷，N 从 0 起
 *   book.json 保存全书共用的风格参考与角色 / 设定素材；卷旁车保存该卷自己的大纲、分章大纲、锚点。
 *   读卷时把 book.json 的字段并进 DocumentPayload，保存时再拆回去，编辑器不感知两者的差别。
 *
 * ID 策略：
 *   - 每篇文稿（短篇或一卷）的 ID 是旁车 .writer.json 里的 UUID，一旦生成永不变；长篇的 ID 在 book.json。
 *   - 短篇文件名跟随标题：保存/改名时若标题与文件名不符，自动重命名 <名>.txt + <名>.writer.json。
 *   - 卷文件名只跟随书名（改书名时整目录连带改名），卷标题只存旁车。
 *   - 没有旁车的孤立 .txt（用户手动丢进目录的）在扫描时自动补旁车 + UUID；
 *     子目录里只要有 `_N卷.txt` 就按长篇处理，缺 book.json 也会自动补。
 *
 * 其余约定：目录配置存 userData/library-config.json；删除走系统回收站；
 * 写入全部排队并原子落盘；不触碰旧 documents.ts 的 currentPath。
 */
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  Anchor,
  BookRef,
  DocumentPayload,
  LibraryDirectory,
  LibraryEntry,
  LibraryFormat,
  OutlineSegment
} from '../shared/ipc'
import {
  EMPTY_MATERIALS,
  parseChapterOutlines,
  parseMaterials,
  parseOutlineSegments,
  type Materials
} from '../shared/materials'
import {
  createSerializedQueue,
  isObj,
  parseAnchor,
  safeFileName,
  validateDocument,
  writeFileAtomic
} from './ioUtils'
import { countChars, makeExcerpt } from '../shared/text'

/**
 * v5：大纲段 outlineSegments（anchor / chapterOutlines 只读迁移、不再写）；
 * v4：chapterOutlines / materials（短篇）；v3 起缓存 excerpt / characterCount + 正文 mtime/size。
 */
const SIDECAR_VERSION = 5
const BOOK_VERSION = 1
const BOOK_FILE = 'book.json'
const CONFIG_FILE = (): string => path.join(app.getPath('userData'), 'library-config.json')

// 开发：项目根目录/manuscripts；打包：文档/PickWord/manuscripts
const defaultLibraryDir = (): string =>
  app.isPackaged
    ? path.join(app.getPath('documents'), 'PickWord', 'manuscripts')
    : path.join(app.getAppPath(), 'manuscripts')

/** 1.0.x 的默认目录（安装目录内，会被卸载 / 升级清掉）。 */
const legacyLibraryDir = (): string | null =>
  app.isPackaged ? path.join(path.dirname(process.execPath), 'manuscripts') : null

/* ───────── 小工具 ───────── */

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const toLF = (s: string): string => s.replace(/\r\n?/g, '\n')

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** base 是相对文库根的「不带扩展名的路径」：短篇 `标题`，卷 `书名/书名_0卷`。 */
const txtPath = (dir: string, base: string): string => path.join(dir, `${base}.txt`)
const sidecarPath = (dir: string, base: string): string => path.join(dir, `${base}.writer.json`)
const bookJsonPath = (dir: string, folder: string): string => path.join(dir, folder, BOOK_FILE)

const VOLUME_FILE_RE = /^(.*)_(\d+)卷$/
const volumeBase = (folder: string, volume: number): string =>
  path.join(folder, `${folder}_${volume}卷`)
const defaultVolumeTitle = (volume: number): string => `第${volume + 1}卷`

/** 找一个不与现有文件冲突的文件名：标题 → 标题 (2) → …。 */
async function uniqueBaseName(dir: string, base: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? base : `${base} (${n})`
    if (!(await exists(txtPath(dir, candidate))) && !(await exists(sidecarPath(dir, candidate)))) {
      return candidate
    }
  }
  throw new Error(`找不到不重名的文件名（${base}）`)
}

/** 长篇子目录名同理，不与任何同名文件 / 目录冲突。 */
async function uniqueFolderName(dir: string, folder: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? folder : `${folder} (${n})`
    if (!(await exists(path.join(dir, candidate)))) return candidate
  }
  throw new Error(`找不到不重名的目录名（${folder}）`)
}

/* ───────── 目录配置 ───────── */

async function readConfigFile(): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(CONFIG_FILE(), 'utf8'))
    if (isObj(parsed) && typeof parsed.libraryPath === 'string' && parsed.libraryPath) {
      return parsed.libraryPath
    }
  } catch {
    // 首次启动或配置损坏 → 默认目录
  }
  return null
}

async function hasManuscripts(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((n) => n.toLowerCase().endsWith('.txt'))
  } catch {
    return false
  }
}

/**
 * 决定文库目录（进程内只算一次）：
 *   有配置 → 用配置；无配置但旧默认目录里有文稿 → 搬到新默认目录；否则新默认目录。
 * 搬运失败时退回旧目录继续用（不丢稿），下次启动再试。
 */
async function resolveLibraryDir(): Promise<string> {
  const configured = await readConfigFile()
  if (configured) return configured

  const target = defaultLibraryDir()
  const legacy = legacyLibraryDir()
  if (legacy && path.resolve(legacy) !== path.resolve(target) && (await hasManuscripts(legacy))) {
    try {
      await migrateLibraryFiles(legacy, target)
    } catch (err) {
      console.warn('[library] 旧文库迁移失败，暂时继续使用旧目录：', (err as Error).message)
      return legacy
    }
  }
  return target
}

let libraryDir: Promise<string> | null = null

function readConfig(): Promise<string> {
  if (!libraryDir) libraryDir = resolveLibraryDir()
  return libraryDir
}

async function writeConfig(libraryPath: string): Promise<void> {
  await writeFileAtomic(CONFIG_FILE(), JSON.stringify({ libraryPath }))
  libraryDir = Promise.resolve(libraryPath)
}

/* ───────── 旁车 ───────── */

interface Sidecar {
  version: number
  id: string
  title: string
  sourceFormat: LibraryFormat
  updatedAt: number
  interactedAt: number
  styleText: string
  outlineText: string
  styleEnabled: boolean
  outlineEnabled: boolean
  /** v5：大纲段；缺省 = 旧旁车，交给 renderer 迁移。 */
  outlineSegments?: OutlineSegment[]
  /** ≤ v4 旧字段，只读。 */
  anchor: Anchor | null
  /** ≤ v4 旧字段（分章大纲），只读；短篇的素材也放旁车（长篇的在 book.json）。 */
  chapterOutlines: Record<string, string>
  materials: Materials
  /** v3 缓存：正文预览与字数，以及计算它们时正文文件的 mtime / size（用来判断缓存是否过期）。 */
  excerpt: string
  characterCount: number
  contentMtimeMs: number
  contentSize: number
  [key: string]: unknown // 保留未来版本的未知字段
}

function parseFormat(v: unknown): LibraryFormat {
  return v === 'md' || v === 'docx' ? v : 'txt'
}

/** 读旁车并规范化字段；文件不存在或损坏返回 null。 */
async function readSidecar(dir: string, base: string): Promise<Sidecar | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(sidecarPath(dir, base), 'utf8'))
    if (!isObj(parsed)) return null
    const now = Date.now()
    return {
      ...parsed,
      version: num(parsed.version, 0),
      id: str(parsed.id),
      title: str(parsed.title, path.basename(base)),
      sourceFormat: parseFormat(parsed.sourceFormat),
      updatedAt: num(parsed.updatedAt, now),
      interactedAt: num(parsed.interactedAt, now),
      styleText: str(parsed.styleText),
      outlineText: str(parsed.outlineText),
      styleEnabled: parsed.styleEnabled === true,
      outlineEnabled: parsed.outlineEnabled === true,
      outlineSegments: parseOutlineSegments(parsed.outlineSegments),
      anchor: parseAnchor(parsed.anchor),
      chapterOutlines: parseChapterOutlines(parsed.chapterOutlines),
      materials: parseMaterials(parsed.materials),
      excerpt: str(parsed.excerpt),
      characterCount: num(parsed.characterCount, -1),
      contentMtimeMs: num(parsed.contentMtimeMs, -1),
      contentSize: num(parsed.contentSize, -1)
    }
  } catch {
    return null
  }
}

/** 旁车里的预览 / 字数是否仍对应当前正文文件。 */
function cacheMatches(sc: Sidecar, stat: { mtimeMs: number; size: number }): boolean {
  return sc.characterCount >= 0 && sc.contentMtimeMs === stat.mtimeMs && sc.contentSize === stat.size
}

/** 用正文内容刷新旁车缓存字段；正文文件必须已经写好（要读它的 mtime / size）。 */
async function withContentCache(dir: string, base: string, sc: Sidecar, content: string): Promise<Sidecar> {
  const stat = await fs.stat(txtPath(dir, base))
  return {
    ...sc,
    excerpt: makeExcerpt(content),
    characterCount: countChars(content),
    contentMtimeMs: stat.mtimeMs,
    contentSize: stat.size
  }
}

async function writeSidecar(dir: string, base: string, sc: Sidecar): Promise<void> {
  await writeFileAtomic(
    sidecarPath(dir, base),
    JSON.stringify({ ...sc, version: Math.max(sc.version, SIDECAR_VERSION) }, null, 2)
  )
}

function freshSidecar(title: string, format: LibraryFormat, time: number): Sidecar {
  return {
    version: SIDECAR_VERSION,
    id: randomUUID(),
    title,
    sourceFormat: format,
    updatedAt: time,
    interactedAt: time,
    styleText: '',
    outlineText: '',
    styleEnabled: false,
    // 注入大纲段的总开关默认开着（新段默认注入），关掉它是「自由发挥」的一键
    outlineEnabled: true,
    outlineSegments: [],
    anchor: null,
    chapterOutlines: {},
    materials: EMPTY_MATERIALS,
    excerpt: '',
    characterCount: -1,
    contentMtimeMs: -1,
    contentSize: -1
  }
}

/* ───────── book.json ───────── */

interface BookJson {
  version: number
  id: string
  createdAt: number
  updatedAt: number
  styleText: string
  styleEnabled: boolean
  materials: Materials
  [key: string]: unknown
}

function freshBook(time: number): BookJson {
  return {
    version: BOOK_VERSION,
    id: randomUUID(),
    createdAt: time,
    updatedAt: time,
    styleText: '',
    styleEnabled: false,
    materials: EMPTY_MATERIALS
  }
}

async function readBookJson(dir: string, folder: string): Promise<BookJson | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(bookJsonPath(dir, folder), 'utf8'))
    if (!isObj(parsed)) return null
    const now = Date.now()
    return {
      ...parsed,
      version: num(parsed.version, 0),
      id: str(parsed.id),
      createdAt: num(parsed.createdAt, now),
      updatedAt: num(parsed.updatedAt, now),
      styleText: str(parsed.styleText),
      styleEnabled: parsed.styleEnabled === true,
      materials: parseMaterials(parsed.materials)
    }
  } catch {
    return null
  }
}

async function writeBookJson(dir: string, folder: string, book: BookJson): Promise<void> {
  await writeFileAtomic(
    bookJsonPath(dir, folder),
    JSON.stringify({ ...book, version: Math.max(book.version, BOOK_VERSION) }, null, 2)
  )
}

/** 子目录里所有卷：[{ volume, base }]，按卷序号升序。 */
async function listVolumeFiles(dir: string, folder: string): Promise<Array<{ volume: number; name: string }>> {
  let names: string[]
  try {
    names = await fs.readdir(path.join(dir, folder))
  } catch {
    return []
  }
  const volumes: Array<{ volume: number; name: string }> = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.txt')) continue
    const m = VOLUME_FILE_RE.exec(name.slice(0, -4))
    if (!m) continue
    volumes.push({ volume: Number(m[2]), name: name.slice(0, -4) })
  }
  return volumes.sort((a, b) => a.volume - b.volume)
}

/* ───────── 索引 ─────────
 * 内存里维护 id → 位置。扫描目录时重建；按 id 查不到时自动重扫一次。 */

interface Slot {
  /** 相对文库根、不带扩展名的路径。 */
  base: string
  /** 卷所属的长篇；短篇为 null。 */
  book: (BookRef & { folder: string }) | null
}

interface Located extends Slot {
  sc: Sidecar
}

let index: { dir: string; byId: Map<string, Slot>; books: Map<string, string> } = {
  dir: '',
  byId: new Map(),
  books: new Map()
}

function resetIndex(): void {
  index = { dir: '', byId: new Map(), books: new Map() }
}

function toEntry(sc: Sidecar, book: Slot['book']): LibraryEntry {
  const entry: LibraryEntry = {
    id: sc.id,
    title: sc.title,
    excerpt: sc.excerpt,
    sourceFormat: sc.sourceFormat,
    characterCount: Math.max(0, sc.characterCount),
    updatedAt: sc.updatedAt,
    interactedAt: sc.interactedAt
  }
  if (book) entry.book = { id: book.id, title: book.title, volume: book.volume }
  return entry
}

/**
 * 为一个 .txt 配对旁车；缺旁车、缺 id、id 重复或缓存过期的补写（不动正文）。
 * 只有旁车缓存与正文 mtime/size 不符时才读正文，几百篇文稿也只是几百次 stat。
 */
async function scanOne(
  dir: string,
  base: string,
  defaultTitle: string,
  usedIds: Set<string>
): Promise<Sidecar | null> {
  const stat = await fs.stat(txtPath(dir, base))
  if (!stat.isFile()) return null

  let sc = await readSidecar(dir, base)
  let dirty = false
  if (!sc) {
    sc = freshSidecar(defaultTitle, 'txt', stat.mtimeMs)
    dirty = true
  } else if (!sc.id || usedIds.has(sc.id)) {
    // 没有 id，或者用户复制了一份文件导致 id 重复 → 分配新 id
    sc = { ...sc, id: randomUUID() }
    dirty = true
  }
  if (!cacheMatches(sc, stat)) {
    const content = toLF(await fs.readFile(txtPath(dir, base), 'utf8'))
    sc = await withContentCache(dir, base, sc, content)
    dirty = true
  }
  if (dirty) await writeSidecar(dir, base, sc)
  usedIds.add(sc.id)
  return sc
}

/** 扫描整个文库：根目录 .txt 为短篇，含 `_N卷.txt` 的子目录为长篇。 */
async function scanLibrary(dir: string): Promise<LibraryEntry[]> {
  await fs.mkdir(dir, { recursive: true })
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries: LibraryEntry[] = []
  const byId = new Map<string, Slot>()
  const books = new Map<string, string>()
  const usedIds = new Set<string>()

  for (const dirent of dirents) {
    const name = dirent.name
    try {
      if (dirent.isFile() && name.toLowerCase().endsWith('.txt')) {
        const base = name.slice(0, -4)
        if (!base) continue
        const sc = await scanOne(dir, base, base, usedIds)
        if (!sc) continue
        byId.set(sc.id, { base, book: null })
        entries.push(toEntry(sc, null))
      } else if (dirent.isDirectory()) {
        const volumes = await listVolumeFiles(dir, name)
        if (volumes.length === 0) continue // 不是长篇目录（也可能是用户自己的文件夹）
        let book = await readBookJson(dir, name)
        if (!book || !book.id || books.has(book.id)) {
          book = { ...(book ?? freshBook(Date.now())), id: randomUUID() }
          await writeBookJson(dir, name, book)
        }
        books.set(book.id, name)
        for (const v of volumes) {
          const base = path.join(name, v.name)
          const sc = await scanOne(dir, base, defaultVolumeTitle(v.volume), usedIds)
          if (!sc) continue
          const slot: Slot = { base, book: { id: book.id, title: name, volume: v.volume, folder: name } }
          byId.set(sc.id, slot)
          entries.push(toEntry(sc, slot.book))
        }
      }
    } catch {
      // 单篇损坏不影响其余
    }
  }
  index = { dir, byId, books }
  return entries
}

/** 按 id 找到位置与旁车；索引没命中就重扫一次。 */
async function locate(dir: string, id: string): Promise<Located> {
  const tryOnce = async (): Promise<Located | null> => {
    if (index.dir !== dir) return null
    const slot = index.byId.get(id)
    if (!slot || !(await exists(txtPath(dir, slot.base)))) return null
    let sc = await readSidecar(dir, slot.base)
    if (!sc || sc.id !== id) return null
    // 用户在外部改过正文：顺手刷新缓存，保证改名 / touch 返回的字数是新的
    const stat = await fs.stat(txtPath(dir, slot.base))
    if (!cacheMatches(sc, stat)) {
      sc = await withContentCache(dir, slot.base, sc, toLF(await fs.readFile(txtPath(dir, slot.base), 'utf8')))
    }
    return { ...slot, sc }
  }
  const hit = await tryOnce()
  if (hit) return hit
  await scanLibrary(dir)
  const retry = await tryOnce()
  if (!retry) throw new Error('找不到这篇文稿，请返回首页刷新文库')
  return retry
}

/** 按长篇 id 找到子目录名；索引没命中就重扫一次。 */
async function locateBook(dir: string, bookId: string): Promise<{ folder: string; book: BookJson }> {
  const tryOnce = async (): Promise<{ folder: string; book: BookJson } | null> => {
    if (index.dir !== dir) return null
    const folder = index.books.get(bookId)
    if (!folder) return null
    const book = await readBookJson(dir, folder)
    return book && book.id === bookId ? { folder, book } : null
  }
  const hit = await tryOnce()
  if (hit) return hit
  await scanLibrary(dir)
  const retry = await tryOnce()
  if (!retry) throw new Error('找不到这部长篇，请返回首页刷新文库')
  return retry
}

/**
 * 让短篇文件名跟上标题：若 safeFileName(title) 与当前文件名不一致，成对重命名。
 * 返回最终文件名。目标名被占用时追加 (2)，绝不覆盖；只改大小写时直接 rename。
 */
async function syncFileName(dir: string, base: string, title: string, id: string): Promise<string> {
  const wanted = safeFileName(title)
  if (wanted === base) return base
  const caseOnly = wanted.toLowerCase() === base.toLowerCase()
  const target = caseOnly ? wanted : await uniqueBaseName(dir, wanted)

  await fs.rename(txtPath(dir, base), txtPath(dir, target))
  try {
    await fs.rename(sidecarPath(dir, base), sidecarPath(dir, target))
  } catch {
    // 旁车不存在时，调用方随后会写一份新的
  }
  index.byId.set(id, { base: target, book: null })
  return target
}

/* ───────── 输入校验 ───────── */

function validateId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 100) throw new Error('文稿 ID 无效')
  return raw
}

function validateIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 500) throw new Error('ID 列表格式错误')
  return raw.map(validateId)
}

function validateTitle(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('标题不能为空')
  return raw.trim().slice(0, 200)
}

/* ───────── 写入队列（与 documents.ts 的队列独立） ───────── */

const libQueue = createSerializedQueue()

export function whenLibWritesIdle(maxMs: number): Promise<void> {
  return libQueue.whenIdle(maxMs)
}

/* ───────── 读写的拆分 / 合并 ───────── */

/** 卷：风格与素材来自 book.json；短篇：全在旁车。 */
function toPayload(sc: Sidecar, content: string, book: BookJson | null): DocumentPayload {
  return {
    title: sc.title,
    content,
    styleText: book ? book.styleText : sc.styleText,
    outlineText: sc.outlineText,
    styleEnabled: book ? book.styleEnabled : sc.styleEnabled,
    outlineEnabled: sc.outlineEnabled,
    outlineSegments: sc.outlineSegments,
    anchor: sc.anchor,
    chapterOutlines: sc.chapterOutlines,
    materials: book ? book.materials : sc.materials
  }
}

/** 把 DocumentPayload 里属于旁车的字段并进旁车（卷不在旁车里重复保存风格 / 素材）。 */
function mergeSidecar(sc: Sidecar, doc: DocumentPayload, isVolume: boolean): Sidecar {
  return {
    ...sc,
    outlineText: doc.outlineText,
    outlineEnabled: doc.outlineEnabled,
    // renderer 交来大纲段就说明已迁移：旧字段清掉，免得下次又迁一遍
    outlineSegments: doc.outlineSegments ?? sc.outlineSegments ?? [],
    anchor: doc.outlineSegments ? null : doc.anchor,
    chapterOutlines: doc.outlineSegments ? {} : (doc.chapterOutlines ?? {}),
    styleText: isVolume ? '' : doc.styleText,
    styleEnabled: isVolume ? false : doc.styleEnabled,
    materials: isVolume ? EMPTY_MATERIALS : (doc.materials ?? EMPTY_MATERIALS)
  }
}

/** 卷保存时同步 book.json；内容没变就不写盘。 */
async function syncBookJson(dir: string, folder: string, doc: DocumentPayload): Promise<void> {
  const book = (await readBookJson(dir, folder)) ?? freshBook(Date.now())
  const materials = doc.materials ?? EMPTY_MATERIALS
  const same =
    book.styleText === doc.styleText &&
    book.styleEnabled === doc.styleEnabled &&
    JSON.stringify(book.materials) === JSON.stringify(materials)
  if (same && book.id) return
  await writeBookJson(dir, folder, {
    ...book,
    id: book.id || randomUUID(),
    updatedAt: Date.now(),
    styleText: doc.styleText,
    styleEnabled: doc.styleEnabled,
    materials
  })
}

/** 在长篇目录里创建第 volume 卷（正文为空或给定）。调用方负责排队。 */
async function createVolumeFiles(
  dir: string,
  folder: string,
  bookId: string,
  volume: number,
  content: string,
  sc: Sidecar
): Promise<LibraryEntry> {
  const base = volumeBase(folder, volume)
  await writeFileAtomic(txtPath(dir, base), toLF(content))
  const cached = await withContentCache(dir, base, sc, content)
  await writeSidecar(dir, base, cached)
  const slot: Slot = { base, book: { id: bookId, title: folder, volume, folder } }
  if (index.dir === dir) index.byId.set(sc.id, slot)
  return toEntry(cached, slot.book)
}

/* ───────── 对外接口 ───────── */

export async function listLibrary(): Promise<LibraryEntry[]> {
  const dir = await readConfig()
  return libQueue.serialized(() => scanLibrary(dir))
}

export async function readLibrary(rawId: unknown): Promise<DocumentPayload> {
  const id = validateId(rawId)
  const dir = await readConfig()
  const located = await locate(dir, id)
  const content = toLF(await fs.readFile(txtPath(dir, located.base), 'utf8'))
  const book = located.book ? await readBookJson(dir, located.book.folder) : null
  return toPayload(located.sc, content, book)
}

export function createLibrary(rawDoc: unknown, rawFormat: unknown): Promise<LibraryEntry> {
  const doc = validateDocument(rawDoc)
  const format = parseFormat(rawFormat)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    await fs.mkdir(dir, { recursive: true })
    const title = doc.title.trim() || '未命名文稿'
    const base = await uniqueBaseName(dir, safeFileName(title))
    const now = Date.now()
    const sc = mergeSidecar(freshSidecar(title, format, now), doc, false)
    await writeFileAtomic(txtPath(dir, base), toLF(doc.content))
    const cached = await withContentCache(dir, base, sc, doc.content)
    await writeSidecar(dir, base, cached)
    if (index.dir === dir) index.byId.set(sc.id, { base, book: null })
    return toEntry(cached, null)
  })
}

/** 写作保存：写正文 + 旁车（卷还要同步 book.json）；短篇标题变了就顺手把文件名改过来。ID 不变。 */
export function saveLibrary(rawId: unknown, rawDoc: unknown): Promise<LibraryEntry> {
  const id = validateId(rawId)
  const doc = validateDocument(rawDoc)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const located = await locate(dir, id)
    const isVolume = located.book !== null
    const fallbackTitle = located.book ? defaultVolumeTitle(located.book.volume) : '未命名文稿'
    const title = doc.title.trim() || located.sc.title || fallbackTitle
    const base = isVolume ? located.base : await syncFileName(dir, located.base, title, id)
    const now = Date.now()
    const sc: Sidecar = {
      ...mergeSidecar(located.sc, doc, isVolume),
      title,
      updatedAt: now,
      interactedAt: Math.max(located.sc.interactedAt, now)
    }
    await writeFileAtomic(txtPath(dir, base), toLF(doc.content))
    const cached = await withContentCache(dir, base, sc, doc.content)
    await writeSidecar(dir, base, cached)
    if (located.book) await syncBookJson(dir, located.book.folder, doc)
    return toEntry(cached, located.book)
  })
}

/** 首页改名：短篇改标题与文件名；卷只改卷标题。正文不动，ID 不变。 */
export function renameLibrary(rawId: unknown, rawTitle: unknown): Promise<LibraryEntry> {
  const id = validateId(rawId)
  const title = validateTitle(rawTitle)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const located = await locate(dir, id)
    const base = located.book ? located.base : await syncFileName(dir, located.base, title, id)
    const now = Date.now()
    const sc: Sidecar = {
      ...located.sc,
      title,
      updatedAt: now,
      interactedAt: Math.max(located.sc.interactedAt, now)
    }
    await writeSidecar(dir, base, sc)
    return toEntry(sc, located.book)
  })
}

export function deleteLibrary(rawIds: unknown): Promise<void> {
  const ids = validateIds(rawIds)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const errors: string[] = []
    const touchedFolders = new Set<string>()
    for (const id of ids) {
      try {
        const { base, book } = await locate(dir, id)
        if (await exists(txtPath(dir, base))) await shell.trashItem(txtPath(dir, base))
        if (await exists(sidecarPath(dir, base))) await shell.trashItem(sidecarPath(dir, base))
        index.byId.delete(id)
        if (book) touchedFolders.add(book.folder)
      } catch (err) {
        errors.push(err instanceof Error ? err.message : '删除失败')
      }
    }
    // 长篇删到一卷不剩 → 整个目录（book.json）一起进回收站
    for (const folder of touchedFolders) {
      try {
        if ((await listVolumeFiles(dir, folder)).length === 0 && (await isDirectory(path.join(dir, folder)))) {
          await shell.trashItem(path.join(dir, folder))
          resetIndex()
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : '删除失败')
      }
    }
    if (errors.length > 0) throw new Error(`部分文稿删除失败：\n${errors.join('\n')}`)
  })
}

export function touchLibrary(rawId: unknown): Promise<LibraryEntry> {
  const id = validateId(rawId)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const { base, book, sc: old } = await locate(dir, id)
    const sc: Sidecar = { ...old, interactedAt: Math.max(old.interactedAt + 1, Date.now()) }
    await writeSidecar(dir, base, sc)
    return toEntry(sc, book)
  })
}

/* ───────── 长篇 ───────── */

export function createBook(rawTitle: unknown): Promise<LibraryEntry> {
  const title = validateTitle(rawTitle)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    await fs.mkdir(dir, { recursive: true })
    const folder = await uniqueFolderName(dir, safeFileName(title))
    await fs.mkdir(path.join(dir, folder), { recursive: true })
    const now = Date.now()
    const book = freshBook(now)
    await writeBookJson(dir, folder, book)
    if (index.dir === dir) index.books.set(book.id, folder)
    return createVolumeFiles(dir, folder, book.id, 0, '', freshSidecar(defaultVolumeTitle(0), 'txt', now))
  })
}

export function createVolume(rawBookId: unknown): Promise<LibraryEntry> {
  const bookId = validateId(rawBookId)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const { folder, book } = await locateBook(dir, bookId)
    const volumes = await listVolumeFiles(dir, folder)
    const next = volumes.length === 0 ? 0 : volumes[volumes.length - 1].volume + 1
    const now = Date.now()
    return createVolumeFiles(dir, folder, book.id, next, '', freshSidecar(defaultVolumeTitle(next), 'txt', now))
  })
}

/** 长篇改名：目录与各卷文件一起改名；卷 ID 不变（下次按 id 访问会自动重扫）。 */
export function renameBook(rawBookId: unknown, rawTitle: unknown): Promise<void> {
  const bookId = validateId(rawBookId)
  const title = validateTitle(rawTitle)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const { folder, book } = await locateBook(dir, bookId)
    const wanted = safeFileName(title)
    if (wanted === folder) return
    const caseOnly = wanted.toLowerCase() === folder.toLowerCase()
    const target = caseOnly ? wanted : await uniqueFolderName(dir, wanted)

    await fs.rename(path.join(dir, folder), path.join(dir, target))
    for (const v of await listVolumeFiles(dir, target)) {
      const from = path.join(target, v.name)
      const to = volumeBase(target, v.volume)
      if (from === to) continue
      await fs.rename(txtPath(dir, from), txtPath(dir, to))
      await fs.rename(sidecarPath(dir, from), sidecarPath(dir, to)).catch(() => undefined)
    }
    await writeBookJson(dir, target, { ...book, updatedAt: Date.now() })
    resetIndex()
  })
}

/** 短篇升级为长篇：建同名目录，原稿成为第 0 卷，风格 / 素材搬进 book.json。 */
export function convertToBook(rawId: unknown): Promise<LibraryEntry> {
  const id = validateId(rawId)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const located = await locate(dir, id)
    if (located.book) throw new Error('这篇文稿已经是长篇的一卷')
    const bookTitle = located.sc.title.trim() || '未命名长篇'
    const folder = await uniqueFolderName(dir, safeFileName(bookTitle))
    await fs.mkdir(path.join(dir, folder), { recursive: true })
    const now = Date.now()
    const book: BookJson = {
      ...freshBook(now),
      styleText: located.sc.styleText,
      styleEnabled: located.sc.styleEnabled,
      materials: located.sc.materials
    }
    await writeBookJson(dir, folder, book)

    const base = volumeBase(folder, 0)
    await fs.rename(txtPath(dir, located.base), txtPath(dir, base))
    const sc: Sidecar = {
      ...located.sc,
      title: defaultVolumeTitle(0),
      styleText: '',
      styleEnabled: false,
      materials: EMPTY_MATERIALS,
      updatedAt: now,
      interactedAt: Math.max(located.sc.interactedAt, now)
    }
    await writeSidecar(dir, base, sc)
    await fs.rm(sidecarPath(dir, located.base), { force: true }).catch(() => undefined)
    resetIndex()
    return toEntry(sc, { id: book.id, title: folder, volume: 0, folder })
  })
}

/** 只有一卷的长篇降回短篇：卷文件搬回根目录，风格 / 素材搬回旁车，目录移除。 */
export function convertToStandalone(rawBookId: unknown): Promise<LibraryEntry> {
  const bookId = validateId(rawBookId)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const { folder, book } = await locateBook(dir, bookId)
    const volumes = await listVolumeFiles(dir, folder)
    if (volumes.length !== 1) throw new Error('只有单卷的长篇才能降回短篇')
    const from = path.join(folder, volumes[0].name)
    const old = (await readSidecar(dir, from)) ?? freshSidecar(folder, 'txt', Date.now())
    const target = await uniqueBaseName(dir, safeFileName(folder))
    const now = Date.now()

    await fs.rename(txtPath(dir, from), txtPath(dir, target))
    const sc: Sidecar = {
      ...old,
      id: old.id || randomUUID(),
      title: folder,
      styleText: book.styleText,
      styleEnabled: book.styleEnabled,
      materials: book.materials,
      updatedAt: now,
      interactedAt: Math.max(old.interactedAt, now)
    }
    await writeSidecar(dir, target, sc)
    await fs.rm(sidecarPath(dir, from), { force: true }).catch(() => undefined)
    await fs.rm(bookJsonPath(dir, folder), { force: true }).catch(() => undefined)
    await fs.rmdir(path.join(dir, folder)).catch(() => undefined) // 目录里还有别的文件就留着
    resetIndex()
    return toEntry(sc, null)
  })
}

/* ───────── 目录 ───────── */

export async function getLibraryDirectory(): Promise<LibraryDirectory> {
  const current = await readConfig()
  return {
    path: current,
    isDefault: path.resolve(current) === path.resolve(defaultLibraryDir())
  }
}

export async function chooseLibraryDirectory(win: BrowserWindow): Promise<LibraryDirectory | null> {
  const result = await dialog.showOpenDialog(win, {
    title: '选择文稿保存文件夹',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return null

  const newDir = path.resolve(result.filePaths[0])
  const currentDir = path.resolve(await readConfig())
  if (newDir === currentDir) return getLibraryDirectory()
  if (newDir.startsWith(currentDir + path.sep) || currentDir.startsWith(newDir + path.sep)) {
    throw new Error('不能选择当前文库目录的父目录或子目录')
  }
  await migrateLibrary(currentDir, newDir)
  return { path: newDir, isDefault: false }
}

export async function resetLibraryDirectory(): Promise<LibraryDirectory> {
  const target = defaultLibraryDir()
  const currentDir = path.resolve(await readConfig())
  if (currentDir !== path.resolve(target)) await migrateLibrary(currentDir, target)
  return { path: target, isDefault: true }
}

/** 把 srcDir 的文稿全部复制到 dstDir；全部成功才切配置，再清理源目录。失败回滚。 */
function migrateLibrary(srcDir: string, dstDir: string): Promise<void> {
  return libQueue.serialized(() => migrateLibraryFiles(srcDir, dstDir))
}

/** migrateLibrary 的实际工作；启动期的旧目录迁移在队列外直接调用它。 */
async function migrateLibraryFiles(srcDir: string, dstDir: string): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true })
  // 探测目标可写
  const probe = path.join(dstDir, `.zixia-probe-${Date.now()}`)
  await fs.writeFile(probe, '')
  await fs.rm(probe, { force: true })

  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(srcDir, { withFileTypes: true })
  } catch {
    await writeConfig(dstDir) // 源目录不存在：直接切换
    resetIndex()
    return
  }

  const bases = dirents
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.txt'))
    .map((d) => d.name.slice(0, -4))
  const folders: string[] = []
  for (const d of dirents) {
    if (d.isDirectory() && (await listVolumeFiles(srcDir, d.name)).length > 0) folders.push(d.name)
  }

  const copied: string[] = []
  const copiedFolders: string[] = []
  try {
    for (const base of bases) {
      const dstBase = (await exists(txtPath(dstDir, base))) ? await uniqueBaseName(dstDir, base) : base
      await fs.copyFile(txtPath(srcDir, base), txtPath(dstDir, dstBase))
      copied.push(dstBase)
      if (await exists(sidecarPath(srcDir, base))) {
        await fs.copyFile(sidecarPath(srcDir, base), sidecarPath(dstDir, dstBase))
      }
    }
    for (const folder of folders) {
      const dstFolder = await uniqueFolderName(dstDir, folder)
      await fs.cp(path.join(srcDir, folder), path.join(dstDir, dstFolder), { recursive: true })
      copiedFolders.push(dstFolder)
    }
  } catch (err) {
    for (const b of copied) {
      await fs.rm(txtPath(dstDir, b), { force: true }).catch(() => undefined)
      await fs.rm(sidecarPath(dstDir, b), { force: true }).catch(() => undefined)
    }
    for (const f of copiedFolders) {
      await fs.rm(path.join(dstDir, f), { recursive: true, force: true }).catch(() => undefined)
    }
    throw new Error(`迁移失败（${(err as Error).message}），已回滚，原文库不受影响`)
  }

  await writeConfig(dstDir)
  resetIndex() // 强制下次重扫

  // 清理源目录；失败只是留下副本，不影响使用
  for (const base of bases) {
    await fs.rm(txtPath(srcDir, base), { force: true }).catch(() => undefined)
    await fs.rm(sidecarPath(srcDir, base), { force: true }).catch(() => undefined)
  }
  for (const folder of folders) {
    await fs.rm(path.join(srcDir, folder), { recursive: true, force: true }).catch(() => undefined)
  }
}
