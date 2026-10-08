import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { SetupState } from '../shared/ipc'

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
 * 检查配置是否足以启动后端。
 *
 * 不只检查 backend.json 是否存在，也检查：
 *   1. JSON 是否可解析；
 *   2. exe/model 字段是否有效；
 *   3. 对应文件是否确实存在。
 *
 * 这样用户移动或删除模型以后，再次启动会进入修复向导，
 * 而不是直接进入编辑器后才看到后端报错。
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

    if (raw.args !== undefined && !Array.isArray(raw.args)) {
      throw new Error('args 必须是数组')
    }

    const exePath = resolveConfiguredPath(configDir, exeValue)
    const modelPath = resolveConfiguredPath(configDir, modelValue)

    if (!isExistingFile(exePath)) {
      return {
        configured: false,
        configPath,
        problem: 'missing-backend',
        message: `找不到模型后端程序：${exePath}`
      }
    }

    if (!isExistingFile(modelPath)) {
      return {
        configured: false,
        configPath,
        problem: 'missing-model',
        message: `找不到模型文件：${modelPath}`
      }
    }

    return {
      configured: true,
      configPath,
      message: '本地模型配置有效。'
    }
  } catch (error) {
    return {
      configured: false,
      configPath,
      problem: 'invalid-config',
      message: `后端配置无效：${error instanceof Error ? error.message : '无法解析配置'}`
    }
  }
}