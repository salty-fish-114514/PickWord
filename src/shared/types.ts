export type BackendState = 'stopped' | 'starting' | 'loading' | 'ready' | 'error'

export interface BackendStatus {
  state: BackendState
  message: string
  baseUrl: string // 例如 http://127.0.0.1:18765，前端以后请求候选词要用
}

/**
 * 模型加载进度(主进程推送)。
 * fraction 是「文字阶段标记」和「历史耗时比例」两者的混合估算,
 * 不是精确的字节级进度——llama.cpp 的日志格式本身也不提供精确百分比。
 */
export interface BackendProgress {
  fraction: number // 0~1
  summary: string
  etaSeconds?: number
  prefillTokensPerSecond?: number
}