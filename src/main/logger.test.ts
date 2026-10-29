import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger, logFileName, pruneOldLogs, type LogRecord } from './logger'

function readRecords(file: string): LogRecord[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogRecord)
}

describe('logFileName', () => {
  it('按本地日期生成文件名，个位数月日补零', () => {
    expect(logFileName(new Date(2026, 9, 14))).toBe('ins-pin-2026-10-14.jsonl')
    expect(logFileName(new Date(2026, 0, 5))).toBe('ins-pin-2026-01-05.jsonl')
  })
})

describe('pruneOldLogs', () => {
  let scratch: string | undefined

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('只删除超过保留期的 jsonl，保留新日志和其他文件', () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-log-'))
    const logDir = join(scratch, 'logs')
    mkdirSync(logDir)

    const now = new Date(2026, 9, 22).getTime()
    const old = join(logDir, 'ins-pin-2026-01-01.jsonl')
    const fresh = join(logDir, 'ins-pin-2026-10-21.jsonl')
    const other = join(logDir, 'notes.txt')
    for (const file of [old, fresh, other]) writeFileSync(file, '')

    const oldTime = new Date(now - 20 * 24 * 60 * 60 * 1000)
    const freshTime = new Date(now - 24 * 60 * 60 * 1000)
    utimesSync(old, oldTime, oldTime)
    utimesSync(fresh, freshTime, freshTime)

    expect(pruneOldLogs(logDir, 14, now)).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('目录不存在时不抛错', () => {
    expect(pruneOldLogs('/definitely/not/here/ins-pin')).toBe(0)
  })
})

describe('Logger', () => {
  let scratch: string | undefined

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('每条日志是一行合法 JSON，含时间、级别、事件与自定义字段', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-log-'))
    const logDir = join(scratch, 'nested', 'logs')
    const logger = new Logger(logDir, 'test.jsonl')

    logger.info('app.start', { appVersion: '0.1.0' })
    logger.warn('window.created', { width: 1500 })
    await logger.close()

    const records = readRecords(join(logDir, 'test.jsonl'))
    expect(records).toHaveLength(2)

    const [first, second] = records
    expect(first?.event).toBe('app.start')
    expect(first?.level).toBe('info')
    expect(first?.appVersion).toBe('0.1.0')
    expect(Number.isNaN(Date.parse(String(first?.ts)))).toBe(false)

    expect(second?.event).toBe('window.created')
    expect(second?.level).toBe('warn')
    expect(second?.width).toBe(1500)
  })

  it('同一目录续写，不覆盖已有日志', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-log-'))
    const logDir = join(scratch, 'logs')

    const first = new Logger(logDir, 'test.jsonl')
    first.info('app.start')
    await first.close()

    const second = new Logger(logDir, 'test.jsonl')
    second.info('app.quit')
    await second.close()

    const records = readRecords(join(logDir, 'test.jsonl'))
    expect(records.map((r) => r.event)).toEqual(['app.start', 'app.quit'])
  })
})
