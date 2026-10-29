/**
 * 把各种形状的异常整理成可写进 JSON 日志的纯数据。
 * 纯函数、不依赖 Electron，便于单测。
 */

/** 单条文本上限，防止一个超长堆栈把日志文件撑爆 */
export const MAX_TEXT = 8000

export function clip(value: unknown, max: number = MAX_TEXT): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 处理 `unhandledRejection` 的 reason：可能是 Error，也可能是任意值。 */
export function describeReason(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: clip(reason.message),
      stack: clip(reason.stack)
    }
  }
  return { value: clip(stringify(reason)) }
}

/** 处理渲染进程上报的内容，字段必须来自我们认识的那几个，其余一律丢掉。 */
export function describeRendererPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return { message: clip(stringify(payload)) }
  }
  const record = payload as Record<string, unknown>
  return {
    message: clip(record['message']) ?? clip(stringify(record['message'])),
    stack: clip(record['stack']),
    source: clip(record['source'])
  }
}
