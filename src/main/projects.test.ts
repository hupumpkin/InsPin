import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db'
import {
  PROJECT_NAME_MAX,
  createProject,
  deleteProject,
  DEFAULT_PROJECT_NAME,
  ensureDefaultProject,
  getProject,
  listProjects,
  normalizeProjectName,
  renameProject,
  updateViewport
} from './projects'

const T1 = new Date('2026-10-14T10:00:00.000Z')
const T2 = new Date('2026-10-14T11:00:00.000Z')
const T3 = new Date('2026-10-14T12:00:00.000Z')

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
})

describe('normalizeProjectName', () => {
  it('去掉首尾空白', () => {
    expect(normalizeProjectName('  灵感收集  ')).toBe('灵感收集')
  })

  it('空名与纯空白被拒绝', () => {
    expect(() => normalizeProjectName('')).toThrow('项目名不能为空')
    expect(() => normalizeProjectName('   ')).toThrow('项目名不能为空')
  })

  it('超长名字被拒绝', () => {
    expect(() => normalizeProjectName('x'.repeat(PROJECT_NAME_MAX + 1))).toThrow('不能超过')
    expect(normalizeProjectName('x'.repeat(PROJECT_NAME_MAX))).toHaveLength(PROJECT_NAME_MAX)
  })
})

describe('createProject', () => {
  it('落库并返回完整项目，视图是默认值', () => {
    const project = createProject(db, '项目一', { id: 'p1', now: T1 })

    expect(project).toEqual({
      id: 'p1',
      name: '项目一',
      createdAt: T1.toISOString(),
      updatedAt: T1.toISOString(),
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1
    })
    expect(getProject(db, 'p1')).toEqual(project)
  })

  it('名字先清洗再入库', () => {
    const project = createProject(db, '  带空白的名字 ', { id: 'p1', now: T1 })
    expect(project.name).toBe('带空白的名字')
  })

  it('名字不合法时不会留下半条记录', () => {
    expect(() => createProject(db, '   ', { id: 'p1', now: T1 })).toThrow()
    expect(listProjects(db)).toEqual([])
  })

  it('id 自动生成且不重复', () => {
    const a = createProject(db, 'A', { now: T1 })
    const b = createProject(db, 'B', { now: T1 })
    expect(a.id).not.toBe(b.id)
    expect(a.id.length).toBeGreaterThan(0)
  })
})

describe('ensureDefaultProject', () => {
  it('空数据库会补上一张名为“默认项目”的空画布', () => {
    const created = ensureDefaultProject(db, { id: 'default', now: T1 })
    expect(created).toMatchObject({ id: 'default', name: DEFAULT_PROJECT_NAME })
    expect(listProjects(db).map((project) => project.name)).toEqual([DEFAULT_PROJECT_NAME])
  })

  it('已有项目时不会多造一个默认项目', () => {
    createProject(db, '已有项目', { id: 'p1', now: T1 })
    expect(ensureDefaultProject(db)).toBeNull()
    expect(listProjects(db)).toHaveLength(1)
  })
})

describe('listProjects', () => {
  it('最近改动的排在前面', () => {
    createProject(db, '老项目', { id: 'p1', now: T1 })
    createProject(db, '新项目', { id: 'p2', now: T2 })
    expect(listProjects(db).map((p) => p.id)).toEqual(['p2', 'p1'])
  })

  it('空库返回空数组', () => {
    expect(listProjects(db)).toEqual([])
  })
})

describe('renameProject', () => {
  it('改名并刷新 updatedAt', () => {
    createProject(db, '旧名', { id: 'p1', now: T1 })
    const renamed = renameProject(db, 'p1', '新名', { now: T3 })

    expect(renamed.name).toBe('新名')
    expect(renamed.updatedAt).toBe(T3.toISOString())
    expect(renamed.createdAt).toBe(T1.toISOString())
  })

  it('改名会让它排到列表最前', () => {
    createProject(db, 'A', { id: 'p1', now: T1 })
    createProject(db, 'B', { id: 'p2', now: T2 })
    renameProject(db, 'p1', 'A 改', { now: T3 })
    expect(listProjects(db).map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('改不存在的项目会报错', () => {
    expect(() => renameProject(db, '不存在', 'x', { now: T1 })).toThrow('项目不存在')
  })

  it('名字不合法时原名不变', () => {
    createProject(db, '原名', { id: 'p1', now: T1 })
    expect(() => renameProject(db, 'p1', '  ', { now: T2 })).toThrow()
    expect(getProject(db, 'p1')?.name).toBe('原名')
  })
})

describe('deleteProject', () => {
  it('删掉项目', () => {
    createProject(db, '要删的', { id: 'p1', now: T1 })
    expect(deleteProject(db, 'p1')).toBe(true)
    expect(getProject(db, 'p1')).toBeNull()
  })

  it('删不存在的返回 false', () => {
    expect(deleteProject(db, '不存在')).toBe(false)
  })

  it('连带删掉项目里的节点', () => {
    createProject(db, '带内容', { id: 'p1', now: T1 })
    db.prepare(
      `INSERT INTO nodes (id, project_id, ordinal, type, name) VALUES ('n1', 'p1', 0, 'asset', '一张图')`
    ).run()

    deleteProject(db, 'p1')

    const left = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }
    expect(left.n).toBe(0)
  })
})

describe('updateViewport', () => {
  it('记录视图位置并刷新 updatedAt', () => {
    createProject(db, '项目', { id: 'p1', now: T1 })
    updateViewport(db, 'p1', { x: -120.5, y: 340, zoom: 1.75 }, { now: T2 })

    const project = getProject(db, 'p1')
    expect(project).toMatchObject({ viewportX: -120.5, viewportY: 340, viewportZoom: 1.75 })
    expect(project?.updatedAt).toBe(T2.toISOString())
  })

  it('改不存在的项目会报错', () => {
    expect(() => updateViewport(db, '不存在', { x: 0, y: 0, zoom: 1 })).toThrow('项目不存在')
  })
})
