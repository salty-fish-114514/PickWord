/**
 * llama-server 流式响应（SSE）的最小解析：事件以空行分隔，每行 `data: {...}`。
 * 单独成文件是为了不依赖 electron，能直接跑冒烟测试。
 */
import { isObj } from './ioUtils'

/** 解析 llama-server 的 SSE 流：每个事件是 `data: {...}\n\n`。 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: Record<string, unknown>) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (block: string): void => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const json = line.slice(5).trim()
      if (!json || json === '[DONE]') continue
      try {
        const parsed: unknown = JSON.parse(json)
        if (isObj(parsed)) onEvent(parsed)
      } catch {
        /* 半截 JSON 不该出现（事件以空行分隔）；忽略 */
      }
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split !== -1) {
      handle(buffer.slice(0, split))
      buffer = buffer.slice(split + 2)
      split = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) handle(buffer)
}

