/**
 * 系统已装字体的清单（主进程）。
 *
 * 为什么要在主进程做：renderer 里只有 `navigator.queryLocalFonts()` 能枚举「全部」字体，
 * 但那需要 local-fonts 权限，并且要在用户手势里调用；只靠探测手段只能量我们自己列出的
 * 候选名字，用户自己装的字体就看不见了。所以这里从系统侧拿一份完整名字清单，
 * 交给 renderer 用 canvas 量宽逐个验证（见 renderer 的 lib/fonts.ts）。
 *
 * Windows：查注册表的字体表（HKLM 是全机安装的字体，HKCU 是「仅为我安装」的字体）。
 *   值名就是字体的显示名，例如「微软雅黑 & Microsoft YaHei & Microsoft YaHei UI (TrueType)」
 *   「LXGW WenKai (TrueType)」；这里只做名字清洗（去 @ 竖排前缀、去 (TrueType) 之类后缀、
 *   按 & 拆别名），不判断是不是中文字体——那件事交给 renderer 量宽去判。
 * 其他平台：返回空数组（本应用只发 Windows 包），renderer 会退回自己的候选清单探测。
 */

import { execFile } from 'node:child_process'

/**
 * 字体名从两处取，互为补充：
 *   1. GDI+ 的 InstalledFontCollection —— 给的是**字体族名**，最贴近 CSS 里的 font-family
 *      （例如「微软雅黑」「思源宋体 CN」），个别「仅为我安装」的字体它可能漏掉；
 *   2. 注册表的字体表（HKLM 全机 / HKCU 仅当前用户）—— 值名是显示名，能补上一条漏的，
 *      但可能带 "(TrueType)" 后缀或 "A & B" 别名，需要清洗。
 * 两处都只是「候选名字」：装没装最终由 renderer 逐个量像素验证（见 renderer 的 lib/fonts.ts）。
 */
const FONT_REGISTRY_KEYS = [
  'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
]

/** 名字最多这么长，超了就不像字体名（防御注册表里的脏数据）。 */
const MAX_NAME_LEN = 64
/** 名单上限，避免异常机器上把几万个名字送进 IPC。 */
const MAX_FONTS = 4000

/**
 * 洗一个注册表值名：
 *   · 去掉竖排字体名的前导 '@'（"@SimSun & NSimSun"）；
 *   · 去掉结尾的格式说明（"(TrueType)" / "(OpenType)" / "(All res)"）;
 *   · 按 '&' 拆出别名（"宋体 & 新宋体" 是同一款字体的两个名字，renderer 会按宽度指纹去重）。
 * 只做字符串清洗，不做字体存在性判断。
 */
export function parseFontRegistryName(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const trimmed = raw.trim().replace(/^@+/, '')
  if (!trimmed) return []
  const withoutFormat = trimmed.replace(/\s*\([^()]*\)\s*$/, '')
  return withoutFormat
    .split('&')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= MAX_NAME_LEN)
}

/** 跑 PowerShell，输出要求是 JSON（脚本里 ConvertTo-Json；中文以 \uXXXX 转义，不受代码页影响）。 */
function runPsJson(script: string): Promise<unknown | null> {
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) return resolve(null)
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/** PowerShell 脚本：输出 { gdi: 字体族名[], registry: 注册表值名[] }（任一环节失败则该项为空数组）。 */
function fontNamesScript(): string {
  const paths = FONT_REGISTRY_KEYS.map((key) => `'${key}'`).join(',')
  return (
    `$gdi = @(); ` +
    `try { Add-Type -AssemblyName System.Drawing; ` +
    `$gdi = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { [string]$_.Name }) } catch { $gdi = @() }; ` +
    `$reg = New-Object System.Collections.Generic.List[string]; ` +
    `foreach ($p in @(${paths})) { if (Test-Path $p) { foreach ($n in (Get-Item $p).Property) { [void]$reg.Add([string]$n) } } }; ` +
    `ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ gdi = @($gdi); registry = @($reg) })`
  )
}

/** 把 PowerShell 的输出整理成待验证的名字清单（保序、去重、清洗注册表显示名）。 */
export function parseFontListPayload(json: unknown): string[] {
  const payload = (typeof json === 'object' && json !== null ? json : {}) as { gdi?: unknown; registry?: unknown }
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value ? [value] : [])

  const seen = new Set<string>()
  const names: string[] = []
  const push = (name: string): boolean => {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > MAX_NAME_LEN) return false
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    names.push(trimmed)
    return names.length >= MAX_FONTS
  }

  // GDI+ 族名在前（它就是 CSS 用的名字），注册表显示名补在后面。
  for (const item of asArray(payload.gdi)) {
    if (typeof item === 'string' && push(item)) return names
  }
  for (const item of asArray(payload.registry)) {
    for (const name of parseFontRegistryName(item)) {
      if (push(name)) return names
    }
  }
  return names
}

let cache: string[] | null = null

/**
 * 系统字体显示名清单（已清洗、去重、保序）。失败（非 Windows / PowerShell 受限）返回空数组。
 * 结果在进程内缓存；装完新字体要重测时传 force = true。
 */
export async function listSystemFontNames(force = false): Promise<string[]> {
  if (cache && !force) return cache
  if (process.platform !== 'win32') {
    cache = []
    return cache
  }

  const json = await runPsJson(fontNamesScript())
  cache = parseFontListPayload(json)
  return cache
}
