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
 *  这正好绕开了之前遇到的 PowerShell 中文乱码问题。
 *
 *  脚本通过 -EncodedCommand(Base64 的 UTF-16LE)传入,而不是 -Command 直接拼字符串:
 *  这样脚本里可以放心写多行 C# 源码、大括号、单双引号,不会被 Windows 命令行的
 *  引号/转义规则破坏。 */
async function runPsJson(script: string): Promise<unknown | null> {
  // 强制 PowerShell 向 stdout 输出 UTF-8 字节,避免 Node 收到 GBK 乱码
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
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

/** 把未知值安全转成正整数;不合法返回 null。 */
function toPositiveInt(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/* ════════════════════════════════════════════════════════════════
   CPU
   ════════════════════════════════════════════════════════════════ */

/** 已知的「单插槽多 CCD」型号表。
 *  现在只作为拓扑检测失败时的兜底,以及对实测结果的补充;
 *  真正的判断优先走 GetLogicalProcessorInformationEx 的 L3 缓存域计数。
 *    - Ryzen 9 桌面:3900/3950/5900/5950/7900/7950/9900/9950(含 X/XT/X3D 后缀)
 *    - Ryzen 9 移动 HX:7945HX/7945HX3D/9955HX/9955HX3D(两颗桌面 CCD)
 *    - Threadripper / EPYC:必然多 CCD */
const MULTI_CCD_PATTERN =
  /Ryzen\s+9\s+(3900|3950|5900|5950|7900|7950|7945|9900|9950|9955)|Threadripper|EPYC/i

/** 实测得到的 CPU 拓扑(模块私有,不出现在 IPC 接口里)。 */
interface CpuTopology {
  /** 物理核心总数(所有插槽、所有处理器组)。 */
  physicalCores: number
  /** 逻辑处理器总数(跨处理器组,>64 也准确)。 */
  logicalCores: number
  /** 物理插槽数。 */
  packages: number
  /** L3 缓存域数。AMD 每个 CCD 一块独立 L3,所以单插槽下 L3 域数 ≈ CCD 数。 */
  l3Domains: number
  /** 是否为混合架构(Intel P/E 核,或 AMD Zen5/Zen5c 这类异构核)。 */
  isHybrid: boolean
  /** 性能核数量。混合架构下 = EfficiencyClass 最高的那一类核心数;
   *  非混合架构下 = physicalCores。 */
  performanceCores: number
}

/** CpuInfo 接口不能改,所以把详细拓扑挂在对象身上供 recommendThreads 读取。 */
const topologyCache = new WeakMap<CpuInfo, CpuTopology>()

/** 通过 Win32 API GetLogicalProcessorInformationEx 枚举真实拓扑。
 *
 *  为什么不继续用 WMI:
 *    Win32_Processor.NumberOfCores 来自 SMBIOS Type 4(固件自报),不是 OS 实测;
 *    虚拟机、OEM 固件、大小核都可能让它失真,而且它对 P/E 核完全不区分。
 *  为什么不用 os.cpus().length:
 *    Windows 上 >64 逻辑处理器时会被处理器组截断到当前组的数量。
 *
 *  结构体偏移(x64,见 sysinfoapi.h):
 *    SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX: Relationship@0 (DWORD), Size@4 (DWORD), union@8
 *    PROCESSOR_RELATIONSHIP: Flags@8, EfficiencyClass@9, Reserved[20], GroupCount@30 (WORD),
 *                            GroupMask[]@32 (GROUP_AFFINITY 每项 16 字节: Mask@0 (8B) Group@8 (2B) Reserved(6B))
 *    CACHE_RELATIONSHIP:     Level@8, Associativity@9, LineSize@10, CacheSize@12, Type@16, ...
 *
 *  失败场景(都会返回 null,由调用方回退到 WMI):
 *    - PowerShell 处于 Constrained Language Mode / AppLocker 禁用 Add-Type
 *    - 没有 .NET Framework C# 编译器(极少见)
 */
async function queryCpuTopology(): Promise<CpuTopology | null> {
  const script = `
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CpuTopo {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetLogicalProcessorInformationEx(int relationship, IntPtr buffer, ref uint length);
  [DllImport("kernel32.dll")]
  static extern uint GetActiveProcessorCount(ushort groupNumber);

  static int PopCount(long v) {
    ulong x = (ulong)v; int c = 0;
    while (x != 0) { x &= x - 1; c++; }
    return c;
  }

  // 返回: [cores, logical, packages, l3, classCount, perfCores, activeProcs]
  public static long[] Query() {
    uint len = 0;
    GetLogicalProcessorInformationEx(0xffff, IntPtr.Zero, ref len);
    if (len == 0) throw new Exception("GetLogicalProcessorInformationEx: zero length");
    IntPtr buf = Marshal.AllocHGlobal((int)len);
    try {
      if (!GetLogicalProcessorInformationEx(0xffff, buf, ref len))
        throw new Exception("GetLogicalProcessorInformationEx failed: " + Marshal.GetLastWin32Error());
      long cores = 0, logical = 0, packages = 0, l3 = 0;
      int maxClass = -1;
      var classCores = new Dictionary<int, long>();
      long off = 0;
      while (off < len) {
        IntPtr p = new IntPtr(buf.ToInt64() + off);
        int rel = Marshal.ReadInt32(p, 0);
        int size = Marshal.ReadInt32(p, 4);
        if (size <= 0) break;
        if (rel == 0) {                       // RelationProcessorCore
          int eff = Marshal.ReadByte(p, 9);
          int groupCount = Marshal.ReadInt16(p, 30);
          for (int g = 0; g < groupCount; g++)
            logical += PopCount(Marshal.ReadInt64(p, 32 + g * 16));
          cores++;
          long c; classCores.TryGetValue(eff, out c); classCores[eff] = c + 1;
          if (eff > maxClass) maxClass = eff;
        } else if (rel == 2) {                // RelationCache
          if (Marshal.ReadByte(p, 8) == 3) l3++;
        } else if (rel == 3) {                // RelationProcessorPackage
          packages++;
        }
        off += size;
      }
      long perf = maxClass >= 0 ? classCores[maxClass] : cores;
      long active = GetActiveProcessorCount(0xffff);   // ALL_PROCESSOR_GROUPS
      return new long[] { cores, logical, packages, l3, classCores.Count, perf, active };
    } finally {
      Marshal.FreeHGlobal(buf);
    }
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
$r = [CpuTopo]::Query()
[pscustomobject]@{
  cores = $r[0]; logical = $r[1]; packages = $r[2]; l3 = $r[3]
  classCount = $r[4]; perfCores = $r[5]; activeProcs = $r[6]
} | ConvertTo-Json -Compress
`
  const data = await runPsJson(script)
  const row = asArray(data)[0]
  if (!row) return null

  const cores = toPositiveInt(row.cores)
  if (cores === null) return null

  // 逻辑处理器数:按核心掩码 popcount 得到的值优先;为 0 时用 GetActiveProcessorCount 兜底
  const logical = toPositiveInt(row.logical) ?? toPositiveInt(row.activeProcs) ?? cores
  const packages = toPositiveInt(row.packages) ?? 1
  const l3Domains = toPositiveInt(row.l3) ?? 1
  const classCount = toPositiveInt(row.classCount) ?? 1
  const perfCores = toPositiveInt(row.perfCores) ?? cores
  const isHybrid = classCount > 1 && perfCores < cores

  return {
    physicalCores: cores,
    logicalCores: Math.max(logical, cores),
    packages,
    l3Domains,
    isHybrid,
    performanceCores: isHybrid ? perfCores : cores
  }
}

interface WmiProcessor {
  name: string | null
  cores: number | null
  logical: number | null
}

/** WMI 回退来源。多路 CPU 会返回多行,求和。 */
async function queryWmiProcessor(): Promise<WmiProcessor | null> {
  const data = await runPsJson(
    `Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json`
  )
  const rows = asArray(data)
  if (rows.length === 0) return null

  let name: string | null = null
  let cores = 0
  let logical = 0
  for (const row of rows) {
    cores += toPositiveInt(row.NumberOfCores) ?? 0
    logical += toPositiveInt(row.NumberOfLogicalProcessors) ?? 0
    if (typeof row.Name === 'string' && row.Name.trim()) name = row.Name.trim()
  }
  return {
    name,
    cores: cores > 0 ? cores : null,
    logical: logical > 0 ? logical : null
  }
}

async function detectCpu(warnings: string[]): Promise<CpuInfo> {
  const fallbackLogical = os.cpus().length
  let name = os.cpus()[0]?.model?.trim() ?? '未知 CPU'

  // 两个来源并行查:拓扑 API 是权威,WMI 做回退与交叉校验
  const [topology, wmi] = await Promise.all([queryCpuTopology(), queryWmiProcessor()])

  if (wmi?.name) name = wmi.name

  let physicalCores: number | null = null
  let logicalCores = fallbackLogical

  if (topology) {
    physicalCores = topology.physicalCores
    logicalCores = topology.logicalCores
    // WMI 与实测不一致不影响结果,但值得让用户知道(常见于虚拟机/固件报错)
    if (wmi?.cores !== null && wmi?.cores !== undefined && wmi.cores !== topology.physicalCores) {
      warnings.push(
        `固件(WMI)报告的物理核心数为 ${wmi.cores},但系统实测拓扑为 ${topology.physicalCores},已采用实测值。`
      )
    }
  } else if (wmi) {
    physicalCores = wmi.cores
    if (wmi.logical !== null) logicalCores = Math.max(wmi.logical, fallbackLogical)
    warnings.push(
      '无法通过系统 API 枚举 CPU 拓扑(可能是 PowerShell 受限),已回退到 WMI;' +
        '大小核与多 CCD 的识别可能不准确。'
    )
  }

  if (physicalCores === null) {
    warnings.push('无法查询物理核心数(拓扑 API 与 WMI 均失败),线程数建议改为手动确认。')
  }

  // 多 CCD 判定:实测拓扑优先,型号表补充。
  //   单插槽下 L3 域数 > 插槽数 ⇒ 多个 CCD(AMD 每个 CCD 一块独立 L3)。
  //   ≥12 核门槛:Zen 2 的 3600/3700X 是单 CCD 但双 CCX(每 CCX 一块 L3),
  //   这类 ≤8 核的不值得按多 CCD 把线程砍半。
  const topoMultiCcd =
    topology !== null &&
    topology.l3Domains > topology.packages &&
    topology.physicalCores >= 12
  const isKnownMultiCcd = MULTI_CCD_PATTERN.test(name) || topoMultiCcd

  const cpu: CpuInfo = { name, physicalCores, logicalCores, isKnownMultiCcd }
  if (topology) topologyCache.set(cpu, topology)
  return cpu
}

/* ════════════════════════════════════════════════════════════════
   GPU(未改动)
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

    // 标记集成显卡：Intel 核显、AMD APU 内置显卡
    const isIntegrated = vendor === 'intel' || 
      /\b(integrated|graphics|igpu|apu)\b/i.test(name) ||
      (vendor === 'amd' && /Radeon\s*(Graphics|Radeon|680M|660M|780M|890M)/i.test(name) && vramBytes !== null && vramBytes < 512 * 1024 * 1024)
    gpus.push({ name, vendor, vramBytes, vramSource, isIntegrated })
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

  const topology = topologyCache.get(cpu)

  // 混合架构(Intel P/E 核、AMD Zen5/Zen5c):线程数 = 性能核数。
  // 推理是同步并行的,只要有一个线程落在能效核上,整轮计算就会被它拖慢;
  // 系统和前台界面可以跑在能效核上,所以这里不再额外减 1。
  if (topology?.isHybrid) {
    const threads = Math.max(1, topology.performanceCores)
    const efficiencyCores = topology.physicalCores - topology.performanceCores
    return {
      threads,
      note:
        `检测到混合架构处理器(${topology.performanceCores} 个性能核 + ${efficiencyCores} 个能效核),` +
        `推荐线程数 = 性能核数 ${threads};把线程开到能效核上通常会拖慢整体速度,可手动修改。`
    }
  }

  if (cpu.isKnownMultiCcd) {
    const threads = Math.max(1, Math.floor(cpu.physicalCores / 2))
    const how = topology && topology.l3Domains > topology.packages
      ? `实测到 ${topology.l3Domains} 个 L3 缓存域(即多个 CCD)`
      : '已知的多 CCD 型号'
    return {
      threads,
      note:
        `检测到${how},按经验先用一半物理核心(${threads} 线程)起步;` +
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
  warnings: string[],
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
  const [cpu, gpuResult] = await Promise.all([
    detectCpu(warnings),
    detectGpus(warnings)
  ])
  const { gpus, nvidiaDriverVersion } = gpuResult

  // 按显存从大到小排序 GPU（方便 UI 显示，独显优先）
  gpus.sort((a, b) => {
    const aDisc = !a.isIntegrated ? 1 : 0
    const bDisc = !b.isIntegrated ? 1 : 0
    if (aDisc !== bDisc) return bDisc - aDisc  // 独显排在前面
    const aVram = a.vramBytes ?? 0
    const bVram = b.vramBytes ?? 0
    return bVram - aVram
  })

  // 不再自动猜测 --device 值：
  // llama.cpp 的设备名（ROCm0 / CUDA0 / Vulkan0）取决于编译时启用了哪些后端，
  // 无法从操作系统信息推断。正确做法是部署后用 --list-devices 让 llama-server 自己报告。
  // 这里只标记 isIntegrated 供 UI 显示参考。

  return {
    cpu,
    ramBytes: os.totalmem(),
    gpus,
    nvidiaDriverVersion,
    recommendation: recommend(cpu, gpus, nvidiaDriverVersion, warnings),
    warnings
  }
}