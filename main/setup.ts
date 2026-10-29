/**
 * 首次设置状态：配置文件是否可用、缺什么。
 * 解析本身在 backendConfig.ts；这里只做「文件存不存在、要不要选设备」的判定。
 */
import fs from 'node:fs'
import type { SetupState } from '../shared/ipc'
import { getBackendConfigPath, readBackendConfig, resolveConfigPath } from './backendConfig'

export { getBackendConfigDir, getBackendConfigPath } from './backendConfig'

function isExistingFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 检查配置是否足以启动后端：
 *   1. backend.json 可解析、字段齐全、args 含必备参数（readBackendConfig）；
 *   2. exe / model 文件确实存在；
 *   3. 有没有 --device（没有只算「待选设备」，不算无效）。
 */
export function getSetupState(): SetupState {
  const configPath = getBackendConfigPath()
  const result = readBackendConfig()

  if (!result.ok) {
    return {
      configured: false,
      configPath,
      problem: result.reason === 'missing' ? 'missing-config' : 'invalid-config',
      message: result.message,
      ...(result.recovered ? { existingConfig: result.recovered } : {})
    }
  }

  const config = result.config
  const exePath = resolveConfigPath(config.exe)
  const modelPath = resolveConfigPath(config.model)

  if (!isExistingFile(exePath)) {
    return {
      configured: false,
      configPath,
      problem: 'missing-backend',
      message: `找不到模型后端程序：${exePath}`,
      existingConfig: config
    }
  }
  if (!isExistingFile(modelPath)) {
    return {
      configured: false,
      configPath,
      problem: 'missing-model',
      message: `找不到模型文件：${modelPath}`,
      existingConfig: config
    }
  }

  const hasDevice = config.args.includes('--device')
  return {
    configured: true,
    configPath,
    message: hasDevice ? '本地模型配置有效。' : '本地模型配置有效，但尚未选择推理设备。',
    existingConfig: config,
    needsDeviceSelection: !hasDevice
  }
}
