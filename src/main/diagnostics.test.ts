import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDiagnosticBundle,
  collectLogFiles,
  stampForFileName,
  type DiagnosticAppInfo
} from './diagnostics'

const APP: DiagnosticAppInfo = {
  appVersion: '0.1.0',
  electron: '44.7.0',
  chrome: '152.0.0.0',
  node: '24.21.0',
  platform: 'darwin',
  arch: 'arm64'
}

describe('stampForFileName', () => {
  it('按本地时间生成紧凑时间戳', () => {
    expect(stampForFileName(new Date(2026, 9, 14, 9, 5))).toBe('2026-10-14-0905')
  })
})

describe('buildDiagnosticBundle', () => {
  it('汇总文件数、行数与错误行数', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2026-10-14T00:00:00.000Z',
      app: APP,
      dataRoot: '/data',
      logFiles: [
        {
          name: 'a.jsonl',
          lines: [
            '{"level":"info","event":"app.start"}',
            '{"level":"error","event":"error.main.uncaught"}'
          ]
        },
        { name: 'b.jsonl', lines: ['{"level":"info","event":"app.quit"}'] }
      ]
    })
    expect(bundle.summary).toEqual({ logFiles: 2, logLines: 3, errorLines: 1 })
  })

  it('日志里的完整网址被脱敏，且不含图片/Cookie 字段', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2026-10-14T00:00:00.000Z',
      app: APP,
      dataRoot: '/data',
      logFiles: [
        {
          name: 'a.jsonl',
          lines: ['{"level":"info","event":"fetch","url":"https://cdn.petals.com/a/b.jpg?x=1"}']
        }
      ]
    })
    const text = JSON.stringify(bundle)
    expect(text).not.toContain('petals.com/a/b.jpg')
    expect(text).not.toContain('?x=1')
    expect(text).toContain('cdn.petals.com/')

    // 日志正文里不出现 Cookie / 会话类字段（note 里的说明文字不算）
    const logs = JSON.stringify(bundle.logFiles)
    expect(logs).not.toContain('Cookie')
    expect(logs).not.toContain('session')
  })

  it('数据目录与日志里的用户主目录被隐藏', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2026-10-14T00:00:00.000Z',
      app: APP,
      dataRoot: '/Users/alice/Library/Application Support/InsPin-Internal',
      homeDir: '/Users/alice',
      logFiles: [
        {
          name: 'a.jsonl',
          lines: ['{"level":"info","event":"db.opened","path":"/Users/alice/Library/x.db"}']
        }
      ]
    })
    const text = JSON.stringify(bundle)
    expect(text).not.toContain('/Users/alice')
    expect(bundle.dataRoot).toBe('~/Library/Application Support/InsPin-Internal')
  })

  it('坏行不影响导出', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2026-10-14T00:00:00.000Z',
      app: APP,
      dataRoot: '/data',
      logFiles: [{ name: 'a.jsonl', lines: ['这不是 JSON'] }]
    })
    expect(bundle.summary.errorLines).toBe(0)
    expect(bundle.logFiles[0]?.lines).toEqual(['这不是 JSON'])
  })
})

describe('collectLogFiles', () => {
  let scratch: string | undefined

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('只读 .jsonl 文件，按名字排序，空行丢弃', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-diag-'))
    writeFileSync(join(scratch, 'b.jsonl'), '{"n":2}\n\n')
    writeFileSync(join(scratch, 'a.jsonl'), '{"n":1}\n')
    writeFileSync(join(scratch, 'ignore.txt'), '不该被读到')

    const files = await collectLogFiles(scratch)
    expect(files.map((f) => f.name)).toEqual(['a.jsonl', 'b.jsonl'])
    expect(files[1]?.lines).toEqual(['{"n":2}'])
  })

  it('目录不存在时返回空数组', async () => {
    expect(await collectLogFiles('/definitely/not/here')).toEqual([])
  })
})
