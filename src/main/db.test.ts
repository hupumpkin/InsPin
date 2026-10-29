import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION, migrate, openDatabase, schemaVersion } from './db'
import { MIGRATIONS } from './schema'

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.map((row) => row.name)
}

describe('迁移表自身', () => {
  it('版本号从 1 开始且严格递增', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    const versions = MIGRATIONS.map((m) => m.version)
    expect(versions[0]).toBe(1)
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]!).toBeGreaterThan(versions[i - 1]!)
    }
    expect(LATEST_SCHEMA_VERSION).toBe(versions[versions.length - 1])
  })
})

describe('migrate', () => {
  it('在空库上建出全部表并把版本推到最新', () => {
    const db = new DatabaseSync(':memory:')
    expect(schemaVersion(db)).toBe(0)

    const version = migrate(db)

    expect(version).toBe(LATEST_SCHEMA_VERSION)
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['projects', 'nodes', 'assets'])
    )
    db.close()
  })

  it('重复执行是幂等的', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    db.close()
  })
})

describe('v1 表结构', () => {
  it('projects 表字段齐全', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(columnNames(db, 'projects')).toEqual([
      'id',
      'name',
      'created_at',
      'updated_at',
      'viewport_x',
      'viewport_y',
      'viewport_zoom'
    ])
    db.close()
  })

  it('nodes 表含层级、顺序与自动布局所需的字段', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(columnNames(db, 'nodes')).toEqual([
      'id',
      'project_id',
      'parent_id',
      'ordinal',
      'type',
      'name',
      'visible',
      'locked',
      'x',
      'y',
      'w',
      'h',
      'rotation',
      'props'
    ])
    db.close()
  })

  it('assets 表字段齐全', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(columnNames(db, 'assets')).toEqual([
      'id',
      'sha256',
      'mime',
      'bytes',
      'width',
      'height',
      'file_name',
      'import_method',
      'source_url',
      'resource_url',
      'page_url',
      'created_at',
      'original_name',
      'retention_policy',
      'unreferenced_since',
      'trashed_at'
    ])
    db.close()
  })

  it('linked_folders 只保存链接元数据，不接管 Finder 文件', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(columnNames(db, 'linked_folders')).toEqual(['id', 'name', 'path', 'created_at'])
    db.close()
  })
})

describe('约束是否真的生效', () => {
  function seeded(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      '项目一',
      '2026-10-14T00:00:00.000Z',
      '2026-10-14T00:00:00.000Z'
    )
    return db
  }

  const insertNode = (db: DatabaseSync, id: string, projectId: string, ordinal: number): void => {
    db.prepare(
      `INSERT INTO nodes (id, project_id, ordinal, type, name)
       VALUES (?, ?, ?, 'asset', ?)`
    ).run(id, projectId, ordinal, id)
  }

  it('素材内容哈希唯一（去重靠它）', () => {
    const db = seeded()
    const sql = `INSERT INTO assets (id, sha256, mime, bytes, file_name, import_method, created_at)
                 VALUES (?, ?, 'image/png', 10, ?, 'drag', '2026-10-14T00:00:00.000Z')`
    db.prepare(sql).run('a1', 'hash-1', 'a1.png')
    expect(() => db.prepare(sql).run('a2', 'hash-1', 'a2.png')).toThrow()
    db.close()
  })

  it('节点必须属于一个存在的项目', () => {
    const db = seeded()
    expect(() => insertNode(db, 'n1', '不存在', 0)).toThrow()
    db.close()
  })

  it('删掉项目会级联删掉它的节点', () => {
    const db = seeded()
    insertNode(db, 'n1', 'p1', 0)
    db.prepare('DELETE FROM projects WHERE id = ?').run('p1')
    const left = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }
    expect(left.n).toBe(0)
    db.close()
  })

  it('同一父节点内按 ordinal 取顺序，顶层节点是 parent_id IS NULL', () => {
    const db = seeded()
    insertNode(db, 'b', 'p1', 2)
    insertNode(db, 'a', 'p1', 0)
    insertNode(db, 'c', 'p1', 1)

    const ids = (
      db
        .prepare('SELECT id FROM nodes WHERE parent_id IS NULL ORDER BY ordinal')
        .all() as { id: string }[]
    ).map((row) => row.id)
    expect(ids).toEqual(['a', 'c', 'b'])
    db.close()
  })
})

describe('openDatabase', () => {
  let scratch: string | undefined

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('自动创建数据库文件，并开启 WAL 与外键', () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-db-'))
    // 真实调用顺序：先 ensureDataDirs 建好目录，再 openDatabase
    const dir = join(scratch, 'database')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'ins-pin.db')

    const db = openDatabase(file)

    expect(existsSync(file)).toBe(true)
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(journal.journal_mode.toLowerCase()).toBe('wal')

    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)

    db.close()
  })

  it('再次打开同一个文件不会重建、数据还在', () => {
    scratch = mkdtempSync(join(tmpdir(), 'ins-pin-db-'))
    const file = join(scratch, 'ins-pin.db')

    const first = openDatabase(file)
    first
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('p1', '项目一', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z')
    first.close()

    const second = openDatabase(file)
    const row = second.prepare('SELECT name FROM projects WHERE id = ?').get('p1') as {
      name: string
    }
    expect(row.name).toBe('项目一')
    second.close()
  })
})
