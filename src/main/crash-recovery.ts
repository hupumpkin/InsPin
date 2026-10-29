import { LogEvent } from './logger'

/** 只用到 `error`；浏览器标签那边有自己更窄的 logger 接口，不必为此把它撑大。 */
export interface CrashLogger {
  error(event: string, fields?: Record<string, unknown>): void
}

/**
 * 渲染进程崩溃后的自动恢复（路线图 D6a.5）。
 *
 * 浏览器标签、画布、参考快照各自是独立的 `WebContents`，任何一个崩了，用户看到的
 * 是"那一块白了 / 没了"。以前只记一条日志就完了，现在**顺手把它拉起来**。
 *
 * 但不能无脑重试：如果页面一加载就崩（比如某个网页本身有毒），不停重载会变成一个
 * 打不开的循环、还会把日志刷爆。所以给一个**时间窗 + 次数上限**，超了就停手，
 * 只留日志——宁可让用户看见一块空白，也不要转成风扇狂转。
 */

/** 这段时间内的崩溃算"同一轮" */
export const RECOVERY_WINDOW_MS = 60_000
/** 一轮里最多自动拉起几次 */
export const MAX_RECOVERY_ATTEMPTS = 3

/** 只用到 `on`，抽成最小接口，测试里给一个普通 EventEmitter 就行。 */
export interface CrashSource {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: { reason: string; exitCode: number }) => void
  ): unknown
}

export interface CrashRecoveryOptions {
  /** 日志里用来认人（"画布" / "浏览器标签" / "参考快照"） */
  label: string
  logger: CrashLogger
  /** 真的去重新加载这一块；注入进来便于测试 */
  reload: () => void
  /** 时钟（测试用） */
  now?: () => number
}

export interface CrashRecovery {
  /** 本次会话里已经自动拉起了几次 */
  attempts(): number
  /** 是否已经放弃自动恢复（超过上限） */
  givenUp(): boolean
}

export function attachCrashRecovery(
  source: CrashSource,
  options: CrashRecoveryOptions
): CrashRecovery {
  const now = options.now ?? ((): number => Date.now())
  let stamps: number[] = []
  let givenUp = false

  source.on('render-process-gone', (_event, details) => {
    const at = now()
    // 只保留窗口内的记录：隔了很久的崩溃算新的一轮
    stamps = stamps.filter((stamp) => at - stamp < RECOVERY_WINDOW_MS)

    if (stamps.length >= MAX_RECOVERY_ATTEMPTS) {
      givenUp = true
      options.logger.error(LogEvent.rendererGone, {
        label: options.label,
        reason: details.reason,
        exitCode: details.exitCode,
        attempts: stamps.length,
        givingUp: true
      })
      return
    }

    stamps.push(at)
    options.logger.error(LogEvent.rendererGone, {
      label: options.label,
      reason: details.reason,
      exitCode: details.exitCode,
      attempts: stamps.length,
      recovering: true
    })
    options.reload()
  })

  return {
    attempts: () => stamps.length,
    givenUp: () => givenUp
  }
}
