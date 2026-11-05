/**
 * renderer 可见的 window.api 类型声明。
 * 类型直接取自 preload/index.ts 的 api 对象：preload 加一个方法，renderer 立即可用且类型一致。
 * 浏览器演示模式下没有 preload，因此是可选属性；renderer 只通过 lib/platform.ts 访问它。
 */
import type { WriterApi } from './index'

declare global {
  interface Window {
    api?: WriterApi
  }
}

export type { WriterApi }
