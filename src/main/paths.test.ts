import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDataDirs, resolveDataPaths } from './paths'

describe('resolveDataPaths', () => {
  it('把各类数据放在根目录下且互不重叠', () => {
    const paths = resolveDataPaths('/tmp/ins-pin')
    expect(paths.root).toBe('/tmp/ins-pin')
    expect(paths.assets).toBe('/tmp/ins-pin/inspin-assets')
    expect(paths.thumbnails).toBe('/tmp/ins-pin/thumbnails')
    expect(paths.database).toBe('/tmp/ins-pin/database')
    expect(paths.databaseFile).toBe('/tmp/ins-pin/database/ins-pin.db')
    expect(paths.sessions).toBe('/tmp/ins-pin/sessions')
    expect(paths.logs).toBe('/tmp/ins-pin/logs')

    const dirs = [paths.assets, paths.thumbnails, paths.database, paths.sessions, paths.logs]
    expect(new Set(dirs).size).toBe(dirs.length)
    for (const dir of dirs) expect(dir.startsWith(`${paths.root}/`)).toBe(true)
  })

  it('数据库文件落在数据库目录内', () => {
    const paths = resolveDataPaths('/tmp/ins-pin')
    expect(paths.databaseFile.startsWith(`${paths.database}/`)).toBe(true)
  })
})

describe('ensureDataDirs', () => {
  let scratch: string | undefined

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('创建全部目录（含不存在的父级）', () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-paths-'))
    const paths = resolveDataPaths(join(scratch, 'nested', 'data'))
    ensureDataDirs(paths)

    for (const dir of [
      paths.root,
      paths.assets,
      paths.thumbnails,
      paths.database,
      paths.sessions,
      paths.logs
    ]) {
      expect(existsSync(dir)).toBe(true)
    }
  })

  it('目录已存在时重复调用不报错，也不清空内容', () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-paths-'))
    const paths = resolveDataPaths(join(scratch, 'data'))
    ensureDataDirs(paths)

    const kept = join(paths.assets, 'keep.txt')
    writeFileSync(kept, 'x')

    expect(() => ensureDataDirs(paths)).not.toThrow()
    expect(existsSync(kept)).toBe(true)
  })

  it('把旧 assets 目录迁移到 inspin-assets（同盘直接改名，不复制大文件）', () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-paths-'))
    const root = join(scratch, 'data')
    const legacy = join(root, 'assets')
    const paths = resolveDataPaths(root)
    ensureDataDirs({ ...paths, assets: legacy })
    writeFileSync(join(legacy, 'legacy.png'), 'old')

    ensureDataDirs(paths)

    expect(existsSync(join(paths.assets, 'legacy.png'))).toBe(true)
    // 改名后旧目录不再保留副本，避免磁盘占用翻倍
    expect(existsSync(legacy)).toBe(false)

    rmSync(join(paths.assets, 'legacy.png'))
    ensureDataDirs(paths)
    expect(existsSync(join(paths.assets, 'legacy.png'))).toBe(false)
  })

  it('上次迁移中断（目标目录已存在）时补拷缺失文件', () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-paths-'))
    const root = join(scratch, 'data')
    const legacy = join(root, 'assets')
    const paths = resolveDataPaths(root)
    ensureDataDirs({ ...paths, assets: legacy })
    writeFileSync(join(legacy, 'legacy.png'), 'old')
    mkdirSync(paths.assets, { recursive: true })
    writeFileSync(join(paths.assets, 'already.png'), 'kept')

    ensureDataDirs(paths)

    expect(existsSync(join(paths.assets, 'legacy.png'))).toBe(true)
    expect(existsSync(join(paths.assets, 'already.png'))).toBe(true)
  })
})
