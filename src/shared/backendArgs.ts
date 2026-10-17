/**
 * llama-server 启动参数（backend.json 的 args 数组）的读写小工具。
 * 主进程（写 --device、部署时生成 args）与 renderer（首页「模型与推理」面板）共用，
 * 保证两边对「-t 后面跟一个值」这类约定的理解一致。
 */

/** 部署时写入、启动前校验的必备 flag（每个后面都跟一个值）。--device 不在其中。 */
export const REQUIRED_FLAGS = ['-c', '-t', '-fa', '--parallel'] as const

/** 这些 flag 由启动器自己拼（-m / --host / --port），不允许出现在 args 里。 */
export const RESERVED_FLAGS = ['-m', '--model', '--host', '--port'] as const

export const DEFAULT_PORT = 18765
export const DEFAULT_STARTUP_TIMEOUT_SEC = 600
/**
 * -c 是「总」上下文，llama-server 会把它平分给各个槽位（--parallel）。
 * 默认 2 个槽位：槽 0 给候选 / 短句展开，槽 1 给纠错等后台任务；每槽 16k，与过去单槽时一致。
 */
export const DEFAULT_CONTEXT_LENGTH = 32768
export const DEFAULT_SLOTS = 2
export const MAX_SLOTS = 4

/** 读某个 flag 后面的值；没有返回 null。 */
export function getArgValue(args: readonly string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return null
  return args[idx + 1]
}

export function getArgNumber(args: readonly string[], flag: string): number | null {
  const raw = getArgValue(args, flag)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** 设置 flag 的值（已存在则替换，否则追加）；返回新数组。 */
export function setArgValue(args: readonly string[], flag: string, value: string): string[] {
  const next = removeArg(args, flag)
  next.push(flag, value)
  return next
}

/** 移除 flag 及其值；返回新数组。 */
export function removeArg(args: readonly string[], flag: string): string[] {
  const next = [...args]
  for (;;) {
    const idx = next.indexOf(flag)
    if (idx === -1) return next
    next.splice(idx, idx + 1 < next.length ? 2 : 1)
  }
}

/** 校验 args 是否包含全部必备参数；返回错误描述或 null。 */
export function validateRequiredArgs(args: readonly string[]): string | null {
  for (const flag of REQUIRED_FLAGS) {
    const idx = args.indexOf(flag)
    if (idx === -1) return `缺少必需参数 ${flag}`
    if (idx + 1 >= args.length) return `参数 ${flag} 缺少对应的值`
  }
  for (const flag of RESERVED_FLAGS) {
    if (args.includes(flag)) return `${flag} 由程序自动设置，请从 args 中移除`
  }
  return null
}

/** 部署时生成的标准 args。 */
export function buildDefaultArgs(threads: number, contextLength: number, slots: number = DEFAULT_SLOTS): string[] {
  const n = Math.min(MAX_SLOTS, Math.max(1, Math.round(slots)))
  return ['-c', String(contextLength), '-t', String(threads), '-fa', 'on', '--parallel', String(n)]
}

/** 每个槽位实际分到的上下文长度。 */
export function contextPerSlot(contextLength: number, slots: number): number {
  return Math.floor(contextLength / Math.max(1, slots))
}

/** 把一行命令行文本拆成 args（支持双引号包裹含空格的值）。首页面板的「其它参数」输入框用。 */
export function splitArgLine(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** 与 splitArgLine 相反：把 args 还原成一行，含空格的值加双引号。 */
export function joinArgLine(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)).join(' ')
}

/** 被结构化字段（线程、上下文、设备、必备 flag）覆盖的 flag；其余算「其它参数」。 */
export const STRUCTURED_FLAGS = ['-c', '-t', '--device', '-fa', '--parallel'] as const

/** 把 args 拆成结构化字段 + 其它参数，供面板展示。 */
export function splitStructuredArgs(args: readonly string[]): {
  threads: number | null
  contextLength: number | null
  slots: number | null
  device: string | null
  extra: string[]
} {
  let extra = [...args]
  for (const flag of STRUCTURED_FLAGS) extra = removeArg(extra, flag)
  return {
    threads: getArgNumber(args, '-t'),
    contextLength: getArgNumber(args, '-c'),
    slots: getArgNumber(args, '--parallel'),
    device: getArgValue(args, '--device'),
    extra
  }
}

/** splitStructuredArgs 的逆操作。 */
export function composeArgs(fields: {
  threads: number
  contextLength: number
  slots?: number
  device: string | null
  extra: readonly string[]
}): string[] {
  let args = buildDefaultArgs(fields.threads, fields.contextLength, fields.slots ?? DEFAULT_SLOTS)
  if (fields.device) args = setArgValue(args, '--device', fields.device)
  let extra = [...fields.extra]
  for (const flag of [...STRUCTURED_FLAGS, ...RESERVED_FLAGS]) extra = removeArg(extra, flag)
  return [...args, ...extra]
}
