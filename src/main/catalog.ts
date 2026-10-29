/**
 * 下载清单：llama.cpp 版本与资产文件名、镜像、预设模型、默认目录。
 * 这是「下载什么、从哪下」的唯一定义处；renderer 通过 setup:get-catalog 读取展示。
 */
import { app } from 'electron'
import path from 'node:path'
import type { BackendKind, CudaVersion, ModelPreset, SetupCatalog } from '../shared/ipc'
import { DEFAULT_CONTEXT_LENGTH } from '../shared/backendArgs'

/** llama.cpp release tag。loadProgress.ts 的日志关键字是按这个版本实测的，升级时一起复核。 */
export const LLAMA_TAG = 'b8868'

const OFFICIAL_RELEASE_PREFIX = 'https://github.com/ggml-org/llama.cpp/releases/download/'

export const OFFICIAL_BASE = `${OFFICIAL_RELEASE_PREFIX}${LLAMA_TAG}/`

/** GitHub 代理前缀：下载 llama.cpp 组件与 Release 更新包共用同一批镜像。 */
export const GH_PROXY_PREFIXES: readonly string[] = [
  'https://gh.llkk.cc/',
  'https://gh.idayer.com/',
  'https://ghfast.top/',
  'https://ghproxy.homeboyc.cn/',
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://ghp.ci/',
  'https://github.akams.cn/',
  'https://moeyy.cn/gh-proxy/',
  'https://mirror.ghproxy.com/',
  'https://ghproxy.cxkpro.top/'
]

/** 给一个 GitHub 直链生成「直链 + 各镜像」的尝试顺序（官方直链放最后兜底，与组件下载一致）。 */
export function withGhMirrors(url: string): string[] {
  return [...GH_PROXY_PREFIXES.map((prefix) => prefix + url), url]
}

/** 先探测 OFFICIAL_BASE；不通时按此顺序尝试镜像（最后再回到官方源兜底）。 */
export const MIRROR_BASES: readonly string[] = [...GH_PROXY_PREFIXES.map((prefix) => prefix + OFFICIAL_BASE), OFFICIAL_BASE]


export function isOfficialBase(base: string): boolean {
  return base.startsWith(OFFICIAL_RELEASE_PREFIX)
}

export interface EngineAssets {
  /** 主包 zip 文件名 */
  llama: string
  /** CUDA 运行时 zip（仅 CUDA 后端需要） */
  cudart: string | null
}

/** 按后端类别决定下载哪个 zip。 */
export function engineAssetsFor(kind: BackendKind, cudaVersion?: CudaVersion): EngineAssets {
  switch (kind) {
    case 'rocm':
      return { llama: `llama-${LLAMA_TAG}-bin-win-hip-radeon-x64.zip`, cudart: null }
    case 'vulkan':
      return { llama: `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`, cudart: null }
    case 'cuda': {
      const ver = cudaVersion === '13.x' ? '13.1' : '12.4'
      return {
        llama: `llama-${LLAMA_TAG}-bin-win-cuda-${ver}-x64.zip`,
        cudart: `cudart-llama-bin-win-cuda-${ver}-x64.zip`
      }
    }
    default:
      return { llama: `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`, cudart: null }
  }
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'qwen-9b-q4',
    name: 'Qwen3.5 9B（Q4_K_M）',
    sizeLabel: '约 5.6 GB · 适合 8GB 显存或 16GB 内存',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-9B-GGUF/resolve/master/Qwen3.5-9B-Q4_K_M.gguf'
  },
  {
    id: 'qwen-9b-q8',
    name: 'Qwen3.5 9B（Q8_0）',
    sizeLabel: '约 9.8 GB · 适合 12GB 显存或 24GB 内存',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-9B-GGUF/resolve/master/Qwen3.5-9B-Q8_0.gguf'
  },
  {
    id: 'qwen-35b-q4',
    name: 'Qwen3.5 35B-A3B（Q4_K_M）',
    sizeLabel: '约 21.4 GB · 适合 16GB 显存 + 充足内存',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/master/Qwen3.5-35B-A3B-Q4_K_M.gguf'
  },
  {
    id: 'qwen-35b-q8',
    name: 'Qwen3.5 35B-A3B（Q8_0）',
    sizeLabel: '约 37.5 GB · 写作效果最佳，需充足内存/显存',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/master/Qwen3.5-35B-A3B-Q8_0.gguf'
  }
]

/** 默认把引擎与模型放在「文档/PickWord/models」：用户看得见、卸载不会被删。 */
export function defaultTargetDir(): string {
  return path.join(app.getPath('documents'), 'PickWord', 'models')
}

export function getSetupCatalog(): SetupCatalog {
  return {
    engineTag: LLAMA_TAG,
    models: [...MODEL_PRESETS],
    defaultTargetDir: defaultTargetDir(),
    defaultContextLength: DEFAULT_CONTEXT_LENGTH
  }
}
