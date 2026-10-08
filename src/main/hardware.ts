import os from 'node:os'
import { execFile } from 'node:child_process'
import type {
  BackendRecommendation,
  CpuInfo,
  GpuInfo,
  GpuVendor,
  HardwareReport
} from '../shared/ipc'

/* ════════════════════════════════════════════════════════════════
   底层:执行外部命令
   ════════════════════════════════════════════════════════════════ */

/** 跑一个命令拿 stdout;失败返回 null,绝不 throw(检测失败是正常情况)。 */
function run(file: string, args: string[], timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

/** 跑一段 PowerShell,输出要求是 JSON(由脚本里的 ConvertTo-Json 保证)。
 *  ConvertTo-Json 会把非 ASCII 字符转成 \uXXXX 转义,所以不受终端代码页影响,
 *  这正好绕开了之前遇到的 PowerShell 中文乱码问题。 */
async function runPsJson(script: string): Promise<unknown | null> {
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    // 强制 PowerShell 向 stdout 输出 UTF-8 字节，避免 Node 收到 GBK 乱码
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
  ])
  if (!out || !out.trim()) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

/** ConvertTo-Json 对单个对象不包数组,这里统一成数组。 */
function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[]
  if (typeof value === 'object' && value !== null) return [value as Record<string, unknown>]
  return []
}

/* ════════════════════════════════════════════════════════════════
   CPU
   ════════════════════════════════════════════════════════════════ */

/** 已知的「单插槽双 CCD」锐龙型号。
 *  ⚠ 这是经验型号表,不是精确拓扑检测:Windows 消费级平台没有
 *  可靠的公开 API 能直接枚举 CCD,所以只能按型号名匹配。
 *  新型号发布后需要手动补充。 */
const MULTI_CCD_PATTERN = /Ryzen\s+9\s+(3900|3950|5900|5950|7900|7950|9900|9950)/i

async function detectCpu(warnings: string[]): Promise<CpuInfo> {
  const logicalCores = os.cpus().length
  let name = os.cpus()[0]?.model?.trim() ?? '未知 CPU'
  let physicalCores: number | null = null

  const data = await runPsJson(
    `Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json`
  )
  const rows = asArray(data)
  if (rows.length > 0) {
    // 多路 CPU 极罕见,但求和处理也不费事
    let total = 0
    for (const row of rows) {
      const cores = Number(row.NumberOfCores)
      if (Number.isFinite(cores) && cores > 0) total += cores
      if (typeof row.Name === 'string' && row.Name.trim()) name = row.Name.trim()
    }
    if (total > 0) physicalCores = total
  }
  if (physicalCores === null) {
    warnings.push('无法查询物理核心数(WMI 失败),线程数建议改为手动确认。')
  }

  return {
    name,
    physicalCores,
    logicalCores,
    isKnownMultiCcd: MULTI_CCD_PATTERN.test(name)
  }
}

/* ════════════════════════════════════════════════════════════════
   GPU
   ════════════════════════════════════════════════════════════════ */

function vendorOf(name: string): GpuVendor {
  const lower = name.toLowerCase()
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b/.test(lower)) return 'nvidia'
  if (/\bamd\b|radeon|firepro/.test(lower)) return 'amd'
  if (/intel|\barc\b|\biris\b|\buhd\b/.test(lower)) return 'intel'
  return 'unknown'
}

/** 明显不是真实显卡的设备(远程桌面、虚拟显示器驱动等),直接过滤。 */
const VIRTUAL_GPU_PATTERN = /basic (display|render)|remote|virtual|citrix|vmware|vnc|parsec|spacedesk/i

/** WMI AdapterRAM 是 uint32,≥4GB 的卡会被截断到 4GB 附近,这种值不可信。 */
const WMI_VRAM_SUSPECT = 4 * 1024 ** 3 - 16 * 1024 ** 2 // 4GB 减一点余量

interface RegistryVram {
  driverDesc: string
  bytes: number
}

/** 从显卡类注册表读 64 位真实显存(HardwareInformation.qwMemorySize)。
 *  {4d36e968-...} 是 Windows 固定的「显示适配器」设备类 GUID。 */
async function readRegistryVram(): Promise<RegistryVram[]> {
  const data = await runPsJson(
    `Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' ` +
      `-ErrorAction SilentlyContinue | ` +
      `Select-Object DriverDesc,'HardwareInformation.qwMemorySize' | ConvertTo-Json`
  )
  const result: RegistryVram[] = []
  for (const row of asArray(data)) {
    const desc = row.DriverDesc
    const size = row['HardwareInformation.qwMemorySize']
    if (typeof desc === 'string' && typeof size === 'number' && size > 0) {
      result.push({ driverDesc: desc.trim(), bytes: size })
    }
  }
  return result
}

interface NvidiaSmiGpu {
  name: string
  vramBytes: number
  driverVersion: string
}

/** nvidia-smi 随 NVIDIA 驱动安装,在 PATH 里;没有 N 卡时命令不存在,返回 null。 */
async function queryNvidiaSmi(): Promise<NvidiaSmiGpu[] | null> {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,driver_version',
    '--format=csv,noheader,nounits'
  ])
  if (!out) return null
  const gpus: NvidiaSmiGpu[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length < 3 || !parts[0]) continue
    const mib = Number(parts[1])
    if (!Number.isFinite(mib) || mib <= 0) continue
    gpus.push({ name: parts[0], vramBytes: mib * 1024 ** 2, driverVersion: parts[2] })
  }
  return gpus.length > 0 ? gpus : null
}

async function detectGpus(
  warnings: string[]
): Promise<{ gpus: GpuInfo[]; nvidiaDriverVersion: string | null }> {
  // ① WMI 作为「存在哪些显卡」的权威名单
  const wmiData = await runPsJson(
    `Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json`
  )
  const wmiRows = asArray(wmiData).filter(
    (row) => typeof row.Name === 'string' && !VIRTUAL_GPU_PATTERN.test(row.Name as string)
  )
  if (wmiRows.length === 0) {
    warnings.push('没有检测到任何显卡(WMI 查询失败或为空),将按纯 CPU 处理。')
  }

  // ② 两个增强来源并行查
  const [registryVram, smiGpus] = await Promise.all([readRegistryVram(), queryNvidiaSmi()])
  const nvidiaDriverVersion = smiGpus?.[0]?.driverVersion ?? null

  const gpus: GpuInfo[] = []
  for (const row of wmiRows) {
    const name = (row.Name as string).trim()
    const vendor = vendorOf(name)
    let vramBytes: number | null = null
    let vramSource: GpuInfo['vramSource'] = 'unknown'

    // 优先级 1:nvidia-smi(N 卡最准)
    if (vendor === 'nvidia' && smiGpus) {
      const match = smiGpus.find(
        (g) => g.name.toLowerCase().includes(name.toLowerCase()) ||
               name.toLowerCase().includes(g.name.toLowerCase())
      ) ?? (smiGpus.length === 1 ? smiGpus[0] : undefined)
      if (match) {
        vramBytes = match.vramBytes
        vramSource = 'nvidia-smi'
      }
    }

    // 优先级 2:注册表 qwMemorySize(64 位,不截断)
    if (vramBytes === null) {
      const match = registryVram.find((r) => r.driverDesc === name)
      if (match) {
        vramBytes = match.bytes
        vramSource = 'registry'
      }
    }

    // 优先级 3:WMI AdapterRAM,且仅当数值没到截断边界才采信
    if (vramBytes === null) {
      const wmiRam = Number(row.AdapterRAM)
      if (Number.isFinite(wmiRam) && wmiRam > 0) {
        if (wmiRam < WMI_VRAM_SUSPECT) {
          vramBytes = wmiRam
          vramSource = 'wmi'
        } else {
          warnings.push(
            `「${name}」的显存只能从 WMI 查到约 4GB,该值可能被 32 位截断,已标记为未知。`
          )
        }
      }
    }

    gpus.push({ name, vendor, vramBytes, vramSource })
  }

  return { gpus, nvidiaDriverVersion }
}

/* ════════════════════════════════════════════════════════════════
   推荐逻辑
   ════════════════════════════════════════════════════════════════ */

/** RTX 50 系(Blackwell):需要 CUDA 13.x。 */
const BLACKWELL_PATTERN = /RTX\s*50\d{2}/i
/** CUDA 13 已移除支持的老架构(Maxwell/Pascal/Volta):只能用 12.4。 */
const PRE_TURING_PATTERN = /GTX\s*(7|8|9)\d{2}\b|GTX\s*10\d{2}\b|TITAN\s*(X|Xp|V)\b/i

function recommendThreads(cpu: CpuInfo): { threads: number | null; note: string } {
  if (cpu.physicalCores === null) {
    const estimate = Math.max(1, Math.floor(cpu.logicalCores / 2) - 1)
    return {
      threads: estimate,
      note: `未能查到物理核心数,按逻辑处理器数的一半估算为 ${estimate},请根据实际情况调整。`
    }
  }
  if (cpu.isKnownMultiCcd) {
    const threads = Math.max(1, Math.floor(cpu.physicalCores / 2))
    return {
      threads,
      note:
        `检测到已知的多 CCD 处理器,按经验先用一半物理核心(${threads} 线程)起步;` +
        `这是经验值而非精确计算,实际最优值请以试用体感为准,可手动修改。`
    }
  }
  const threads = Math.max(1, cpu.physicalCores - 1)
  return {
    threads,
    note: `按「物理核心数 - 1」推荐 ${threads} 线程,给系统和前台界面留一个核心。`
  }
}

function recommend(
  cpu: CpuInfo,
  gpus: GpuInfo[],
  nvidiaDriver: string | null,
  warnings: string[]
): BackendRecommendation {
  const { threads, note } = recommendThreads(cpu)
  const base = { recommendedThreads: threads, threadsNote: note }

  const nvidia = gpus.find((g) => g.vendor === 'nvidia')
  if (nvidia) {
    const driverMajor = nvidiaDriver ? Number(nvidiaDriver.split('.')[0]) : null

    if (BLACKWELL_PATTERN.test(nvidia.name)) {
      if (driverMajor !== null && driverMajor < 580) {
        warnings.push(
          `检测到 RTX 50 系显卡但驱动版本为 ${nvidiaDriver},低于 CUDA 13 要求的 R580;建议先升级显卡驱动。`
        )
      }
      return {
        ...base,
        kind: 'cuda',
        cudaVersion: '13.x',
        reason: `检测到 ${nvidia.name}(Blackwell 架构),需要 CUDA 13 版本的后端。`
      }
    }

    if (PRE_TURING_PATTERN.test(nvidia.name)) {
      return {
        ...base,
        kind: 'cuda',
        cudaVersion: '12.4',
        reason: `检测到 ${nvidia.name},该架构已被 CUDA 13 移除支持,使用 CUDA 12.4 版本。`
      }
    }

    if (driverMajor !== null && driverMajor < 551) {
      warnings.push(
        `NVIDIA 驱动版本 ${nvidiaDriver} 较旧,CUDA 后端可能无法启动;若失败请更新驱动或改用 Vulkan 后端。`
      )
    }
    return {
      ...base,
      kind: 'cuda',
      cudaVersion: '12.4',
      reason: `检测到 ${nvidia.name},默认使用兼容范围更广的 CUDA 12.4 版本。`
    }
  }

  const amd = gpus.find((g) => g.vendor === 'amd')
  if (amd) {
    warnings.push(
      'HIP/ROCm 后端只正式支持部分 AMD 显卡型号;如果启动失败,请改用 Vulkan 后端(速度较慢但兼容性好)。'
    )
    return {
      ...base,
      kind: 'rocm',
      reason: `检测到 ${amd.name},优先尝试 HIP/Radeon 后端,失败可回落 Vulkan。`
    }
  }

  const intel = gpus.find((g) => g.vendor === 'intel')
  if (intel) {
    return {
      ...base,
      kind: 'vulkan',
      reason: `检测到 ${intel.name},使用 Vulkan 后端。`
    }
  }

  return {
    ...base,
    kind: 'cpu',
    reason: '没有检测到可用的独立显卡,使用纯 CPU 后端。'
  }
}

/* ════════════════════════════════════════════════════════════════
   总入口
   ════════════════════════════════════════════════════════════════ */

export async function detectHardware(): Promise<HardwareReport> {
  const warnings: string[] = []
  const [cpu, gpuResult] = await Promise.all([detectCpu(warnings), detectGpus(warnings)])
  const { gpus, nvidiaDriverVersion } = gpuResult

  return {
    cpu,
    ramBytes: os.totalmem(),
    gpus,
    nvidiaDriverVersion,
    recommendation: recommend(cpu, gpus, nvidiaDriverVersion, warnings),
    warnings
  }
}