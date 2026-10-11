import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ExistingBackendConfig, SetupState } from '../shared/ipc'

/**
 * 开发环境继续读取工程 resources/backend.json。
 *
 * 打包后的正式环境读取 userData/backend/backend.json。
 * userData 属于当前用户，可写，不受程序安装目录权限影响。
 */
export function getBackendConfigDir(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'backend')
    : path.join(app.getAppPath(), 'resources')
}

export function getBackendConfigPath(): string {
  return path.join(getBackendConfigDir(), 'backend.json')
}

function resolveConfiguredPath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(baseDir, value)
}

function isExistingFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * llama-server 启动时必须携带的参数。
 * deploy 写入的标准格式：['-c', '16384', '-t', '6', '-fa', 'on', '--parallel', '1']
 * 校验时检查每个 flag 是否存在且有对应的值。
 *
 * 注意：--device 不在此列表中。--device 由 SetupWizard 步骤 4 单独添加，
 * 缺少 --device 不算"参数不完整"，只走设备选择 UI。
 */
const REQUIRED_FLAGS = ['-c', '-t', '-fa', '--parallel'] as const

/**
 * 校验 args 数组是否包含所有必需的启动参数。
 * 每个 flag 后面必须跟一个值（不能是数组末尾元素），缺一不可。
 */
function validateRequiredArgs(args: string[]): string | null {
  for (const flag of REQUIRED_FLAGS) {
    const idx = args.indexOf(flag)
    if (idx === -1) return `缺少必需参数 ${flag}`
    if (idx + 1 >= args.length) return `参数 ${flag} 缺少对应的值`
  }
  return null
}

/**
 * 尝试修复常见的 JSON 格式错误（如数组/对象末尾多余逗号），
 * 然后解析。许多用户手动编辑 JSON 时容易引入这类错误。
 */
function tryParseJsonLenient(text: string): unknown | null {
  // ① 先尝试标准解析
  try {
    return JSON.parse(text)
  } catch {
    // 标准解析失败，尝试修复
  }

  // ② 修复末尾逗号：数组中 ",]" → "]"，对象中 ",}" → "}"
  try {
    const fixed = text.replace(/,\s*([\]}])/g, '$1')
    return JSON.parse(fixed)
  } catch {
    // 修复后仍然失败
  }

  return null
}

/**
 * 读取现有的 backend.json 配置（即使可能不完整）。
 * 用于旧版本升级后复用现有配置，避免用户重新配置整个流程。
 *
 * 容错策略：
 *   1. 尝试标准 JSON.parse()；
 *   2. 失败后尝试修复常见语法错误（末尾逗号）再解析；
 *   3. 仍然失败则用正则提取关键字段（exe、model、port 等），
 *      让 SetupWizard 至少能预填已解析到的值，不必让用户全手填。
 */
function readExistingConfig(configPath: string): ExistingBackendConfig | null {
  try {
    if (!isExistingFile(configPath)) return null

    const rawText = fs.readFileSync(configPath, 'utf8')

    // ── 尝试结构化解析（含容错修复） ──
    let raw: Record<string, unknown> | null = null
    const parsed = tryParseJsonLenient(rawText)
    if (typeof parsed === 'object' && parsed !== null) {
      raw = parsed as Record<string, unknown>
    }

    // ── 结构化解析完全失败时，用正则提取关键字段 ──
    if (!raw) {
      const extractString = (key: string): string => {
        const match = rawText.match(
          new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
        )
        return match ? match[1] : ''
      }
      const extractNumber = (key: string, fallback: number): number => {
        const match = rawText.match(
          new RegExp(`"${key}"\\s*:\\s*(\\d+)`)
        )
        return match ? Number(match[1]) : fallback
      }

      const exeValue = extractString('exe').trim()
      const modelValue = extractString('model').trim()
      if (!exeValue || !modelValue) return null

      return {
        exe: exeValue,
        model: modelValue,
        port: extractNumber('port', 18765),
        args: [],  // 无法从损坏 JSON 可靠提取数组
        startupTimeoutSec: extractNumber('startupTimeoutSec', 600)
      }
    }

    // ── 结构化解析成功，提取字段 ──
    const exeValue = typeof raw.exe === 'string' ? raw.exe.trim() : ''
    const modelValue = typeof raw.model === 'string' ? raw.model.trim() : ''

    // 必须至少有 exe 和 model 字段才有复用价值
    if (!exeValue || !modelValue) return null

    return {
      exe: exeValue,
      model: modelValue,
      port: Number(raw.port ?? 18765),
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      startupTimeoutSec: Number(raw.startupTimeoutSec ?? 600)
    }
  } catch {
    return null
  }
}

/**
 * 对恢复/解析出的配置做完整有效性判定。
 * 返回 SetupState 的公共部分。
 */
function evaluateConfig(
  configDir: string,
  configPath: string,
  exeValue: string,
  modelValue: string,
  port: number,
  args: string[],
  startupTimeoutSec: number
): SetupState {
  const exePath = resolveConfiguredPath(configDir, exeValue)
  const modelPath = resolveConfiguredPath(configDir, modelValue)

  const existingConfig: ExistingBackendConfig = {
    exe: exeValue,
    model: modelValue,
    port,
    args,
    startupTimeoutSec
  }

  if (!isExistingFile(exePath)) {
    return {
      configured: false,
      configPath,
      problem: 'missing-backend',
      message: `找不到模型后端程序：${exePath}`,
      existingConfig
    }
  }

  if (!isExistingFile(modelPath)) {
    return {
      configured: false,
      configPath,
      problem: 'missing-model',
      message: `找不到模型文件：${modelPath}`,
      existingConfig
    }
  }

  // 文件都在，检查 --device
  const hasDevice = args.includes('--device')
  return {
    configured: true,
    configPath,
    message: hasDevice ? '本地模型配置有效。' : '本地模型配置有效，但尚未选择推理设备。',
    existingConfig,
    needsDeviceSelection: !hasDevice
  }
}

/**
 * 检查配置是否足以启动后端。
 *
 * 校验清单：
 *   1. JSON 可解析（含容错修复末尾逗号）；
 *   2. exe / model 字段有效；
 *   3. args 包含所有必需参数（-c, -t, -fa, --parallel），缺一不可；
 *   4. exe / model 对应文件确实存在。
 *
 * 当 JSON 解析失败或参数缺失时，尝试 readExistingConfig() 恢复数据，
 * 并对恢复的数据再次做参数校验。如果恢复的配置参数齐全且文件存在，
 * 视为配置有效（可能只缺 --device）。
 *
 * 只有所有必需参数齐全时才标记 needsDeviceSelection；
 * 缺少任何必需参数则 configured=false，renderer 进入完整向导并预填。
 */
export function getSetupState(): SetupState {
  const configDir = getBackendConfigDir()
  const configPath = getBackendConfigPath()

  if (!isExistingFile(configPath)) {
    return {
      configured: false,
      configPath,
      problem: 'missing-config',
      message: '尚未完成本地模型设置。'
    }
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('配置内容不是 JSON 对象')
    }

    const raw = parsed as Record<string, unknown>
    const exeValue = typeof raw.exe === 'string' ? raw.exe.trim() : ''
    const modelValue = typeof raw.model === 'string' ? raw.model.trim() : ''
    const port = Number(raw.port ?? 18765)

    if (!exeValue) throw new Error('缺少 exe 字段')
    if (!modelValue) throw new Error('缺少 model 字段')
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port 必须是 1～65535 的整数')
    }
    if (raw.args === undefined || !Array.isArray(raw.args) || raw.args.length === 0) {
      throw new Error('args 参数为空，配置不完整')
    }

    const args = raw.args.map(String)
    const argsError = validateRequiredArgs(args)
    if (argsError) throw new Error(argsError)

    return evaluateConfig(
      configDir, configPath,
      exeValue, modelValue, port, args,
      Number(raw.startupTimeoutSec ?? 600)
    )
  } catch (error) {
    // ── JSON 解析失败或参数校验不通过 ──
    // 尝试从文件中恢复现有配置（容错解析 + 正则提取）
    const recovered = readExistingConfig(configPath)
    const errorMessage = error instanceof Error ? error.message : '无法解析配置'

    if (!recovered) {
      // 恢复也失败，无可用数据
      return {
        configured: false,
        configPath,
        problem: 'invalid-config',
        message: `后端配置无效：${errorMessage}`
      }
    }

    // 对恢复的数据再次做参数校验
    const recoveredArgsError = validateRequiredArgs(recovered.args)
    if (recoveredArgsError) {
      // 恢复的参数也不完整 → 需要完整向导，但预填已恢复的值
      return {
        configured: false,
        configPath,
        problem: 'invalid-config',
        message: `后端配置无效：${errorMessage}`,
        existingConfig: recovered
      }
    }

    // 恢复的参数齐全！检查文件是否存在后走 evaluateConfig
    return evaluateConfig(
      configDir, configPath,
      recovered.exe, recovered.model, recovered.port,
      recovered.args, recovered.startupTimeoutSec
    )
  }
}
