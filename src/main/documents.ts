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
import type { SaveResult } from '../shared/ipc'
import { createSerializedQueue, safeFileName, validateDocument, writeFileAtomic } from './ioUtils'

const APP_DIR_NAME = 'PickWord'

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

/** 写入队列：导出动作本身很少并发，但保留这把锁，便于以后复用。 */
const writeQueue = createSerializedQueue()

/** 「导出」：弹系统对话框，把当前正文另存为一份 txt。不记录、不影响任何「当前文件」状态。 */
export async function saveDocumentAs(win: BrowserWindow, raw: unknown): Promise<SaveResult | null> {
  const doc = validateDocument(raw)
  const result = await dialog.showSaveDialog(win, {
    title: '导出为 TXT',
    defaultPath: path.join(defaultDir(), `${safeFileName(doc.title)}.txt`),
    filters: [{ name: '文本', extensions: ['txt'] }]
  })
  if (result.canceled || !result.filePath) return null

  const target = path.extname(result.filePath).toLowerCase() === '.txt' ? result.filePath : `${result.filePath}.txt`
  await writeQueue.serialized(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await writeFileAtomic(target, encodeText(doc.content, defaultFormat()))
  })
  return { path: target }
}

/** 导出队列的空闲等待（供关窗保护使用）。 */
export function whenWritesIdle(maxMs: number): Promise<void> {
  return writeQueue.whenIdle(maxMs)
}