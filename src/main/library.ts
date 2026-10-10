/**
 * 多篇文稿文库。
 *
 * ID 策略（第二版）：
 *   - 每篇文稿的 ID 是旁车 .writer.json 里的 UUID，一旦生成永不变。
 *   - 物理文件名跟随标题：保存/改名时若标题与文件名不符，自动重命名 <名>.txt + <名>.writer.json。
 *   - 因此前端 key={id} 不会因改名而重挂载，onSave 闭包里的 id 始终有效。
 *   - 没有旁车的孤立 .txt（用户手动丢进目录的）在扫描时自动补旁车 + UUID。
 *
 * 其余约定：目录配置存 userData/library-config.json；删除走系统回收站；
 * 写入全部排队并原子落盘；不触碰旧 documents.ts 的 currentPath。
 */
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  Anchor,
  DocumentPayload,
  LibraryDirectory,
  LibraryEntry,
  LibraryFormat
} from '../shared/ipc'
import {
  createSerializedQueue,
  isObj,
  parseAnchor,
  safeFileName,
  validateDocument,
  writeFileAtomic,
} from './ioUtils'

const SIDECAR_VERSION = 2
const CONFIG_FILE = (): string => path.join(app.getPath('userData'), 'library-config.json')

// 开发：项目根目录/manuscripts；打包：exe 同级/manuscripts（不占 C 盘 userData）
const defaultLibraryDir = (): string =>
  app.isPackaged
    ? path.join(path.dirname(process.execPath), 'manuscripts')
    : path.join(app.getAppPath(), 'manuscripts')

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

const txtPath = (dir: string, base: string): string => path.join(dir, `${base}.txt`)
const sidecarPath = (dir: string, base: string): string => path.join(dir, `${base}.writer.json`)

const makeExcerpt = (content: string): string => content.replace(/\s+/g, ' ').trim().slice(0, 160)
const countChars = (content: string): number => Array.from(content.replace(/\s/g, '')).length

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

/* ───────── 目录配置 ───────── */

async function readConfig(): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(CONFIG_FILE(), 'utf8'))
    if (isObj(parsed) && typeof parsed.libraryPath === 'string' && parsed.libraryPath) {
      return parsed.libraryPath
    }
  } catch {
    // 首次启动或配置损坏 → 默认目录
  }
  return defaultLibraryDir()
}

async function writeConfig(libraryPath: string): Promise<void> {
  await writeFileAtomic(CONFIG_FILE(), JSON.stringify({ libraryPath }))
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
  anchor: Anchor | null
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
      title: str(parsed.title, base),
      sourceFormat: parseFormat(parsed.sourceFormat),
      updatedAt: num(parsed.updatedAt, now),
      interactedAt: num(parsed.interactedAt, now),
      styleText: str(parsed.styleText),
      outlineText: str(parsed.outlineText),
      styleEnabled: parsed.styleEnabled === true,
      outlineEnabled: parsed.outlineEnabled === true,
      anchor: parseAnchor(parsed.anchor)
    }
  } catch {
    return null
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
    outlineEnabled: false,
    anchor: null
  }
}

function toEntry(sc: Sidecar, content: string): LibraryEntry {
  return {
    id: sc.id,
    title: sc.title,
    excerpt: makeExcerpt(content),
    sourceFormat: sc.sourceFormat,
    characterCount: countChars(content),
    updatedAt: sc.updatedAt,
    interactedAt: sc.interactedAt
  }
}

/* ───────── 写入队列（与 documents.ts 的队列独立） ───────── */

const libQueue = createSerializedQueue()

export function whenLibWritesIdle(maxMs: number): Promise<void> {
  return libQueue.whenIdle(maxMs)
}

/* ───────── ID → 文件名 索引 ─────────
 * 内存里维护 Map<id, 文件名>。扫描目录时重建；按 id 查不到时自动重扫一次。 */

interface Located {
  base: string
  sc: Sidecar
}

let index: { dir: string; byId: Map<string, string> } = { dir: '', byId: new Map() }

/**
 * 扫描目录：为每个 .txt 配对旁车；缺旁车或缺 id 的补写（不动正文）。
 * 返回 entries 与 id→文件名 映射。
 */
async function scanLibrary(dir: string): Promise<{ entries: LibraryEntry[]; byId: Map<string, string> }> {
  await fs.mkdir(dir, { recursive: true })
  const names = await fs.readdir(dir)
  const entries: LibraryEntry[] = []
  const byId = new Map<string, string>()

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.txt')) continue
    const base = name.slice(0, -4)
    if (!base) continue
    try {
      const stat = await fs.stat(txtPath(dir, base))
      if (!stat.isFile()) continue
      const content = toLF(await fs.readFile(txtPath(dir, base), 'utf8'))

      let sc = await readSidecar(dir, base)
      let dirty = false
      if (!sc) {
        sc = freshSidecar(base, 'txt', stat.mtimeMs)
        dirty = true
      } else if (!sc.id || byId.has(sc.id)) {
        // 没有 id，或者用户复制了一份文件导致 id 重复 → 分配新 id
        sc = { ...sc, id: randomUUID() }
        dirty = true
      }
      if (dirty) await writeSidecar(dir, base, sc)

      byId.set(sc.id, base)
      entries.push(toEntry(sc, content))
    } catch {
      // 单篇损坏不影响其余
    }
  }
  index = { dir, byId }
  return { entries, byId }
}

/** 按 id 找到文件名与旁车；索引没命中就重扫一次。 */
async function locate(dir: string, id: string): Promise<Located> {
  const tryOnce = async (): Promise<Located | null> => {
    if (index.dir !== dir) return null
    const base = index.byId.get(id)
    if (!base || !(await exists(txtPath(dir, base)))) return null
    const sc = await readSidecar(dir, base)
    if (!sc || sc.id !== id) return null
    return { base, sc }
  }
  const hit = await tryOnce()
  if (hit) return hit
  await scanLibrary(dir)
  const retry = await tryOnce()
  if (!retry) throw new Error('找不到这篇文稿，请返回首页刷新文库')
  return retry
}

/**
 * 让文件名跟上标题：若 safeFileName(title) 与当前文件名不一致，成对重命名。
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
  index.byId.set(id, target)
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


/* ───────── 对外接口 ───────── */

export async function listLibrary(): Promise<LibraryEntry[]> {
  const dir = await readConfig()
  return libQueue.serialized(async () => (await scanLibrary(dir)).entries)
}

export async function readLibrary(rawId: unknown): Promise<DocumentPayload> {
  const id = validateId(rawId)
  const dir = await readConfig()
  const { base, sc } = await locate(dir, id)
  const content = toLF(await fs.readFile(txtPath(dir, base), 'utf8'))
  return {
    title: sc.title,
    content,
    styleText: sc.styleText,
    outlineText: sc.outlineText,
    styleEnabled: sc.styleEnabled,
    outlineEnabled: sc.outlineEnabled,
    anchor: sc.anchor
  }
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
    const sc: Sidecar = {
      ...freshSidecar(title, format, now),
      styleText: doc.styleText,
      outlineText: doc.outlineText,
      styleEnabled: doc.styleEnabled,
      outlineEnabled: doc.outlineEnabled,
      anchor: doc.anchor
    }
    await writeFileAtomic(txtPath(dir, base), toLF(doc.content))
    await writeSidecar(dir, base, sc)
    if (index.dir === dir) index.byId.set(sc.id, base)
    return toEntry(sc, doc.content)
  })
}

/** 写作保存：写正文 + 旁车；标题变了就顺手把文件名改过来。ID 不变。 */
export function saveLibrary(rawId: unknown, rawDoc: unknown): Promise<LibraryEntry> {
  const id = validateId(rawId)
  const doc = validateDocument(rawDoc)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const located = await locate(dir, id)
    const title = doc.title.trim() || located.sc.title || '未命名文稿'
    const base = await syncFileName(dir, located.base, title, id)
    const now = Date.now()
    const sc: Sidecar = {
      ...located.sc,
      title,
      updatedAt: now,
      interactedAt: Math.max(located.sc.interactedAt, now),
      styleText: doc.styleText,
      outlineText: doc.outlineText,
      styleEnabled: doc.styleEnabled,
      outlineEnabled: doc.outlineEnabled,
      anchor: doc.anchor
    }
    await writeFileAtomic(txtPath(dir, base), toLF(doc.content))
    await writeSidecar(dir, base, sc)
    return toEntry(sc, doc.content)
  })
}

/** 首页改名：只改标题与文件名，正文不动。ID 不变。 */
export function renameLibrary(rawId: unknown, rawTitle: unknown): Promise<LibraryEntry> {
  const id = validateId(rawId)
  const title = validateTitle(rawTitle)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const located = await locate(dir, id)
    const base = await syncFileName(dir, located.base, title, id)
    const now = Date.now()
    const sc: Sidecar = {
      ...located.sc,
      title,
      updatedAt: now,
      interactedAt: Math.max(located.sc.interactedAt, now)
    }
    await writeSidecar(dir, base, sc)
    const content = toLF(await fs.readFile(txtPath(dir, base), 'utf8'))
    return toEntry(sc, content)
  })
}

export function deleteLibrary(rawIds: unknown): Promise<void> {
  const ids = validateIds(rawIds)

  return libQueue.serialized(async () => {
    const dir = await readConfig()
    const errors: string[] = []
    for (const id of ids) {
      try {
        const { base } = await locate(dir, id)
        if (await exists(txtPath(dir, base))) await shell.trashItem(txtPath(dir, base))
        if (await exists(sidecarPath(dir, base))) await shell.trashItem(sidecarPath(dir, base))
        index.byId.delete(id)
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
    const { base, sc: old } = await locate(dir, id)
    const sc: Sidecar = { ...old, interactedAt: Math.max(old.interactedAt + 1, Date.now()) }
    await writeSidecar(dir, base, sc)
    const content = toLF(await fs.readFile(txtPath(dir, base), 'utf8'))
    return toEntry(sc, content)
  })
}

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
  return libQueue.serialized(async () => {
    await fs.mkdir(dstDir, { recursive: true })
    // 探测目标可写
    const probe = path.join(dstDir, `.zixia-probe-${Date.now()}`)
    await fs.writeFile(probe, '')
    await fs.rm(probe, { force: true })

    let names: string[]
    try {
      names = await fs.readdir(srcDir)
    } catch {
      await writeConfig(dstDir) // 源目录不存在：直接切换
      index = { dir: '', byId: new Map() }
      return
    }

    const bases = names.filter((n) => n.toLowerCase().endsWith('.txt')).map((n) => n.slice(0, -4))
    const copied: string[] = []
    try {
      for (const base of bases) {
        const dstBase = (await exists(txtPath(dstDir, base))) ? await uniqueBaseName(dstDir, base) : base
        await fs.copyFile(txtPath(srcDir, base), txtPath(dstDir, dstBase))
        copied.push(dstBase)
        if (await exists(sidecarPath(srcDir, base))) {
          await fs.copyFile(sidecarPath(srcDir, base), sidecarPath(dstDir, dstBase))
        }
      }
    } catch (err) {
      for (const b of copied) {
        await fs.rm(txtPath(dstDir, b), { force: true }).catch(() => undefined)
        await fs.rm(sidecarPath(dstDir, b), { force: true }).catch(() => undefined)
      }
      throw new Error(`迁移失败（${(err as Error).message}），已回滚，原文库不受影响`)
    }

    await writeConfig(dstDir)
    index = { dir: '', byId: new Map() } // 强制下次重扫

    // 清理源目录；失败只是留下副本，不影响使用
    for (const base of bases) {
      await fs.rm(txtPath(srcDir, base), { force: true }).catch(() => undefined)
      await fs.rm(sidecarPath(srcDir, base), { force: true }).catch(() => undefined)
    }
  })
}