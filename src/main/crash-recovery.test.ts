import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { CrashLogger } from './crash-recovery'
import {
  attachCrashRecovery,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_WINDOW_MS,
  type CrashSource
} from './crash-recovery'

function fakeSource(): { source: CrashSource; crash: (reason?: string) => void } {
  const emitter = new EventEmitter()
  return {
    source: emitter as unknown as CrashSource,
    crash: (reason = 'crashed') => emitter.emit('render-process-gone', {}, { reason, exitCode: 1 })
  }
}

function fakeLogger(): { logger: CrashLogger; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = []
  const logger = {
    info: () => {},
    warn: () => {},
    error: (_event: string, fields?: Record<string, unknown>) => {
      entries.push(fields ?? {})
    }
  } as unknown as CrashLogger
  return { logger, entries }
}

describe('attachCrashRecovery', () => {
  it('崩了就拉起来一次，并记下原因', () => {
    const { source, crash } = fakeSource()
    const { logger, entries } = fakeLogger()
    let reloads = 0

    const recovery = attachCrashRecovery(source, {
      label: '画布',
      logger,
      reload: () => {
        reloads++
      }
    })

    crash('oom')
    expect(reloads).toBe(1)
    expect(recovery.attempts()).toBe(1)
    expect(entries[0]).toMatchObject({ label: '画布', reason: 'oom', recovering: true })
  })

  it('一轮里连续崩超过上限就停手，不再重载', () => {
    const { source, crash } = fakeSource()
    const { logger } = fakeLogger()
    let reloads = 0

    const recovery = attachCrashRecovery(source, {
      label: '标签',
      logger,
      reload: () => {
        reloads++
      }
    })

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS + 2; i++) crash()
    expect(reloads).toBe(MAX_RECOVERY_ATTEMPTS)
    expect(recovery.givenUp()).toBe(true)
  })

  it('隔得够久的崩溃算新的一轮，重新给机会', () => {
    const { source, crash } = fakeSource()
    const { logger } = fakeLogger()
    let reloads = 0
    let clock = 1_000_000

    attachCrashRecovery(source, {
      label: '标签',
      logger,
      reload: () => {
        reloads++
      },
      now: () => clock
    })

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) crash()
    expect(reloads).toBe(MAX_RECOVERY_ATTEMPTS)

    // 时间往前推过窗口，之前那些记录不再算数
    clock += RECOVERY_WINDOW_MS + 1
    crash()
    expect(reloads).toBe(MAX_RECOVERY_ATTEMPTS + 1)
  })
})
