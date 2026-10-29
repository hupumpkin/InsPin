import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAssetNode, createFrameNode, type Node, type ProjectGraph } from '../shared/node'
import { migrate } from './db'
import { deleteNode, loadGraph, saveGraph, upsertNode } from './nodes'

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.prepare(
    'INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run('p1', '项目一', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z')
})

const asset = (id: string, over: Partial<Parameters<typeof createAssetNode>[0]> = {}): Node =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    assetId: `a-${id}`,
    naturalWidth: 800,
    naturalHeight: 600,
    ...over
  })

describe('saveGraph + loadGraph', () => {
  it('存进去再读回来，内容一致', () => {
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['n1'],
      nodes: { n1: asset('n1', { x: 12, y: 34, w: 100, h: 80 }) }
    }

    saveGraph(db, graph)
    const loaded = loadGraph(db, 'p1')

    expect(loaded.rootIds).toEqual(['n1'])
    expect(loaded.nodes['n1']).toMatchObject({
      id: 'n1',
      projectId: 'p1',
      parentId: null,
      type: 'asset',
      name: 'n1',
      x: 12,
      y: 34,
      w: 100,
      h: 80,
      visible: true,
      locked: false
    })
    expect(loaded.nodes['n1']?.props).toMatchObject({ assetId: 'a-n1', naturalWidth: 800 })
  })

  it('层级与顺序完整还原', () => {
    const frame = createFrameNode({ id: 'f', projectId: 'p1', name: '容器' })
    frame.childIds = ['c2', 'c1'] // 故意和 id 顺序不一致，验的是 ordinal 而不是排序

    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['f', 'top'],
      nodes: {
        f: frame,
        c1: asset('c1', { parentId: 'f' }),
        c2: asset('c2', { parentId: 'f' }),
        top: asset('top')
      }
    }

    saveGraph(db, graph)
    const loaded = loadGraph(db, 'p1')

    expect(loaded.rootIds).toEqual(['f', 'top'])
    expect(loaded.nodes['f']?.childIds).toEqual(['c2', 'c1'])
    expect(loaded.nodes['c2']?.parentId).toBe('f')
  })

  it('自动布局参数通过 props 原样往返', () => {
    const frame = createFrameNode({
      id: 'f',
      projectId: 'p1',
      name: '容器',
      props: { layoutMode: 'horizontal', itemSpacing: 16, padding: { left: 12 }, gridColumns: 3 }
    })

    saveGraph(db, { projectId: 'p1', rootIds: ['f'], nodes: { f: frame } })
    const loaded = loadGraph(db, 'p1')

    expect(loaded.nodes['f']?.props).toMatchObject({
      layoutMode: 'horizontal',
      itemSpacing: 16,
      padding: { top: 0, right: 0, bottom: 0, left: 12 },
      gridColumns: 3
    })
  })

  it('重复 save 不会留下重复节点', () => {
    const graph: ProjectGraph = { projectId: 'p1', rootIds: ['n1'], nodes: { n1: asset('n1') } }
    saveGraph(db, graph)
    saveGraph(db, graph)
    saveGraph(db, graph)

    const count = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('save 会清掉上一次存在、这次不在的节点', () => {
    saveGraph(db, { projectId: 'p1', rootIds: ['a', 'b'], nodes: { a: asset('a'), b: asset('b') } })
    saveGraph(db, { projectId: 'p1', rootIds: ['a'], nodes: { a: asset('a') } })

    expect(loadGraph(db, 'p1').rootIds).toEqual(['a'])
  })

  it('不会串到别的项目', () => {
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'p2',
      '项目二',
      '2026-10-14T00:00:00.000Z',
      '2026-10-14T00:00:00.000Z'
    )
    const other = asset('x')
    saveGraph(db, { projectId: 'p1', rootIds: ['x'], nodes: { x: other } })
    saveGraph(db, {
      projectId: 'p2',
      rootIds: ['y'],
      nodes: { y: { ...asset('y'), projectId: 'p2' } }
    })

    expect(loadGraph(db, 'p1').rootIds).toEqual(['x'])
    expect(loadGraph(db, 'p2').rootIds).toEqual(['y'])
  })

  it('空项目读出空画布', () => {
    expect(loadGraph(db, 'p1')).toEqual({ projectId: 'p1', rootIds: [], nodes: {} })
  })
})

describe('upsertNode', () => {
  it('先新增、再更新', () => {
    upsertNode(db, asset('n1', { x: 1 }))
    expect(loadGraph(db, 'p1').nodes['n1']?.x).toBe(1)

    upsertNode(db, asset('n1', { x: 99 }))
    const loaded = loadGraph(db, 'p1')

    expect(Object.keys(loaded.nodes)).toEqual(['n1'])
    expect(loaded.nodes['n1']?.x).toBe(99)
  })

  it('新节点排在同层末尾，更新不改变位置', () => {
    upsertNode(db, asset('a'))
    upsertNode(db, asset('b'))

    // 改动 a，顺序不应变化
    upsertNode(db, asset('a', { x: 5 }))
    expect(loadGraph(db, 'p1').rootIds).toEqual(['a', 'b'])
  })

  it('子节点挂到父节点下', () => {
    const frame = createFrameNode({ id: 'f', projectId: 'p1', name: '容器' })
    upsertNode(db, frame)
    upsertNode(db, asset('c', { parentId: 'f' }))

    const loaded = loadGraph(db, 'p1')
    expect(loaded.rootIds).toEqual(['f'])
    expect(loaded.nodes['f']?.childIds).toEqual(['c'])
  })
})

describe('deleteNode', () => {
  it('删掉节点并返回是否删到', () => {
    upsertNode(db, asset('n1'))
    expect(deleteNode(db, 'n1')).toBe(true)
    expect(deleteNode(db, 'n1')).toBe(false)
    expect(loadGraph(db, 'p1').rootIds).toEqual([])
  })

  it('连同子孙一起删掉', () => {
    const frame = createFrameNode({ id: 'f', projectId: 'p1', name: '容器' })
    upsertNode(db, frame)
    upsertNode(db, asset('c', { parentId: 'f' }))

    deleteNode(db, 'f')

    const count = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }
    expect(count.n).toBe(0)
  })
})
