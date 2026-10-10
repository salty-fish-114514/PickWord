/**
 * 主进程共享 I/O 工具。
 *
 * 提取自 documents.ts / library.ts / candidates.ts 中重复出现的：
 *   - 类型守卫（isObj / asNum / asStr）
 *   - 原子写入（writeFileAtomic）
 *   - 写入队列（createSerializedQueue）
 *   - 文件名消毒（safeFileName）
 *   - 锚点解析（parseAnchor）
 *   - 文稿校验（validateDocument）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Anchor, DocumentPayload } from '../shared/ipc'

/* ───────── 类型守卫 ───────── */

export type Json = Record<string, unknown>

export const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

/* ───────── 原子写入 ───────── */

/**
 * 写临时文件 → fsync → rename 替换。
 * rename 失败自动重试最多 4 次（Windows 下文件句柄释放有延迟）。
 */
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

/* ───────── 写入队列 ───────── */

export interface SerializedQueue {
  serialized: <T>(task: () => Promise<T>) => Promise<T>
  whenIdle: (maxMs: number) => Promise<void>
}

/**
 * 创建一个串行化的写入队列。
 * 每次 task 串行执行；whenIdle 等到队列空闲（或超时）。
 * documents.ts 和 library.ts 各持有一个独立实例。
 */
export function createSerializedQueue(): SerializedQueue {
  let chain: Promise<unknown> = Promise.resolve()

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task)
    chain = run.catch(() => undefined)
    return run
  }

  function whenIdle(maxMs: number): Promise<void> {
    return Promise.race([
      chain.then(() => undefined),
      new Promise<void>((r) => setTimeout(r, maxMs)),
    ])
  }

  return { serialized, whenIdle }
}

/* ───────── 文件名消毒 ───────── */

/** 标题 → 合法 Windows 文件名（不含扩展名）。 */
export function safeFileName(title: string): string {
  let name = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  if (!name) name = '未命名'
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `_${name}`
  return name
}

/* ───────── 锚点解析 ───────── */

export function parseAnchor(v: unknown): Anchor | null {
  if (!isObj(v)) return null
  const { offset, fingerprint } = v
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null
  if (typeof fingerprint !== 'string') return null
  return { offset, fingerprint }
}

/* ───────── 文稿校验 ───────── */

const MAX_CONTENT_CHARS = 20_000_000

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

export function validateDocument(raw: unknown): DocumentPayload {
  if (!isObj(raw)) throw new Error('文稿数据格式错误')
  if (typeof raw.content !== 'string' || raw.content.length > MAX_CONTENT_CHARS) {
    throw new Error('正文不是字符串或超出长度限制')
  }
  return {
    title: str(raw.title),
    content: raw.content,
    styleText: str(raw.styleText),
    outlineText: str(raw.outlineText),
    styleEnabled: raw.styleEnabled === true,
    outlineEnabled: raw.outlineEnabled === true,
    anchor: parseAnchor(raw.anchor),
  }
}
