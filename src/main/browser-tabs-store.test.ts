import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBrowserTabs, saveBrowserTabs } from './browser-tabs-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ins-pin-tabs-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('标签落盘', () => {
  it('存了能读回来', async () => {
    const file = join(dir, 'browser-tabs.json')
    await saveBrowserTabs(file, { tabs: [{ url: 'https://a.com', title: 'A' }], activeIndex: 0 })
    expect(await loadBrowserTabs(file)).toEqual({
      tabs: [{ url: 'https://a.com', title: 'A' }],
      activeIndex: 0
    })
  })

  it('第一次启动（文件不存在）读回 null', async () => {
    expect(await loadBrowserTabs(join(dir, '没有这个文件.json'))).toBeNull()
  })

  it('文件内容坏了也读回 null，不抛异常', async () => {
    const file = join(dir, 'browser-tabs.json')
    writeFileSync(file, '{ 这不是 JSON')
    expect(await loadBrowserTabs(file)).toBeNull()
  })

  it('写盘不留临时文件', async () => {
    const file = join(dir, 'browser-tabs.json')
    await saveBrowserTabs(file, { tabs: [], activeIndex: 0 })
    expect(readFileSync(file, 'utf8')).toBe('{"tabs":[],"activeIndex":0}')
    expect(() => readFileSync(`${file}.tmp`, 'utf8')).toThrow()
  })

  it('连续写入不会争用同一个临时文件，最后一次状态保留', async () => {
    const file = join(dir, 'browser-tabs.json')
    await Promise.all([
      saveBrowserTabs(file, { tabs: [{ url: 'https://a.com', title: 'A' }], activeIndex: 0 }),
      saveBrowserTabs(file, { tabs: [{ url: 'https://b.com', title: 'B' }], activeIndex: 0 })
    ])
    expect(await loadBrowserTabs(file)).toEqual({
      tabs: [{ url: 'https://b.com', title: 'B' }],
      activeIndex: 0
    })
  })
})
