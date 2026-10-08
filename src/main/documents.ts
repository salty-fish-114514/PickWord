/**
 * 「导出 TXT 副本」用到的工具函数。
 *
 * 旧版的单文档读写（loadDocument / openDocument / commitOpenedDocument / saveDocument，
 * 以及它们依赖的 currentPath / docEpoch / 旁车读写）已随多篇文库功能一起废弃并删除。
 * 现在只保留「导出」这一个独立动作：把当前编辑器里的内容另存为一份 txt 副本，
 * 不涉及「当前保存目标」这种全局状态，自然也就没有多篇文稿互相串档的问题。
 */
import { app, dialog, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Anchor, DocumentPayload, SaveResult } from '../shared/ipc'

const APP_DIR_NAME = 'PickWord'
const MAX_CONTENT_CHARS = 20_000_000

interface TextFormat {
  crlf: boolean
  bom: boolean
}

const defaultFormat = (): TextFormat => ({ crlf: process.platform === 'win32', bom: false })
const defaultDir = (): string => path.join(app.getPath('documents'), APP_DIR_NAME)

function encodeText(content: string, format: TextFormat): Buffer {
  let text = content.replace(/\r\n?/g, '\n')
  if (format.crlf) text = text.replace(/\n/g, '\r\n')
  const body = Buffer.from(text, 'utf8')
  return format.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
}

/** 原子写入：写临时文件 → 落盘 → 改名替换。library.ts 也直接复用这个函数。 */
export async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, target)
      return
    } catch (err) {
      if (attempt >= 4) {
        await fs.rm(tmp, { force: true })
        throw err
      }
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
  }
}

/** 写入队列：导出动作本身很少并发，但保留这把锁，便于以后复用。 */
let writeChain: Promise<unknown> = Promise.resolve()
export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}
export function whenWritesIdle(maxMs: number): Promise<void> {
  return Promise.race([writeChain.then(() => undefined), new Promise<void>((r) => setTimeout(r, maxMs))])
}

function safeFileName(title: string): string {
  let name = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  if (!name) name = '未命名'
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `_${name}`
  return name
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseAnchor(v: unknown): Anchor | null {
  if (!isObj(v)) return null
  const { offset, fingerprint } = v
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null
  if (typeof fingerprint !== 'string') return null
  return { offset, fingerprint }
}

function parseDocument(raw: unknown): DocumentPayload {
  if (!isObj(raw)) throw new Error('文稿数据格式错误')
  if (typeof raw.content !== 'string' || raw.content.length > MAX_CONTENT_CHARS) {
    throw new Error('正文不是字符串或过长')
  }
  return {
    title: str(raw.title),
    content: raw.content,
    styleText: str(raw.styleText),
    outlineText: str(raw.outlineText),
    styleEnabled: raw.styleEnabled === true,
    outlineEnabled: raw.outlineEnabled === true,
    anchor: parseAnchor(raw.anchor)
  }
}

/** 「导出」：弹系统对话框，把当前正文另存为一份 txt。不记录、不影响任何「当前文件」状态。 */
export async function saveDocumentAs(win: BrowserWindow, raw: unknown): Promise<SaveResult | null> {
  const doc = parseDocument(raw)
  await fs.mkdir(defaultDir(), { recursive: true })
  const result = await dialog.showSaveDialog(win, {
    title: '导出为 TXT',
    defaultPath: path.join(defaultDir(), `${safeFileName(doc.title)}.txt`),
    filters: [{ name: '文本', extensions: ['txt'] }]
  })
  if (result.canceled || !result.filePath) return null

  const target = path.extname(result.filePath).toLowerCase() === '.txt' ? result.filePath : `${result.filePath}.txt`
  await serialized(() => writeFileAtomic(target, encodeText(doc.content, defaultFormat())))
  return { path: target }
}