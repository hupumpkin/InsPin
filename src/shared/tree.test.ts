import { describe, expect, it } from 'vitest'
import {
  createAssetNode,
  createFrameNode,
  createGroupNode,
  type Node,
  type ProjectGraph
} from './node'
import {
  ancestorsOf,
  childToward,
  childrenOf,
  depthOf,
  descendantsOf,
  flattenTree,
  getNode,
  isAncestorOf,
  outermostAncestorId,
  parentOf,
  rootNodes,
  siblingIndex
} from './tree'

const asset = (id: string, parentId: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ ...createAssetNode({ id, projectId: 'p1', name: id, parentId, assetId: `a-${id}`, naturalWidth: 10, naturalHeight: 10 }), ...extra }) as Node

const frame = (id: string, parentId: string | null = null, childIds: string[] = []) =>
  ({ ...createFrameNode({ id, projectId: 'p1', name: id, parentId }), childIds }) as Node

const group = (id: string, childIds: string[]) =>
  ({ ...createGroupNode({ id, projectId: 'p1', name: id }), childIds }) as Node

/**
 *  f            group g
 *  ├─ a          └─ d
 *  └─ b
 *  c（顶层）
 */
function makeGraph(): ProjectGraph {
  const nodes: Node[] = [
    frame('f', null, ['a', 'b']),
    asset('a', 'f'),
    asset('b', 'f'),
    asset('c'),
    group('g', ['d']),
    asset('d', 'g')
  ]
  return {
    projectId: 'p1',
    rootIds: ['f', 'c', 'g'],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  }
}

describe('查询', () => {
  it('取某一层的节点，保持顺序', () => {
    const graph = makeGraph()
    expect(rootNodes(graph).map((n) => n.id)).toEqual(['f', 'c', 'g'])
    expect(childrenOf(graph, 'f').map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('不存在的父级返回空数组', () => {
    expect(childrenOf(makeGraph(), '不存在')).toEqual([])
  })

  it('取父节点与兄弟序号', () => {
    const graph = makeGraph()
    expect(parentOf(graph, 'b')?.id).toBe('f')
    expect(parentOf(graph, 'c')).toBeNull()
    expect(siblingIndex(graph, 'b')).toBe(1)
    expect(siblingIndex(graph, 'c')).toBe(1)
  })

  it('取祖先：从父到根', () => {
    expect(ancestorsOf(makeGraph(), 'a').map((n) => n.id)).toEqual(['f'])
    expect(ancestorsOf(makeGraph(), 'f')).toEqual([])
  })

  it('取子孙：深度优先', () => {
    expect(descendantsOf(makeGraph(), 'f')).toEqual(['a', 'b'])
    expect(descendantsOf(makeGraph(), 'g')).toEqual(['d'])
    expect(descendantsOf(makeGraph(), 'a')).toEqual([])
  })

  it('判断祖先关系与层级', () => {
    const graph = makeGraph()
    expect(isAncestorOf(graph, 'f', 'a')).toBe(true)
    expect(isAncestorOf(graph, 'a', 'f')).toBe(false)
    expect(isAncestorOf(graph, 'f', 'g')).toBe(false)
    expect(depthOf(graph, 'f')).toBe(0)
    expect(depthOf(graph, 'a')).toBe(1)
  })

  it('数据成环时不会卡死', () => {
    const broken: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['x'],
      nodes: {
        x: frame('x', 'y', ['y']),
        y: frame('y', 'x', ['x'])
      }
    }
    expect(() => ancestorsOf(broken, 'x')).not.toThrow()
    expect(() => descendantsOf(broken, 'x')).not.toThrow()
  })

  it('getNode 取不存在的返回 null', () => {
    expect(getNode(makeGraph(), '没有')).toBeNull()
  })

  it('点中组内对象时，实际选中它最外层的祖先', () => {
    const graph = makeGraph()
    expect(outermostAncestorId(graph, 'a')).toBe('f')
    expect(outermostAncestorId(graph, 'd')).toBe('g')
    // 顶层节点返回自己
    expect(outermostAncestorId(graph, 'f')).toBe('f')
    expect(outermostAncestorId(graph, 'c')).toBe('c')
    expect(outermostAncestorId(graph, '没有')).toBeNull()
  })
})

describe('childToward（双击下潜一层）', () => {
  it('容器里的对象：返回它在容器下的那个直接子节点', () => {
    const graph = makeGraph()
    expect(childToward(graph, 'f', 'a')).toBe('a')
    expect(childToward(graph, 'f', 'b')).toBe('b')
    expect(childToward(graph, 'g', 'd')).toBe('d')
  })

  it('隔了好几层时，只下潜一层', () => {
    // f2 > g2 > a2：从 f2 往下应该落在 g2（不是最深的 a2）
    const inner = group('g2', ['a2'])
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['f2'],
      nodes: {
        f2: frame('f2', null, ['g2']),
        g2: { ...inner, parentId: 'f2' },
        a2: asset('a2', 'g2')
      }
    }
    expect(childToward(graph, 'f2', 'a2')).toBe('g2')
    expect(childToward(graph, 'g2', 'a2')).toBe('a2')
  })

  it('自己往下不是子节点；不在同一棵树里也不是', () => {
    const graph = makeGraph()
    expect(childToward(graph, 'f', 'f')).toBeNull()
    expect(childToward(graph, 'f', 'c')).toBeNull() // c 是顶层，不在 f 里
    expect(childToward(graph, 'a', 'a')).toBeNull()
  })

  it('节点或祖先不存在时返回 null', () => {
    const graph = makeGraph()
    expect(childToward(graph, 'f', '没有')).toBeNull()
    expect(childToward(graph, '没有', 'a')).toBeNull()
  })

  it('数据成环时不会卡死', () => {
    const broken: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['x'],
      nodes: {
        x: frame('x', 'y', ['y']),
        y: frame('y', 'x', ['x'])
      }
    }
    expect(() => childToward(broken, 'x', 'y')).not.toThrow()
  })
})

describe('flattenTree', () => {
  it('摊平成从上到下的一维列表，带缩进层级', () => {
    const rows = flattenTree(makeGraph())
    expect(rows.map((row) => `${row.depth}:${row.id}`)).toEqual([
      '0:f',
      '1:a',
      '1:b',
      '0:c',
      '0:g',
      '1:d'
    ])
  })

  it('跳过指向不存在节点的引用', () => {
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['f', '缺失'],
      nodes: { f: frame('f', null, ['缺失的子']) }
    }
    expect(flattenTree(graph).map((row) => row.id)).toEqual(['f'])
  })
})
