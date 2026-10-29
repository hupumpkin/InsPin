import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { createProject } from './projects'
import { BACKUP_ASSETS_DIR, BACKUP_DB_NAME, BACKUP_META_NAME, backupStamp, exportBackup } from './backup'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ins-pin-backup-'))
  tempDirs.push(dir)
  return dir
}

describe('backupStamp', () => {
  it('把 ISO 时间压成年月日-时分', () => {
    expect(backupStamp('2026-10-15T10:30:00.000Z')).toBe('20261015-1030')
    expect(backupStamp('乱写的')).toBe('backup')
  })
})

describe('exportBackup', () => {
  it('产出一个自带 db + 素材 + 说明的文件夹，库内容自洽', async () => {
    const db = openDatabase(':memory:')
    createProject(db, '项目A', { id: 'p1' })

    const assetsDir = await makeTempDir()
    await writeFile(join(assetsDir, 'abc.png'), new Uint8Array(2048))
    const parent = await makeTempDir()

    const result = await exportBackup(
      { db, assetsDir, now: () => '2026-10-15T10:30:00.000Z', appVersion: '0.1.0' },
      parent
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dir.endsWith('InsPin备份-20261015-1030')).toBe(true)
    expect(result.assetFiles).toBe(1)
    expect(result.bytes).toBe(2048)

    // 库文件真的能打开、且内容在（VACUUM INTO 产出的是一份完整副本）
    const backupDb = new DatabaseSync(join(result.dir, BACKUP_DB_NAME))
    expect(backupDb.prepare('SELECT COUNT(*) c FROM projects').get()).toMatchObject({ c: 1 })
    backupDb.close()

    // 素材原样拷过来了
    expect((await stat(join(result.dir, BACKUP_ASSETS_DIR, 'abc.png'))).size).toBe(2048)

    const meta = JSON.parse(await readFile(join(result.dir, BACKUP_META_NAME), 'utf8'))
    expect(meta).toMatchObject({ version: 1, appVersion: '0.1.0', assetFiles: 1, assetBytes: 2048 })
  })

  it('同一个位置连备两次不会叠着长（旧的那份被换掉）', async () => {
    const db = openDatabase(':memory:')
    const assetsDir = await makeTempDir()
    const parent = await makeTempDir()
    const deps = { db, assetsDir, now: () => '2026-10-15T10:30:00.000Z', appVersion: '0.1.0' }

    const first = await exportBackup(deps, parent)
    const second = await exportBackup(deps, parent)
    expect(first.ok && second.ok).toBe(true)
    // 目录只有一个，不会出现 "备份-时间戳 (1)"
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(parent)).toEqual(['InsPin备份-20261015-1030'])
  })

  it('写不进去时给一句人话，不抛异常', async () => {
    const db = openDatabase(':memory:')
    const assetsDir = await makeTempDir()
    // 目标位置其实是个文件 → mkdir 一定失败
    const parent = join(await makeTempDir(), '其实是个文件')
    await writeFile(parent, 'x')

    const result = await exportBackup(
      { db, assetsDir, now: () => '2026-10-15T10:30:00.000Z', appVersion: '0.1.0' },
      parent
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message.length).toBeGreaterThan(0)
  })
})
