/**
 * backend.json 的唯一归属：位置、解析、校验、写入。
 *
 * 其它模块（setup / backend / deploy / devices / index）只通过这里读写配置，
 * 不再各自 JSON.parse。谁写了配置，谁负责显式调用 backend.restart()——
 * 不再用 fs.watch 监听文件变化。
 *
 * 位置：
 *   开发        → 工程 resources/backend.json
 *   打包后      → userData/backend/backend.json（属于当前用户，可写，不受安装目录权限影响）
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { BackendConfig } from '../shared/ipc'
import {
  DEFAULT_PORT,
  DEFAULT_STARTUP_TIMEOUT_SEC,
  RESERVED_FLAGS,
  removeArg,
  validateRequiredArgs
} from '../shared/backendArgs'
import { isObj, writeFileAtomic } from './ioUtils'

const BACKEND_KINDS = ['cuda', 'rocm', 'vulkan', 'cpu'] as const
type EngineKind = (typeof BACKEND_KINDS)[number]

/** 认不出来的 kind（手改配置写错）当作没有：它只影响界面措辞，不影响启动。 */
function pickKind(value: unknown): EngineKind | undefined {
  return typeof value === 'string' ? BACKEND_KINDS.find((kind) => kind === value) : undefined
}

export function getBackendConfigDir(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'backend')
    : path.join(app.getAppPath(), 'resources')
}

export function getBackendConfigPath(): string {
  return path.join(getBackendConfigDir(), 'backend.json')
}

/** exe / model 允许写相对路径（相对配置文件目录）；这里统一成绝对路径。 */
export function resolveConfigPath(value: string): string {
  return path.isAbsolute(value) ? value : path.join(getBackendConfigDir(), value)
}

/** 解析结果：
 *   ok=true  → config 字段齐全且 args 含全部必备参数（文件是否存在由调用方再查）；
 *   ok=false → reason 说明原因；recovered 是能从损坏文件里抢救出的部分（供向导预填）。 */
export type BackendConfigReadResult =
  | { ok: true; config: BackendConfig }
  | { ok: false; reason: 'missing' | 'invalid'; message: string; recovered: BackendConfig | null }

/* ───────── 解析 ───────── */

/** 标准 JSON → 修复末尾逗号再试 → 放弃。用户手改 JSON 最常见的错误就是多一个逗号。 */
function parseJsonLenient(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    /* fallthrough */
  }
  try {
    return JSON.parse(text.replace(/,\s*([\]}])/g, '$1'))
  } catch {
    return null
  }
}

/** JSON 完全解析不了时，用正则把 exe / model / port 抠出来，至少让向导能预填。 */
function recoverByRegex(text: string): BackendConfig | null {
  const str = (key: string): string => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    return m ? m[1].trim() : ''
  }
  const num = (key: string, fallback: number): number => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`))
    return m ? Number(m[1]) : fallback
  }
  const exe = str('exe')
  const model = str('model')
  if (!exe || !model) return null
  return {
    exe,
    model,
    port: num('port', DEFAULT_PORT),
    args: [],
    startupTimeoutSec: num('startupTimeoutSec', DEFAULT_STARTUP_TIMEOUT_SEC)
  }
}

/** 把来路不明的对象整理成 BackendConfig；字段缺失或类型不对抛错。 */
export function parseBackendConfig(raw: unknown): BackendConfig {
  if (!isObj(raw)) throw new Error('配置内容不是 JSON 对象')
  const exe = typeof raw.exe === 'string' ? raw.exe.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (!exe) throw new Error('缺少 exe 字段')
  if (!model) throw new Error('缺少 model 字段')

  const port = Number(raw.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必须是 1～65535 的整数')

  if (!Array.isArray(raw.args) || raw.args.length === 0) throw new Error('args 参数为空，配置不完整')
  const args = raw.args.map(String)
  const argsError = validateRequiredArgs(args)
  if (argsError) throw new Error(argsError)

  const timeout = Number(raw.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC)
  const kind = pickKind(raw.kind)
  return {
    exe,
    model,
    port,
    args,
    startupTimeoutSec: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_STARTUP_TIMEOUT_SEC,
    ...(kind ? { kind } : {})
  }
}

/** 读文件 + 解析。所有读取方都走这里，因此「配置是否有效」只有一种答案。 */
export function readBackendConfig(): BackendConfigReadResult {
  const file = getBackendConfigPath()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { ok: false, reason: 'missing', message: '尚未完成本地模型设置。', recovered: null }
  }

  const parsed = parseJsonLenient(text)
  try {
    if (parsed === null) throw new Error('JSON 无法解析')
    return { ok: true, config: parseBackendConfig(parsed) }
  } catch (err) {
    const message = err instanceof Error ? err.message : '无法解析配置'
    // 尽量抢救：结构化对象里有 exe/model 就先拿出来，否则正则兜底
    let recovered: BackendConfig | null = null
    if (isObj(parsed)) {
      const exe = typeof parsed.exe === 'string' ? parsed.exe.trim() : ''
      const model = typeof parsed.model === 'string' ? parsed.model.trim() : ''
      if (exe && model) {
        const kind = pickKind(parsed.kind)
        recovered = {
          exe,
          model,
          port: Number(parsed.port ?? DEFAULT_PORT) || DEFAULT_PORT,
          args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
          startupTimeoutSec: Number(parsed.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC) || DEFAULT_STARTUP_TIMEOUT_SEC,
          ...(kind ? { kind } : {})
        }
      }
    } else {
      recovered = recoverByRegex(text)
    }
    return { ok: false, reason: 'invalid', message: `后端配置无效：${message}`, recovered }
  }
}

/* ───────── 写入 ───────── */

/** 校验后原子写入。保留字段（-m/--host/--port）一律剔除。 */
export async function writeBackendConfig(raw: unknown): Promise<BackendConfig> {
  const config = parseBackendConfig(raw)
  let args = config.args
  for (const flag of RESERVED_FLAGS) args = removeArg(args, flag)
  const normalized: BackendConfig = { ...config, args }
  await writeFileAtomic(getBackendConfigPath(), JSON.stringify(normalized, null, 2))
  return normalized
}

/** 读 → 改 → 写。文件不存在或无效时抛错（这个入口只用于局部修改，不负责从零创建）。 */
export async function updateBackendConfig(
  mutate: (current: BackendConfig) => BackendConfig
): Promise<BackendConfig> {
  const result = readBackendConfig()
  if (!result.ok) throw new Error(result.message)
  return writeBackendConfig(mutate(result.config))
}
