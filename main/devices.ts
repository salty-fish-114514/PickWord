/**
 * 设备列表：运行 llama-server --list-devices，解析出实际可用的 GPU 设备。
 *
 * 为什么不在硬件检测时猜设备名：llama.cpp 的设备名取决于编译时启用的后端——
 * HIP 版只认 ROCm0，CUDA 版只认 CUDA0，Vulkan 版只认 Vulkan0。猜前缀会直接报
 * "invalid device"。正确做法是直接问已安装的 llama-server。
 *
 * 输出格式示例（b8868）：
 *   Available devices:
 *     ROCm0: AMD Radeon RX 7800 XT (16368 MiB, 14000 MiB free)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { BackendDeviceInfo } from '../shared/ipc'
import { readBackendConfig, resolveConfigPath } from './backendConfig'

const LIST_TIMEOUT_MS = 10_000

export async function listBackendDevices(): Promise<BackendDeviceInfo[]> {
  const result = readBackendConfig()
  if (!result.ok) return []
  const exePath = resolveConfigPath(result.config.exe)
  if (!fs.existsSync(exePath)) return []

  return new Promise((resolve) => {
    let stdout = ''
    // --list-devices 打印完会自行退出；设超时防止异常情况下挂住
    const child = spawn(exePath, ['--list-devices'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve([])
    }, LIST_TIMEOUT_MS)

    // 只收 stdout：stderr 是 ggml_cuda_init / load_backend 之类的日志
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(parseDeviceList(stdout))
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve([])
    })
  })
}

/** 只保留带「总显存, 可用显存 free」信息的行；CPU 与后端加载信息都被过滤掉。 */
export function parseDeviceList(output: string): BackendDeviceInfo[] {
  const devices: BackendDeviceInfo[] = []
  let inSection = false

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line.toLowerCase().includes('available devices')) {
      inSection = true
      continue
    }
    if (!inSection || !line) continue

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const id = line.slice(0, colon).trim()
    const rest = line.slice(colon + 1).trim()
    if (!id) continue

    const vram = rest.match(/\((\d+)\s+MiB,\s*(\d+)\s+MiB\s+free\)/)
    if (!vram) continue

    devices.push({
      id,
      name: rest.slice(0, vram.index).trim(),
      vramBytes: parseInt(vram[1], 10) * 1024 * 1024,
      freeVramBytes: parseInt(vram[2], 10) * 1024 * 1024
    })
  }
  return devices
}
