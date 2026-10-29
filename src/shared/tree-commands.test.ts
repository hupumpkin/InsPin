import { describe, expect, it } from 'vitest'
import {
  createAssetNode,
  createFrameNode,
  type Node,
  type ProjectGraph
} from './node'
import {
  createGroupCommand,
  createMoveNodeCommand,
  createMoveNodesToParentCommand,
  createRemoveNodesCommand,
  createRenameNodeCommand,
  createReorderCommand,
  createReorderNodesCommand,
  createSetNodeFlagsCommand,
  createUngroupCommand
} from './tree-commands'
import { childrenOf, descendantsOf, flattenTree } from './tree'
import { layout } from './layout'

const asset = (id: string, parentId: string | null = null, extra: Partial<Node> = {}): Node =>
  ({
    ...createAssetNode({
      id,
      projectId: 'p1',
      name: id,
      parentId,
      w: 10,
      h: 10,
      assetId: `a-${id}`,
      naturalWidth: 10,
      naturalHeight: 10
    }),
    ...extra
  }) as Node

const frame = (id: string, childIds: string[]): Node =>
  ({ ...createFrameNode({ id, projectId: 'p1', name: id }), childIds }) as Node

function makeGraph(): ProjectGraph {
  const nodes = [frame('f', ['a', 'b']), asset('a', 'f'), asset('b', 'f'), asset('c')]
  return {
    projectId: 'p1',
    rootIds: ['f', 'c'],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  }
}

const orderOf = (graph: ProjectGraph, parentId: string | null): string[] =>
  childrenOf(graph, parentId).map((node) => node.id)

describe('createMoveNodesToParentCommand', () => {
  it('多选一起换父级，保持顺序，一次撤销回到原样', () => {
    const command = createMoveNodesToParentCommand(['a', 'c'], 'f', 0)
    const moved = command.apply(makeGraph())

    expect(moved.rootIds).toEqual(['f'])
    expect(moved.nodes['f']?.childIds).toEqual(['a', 'c', 'b'])
    expect(moved.nodes['a']?.parentId).toBe('f')
    expect(moved.nodes['c']?.parentId).toBe('f')

    const reverted = command.revert(moved)
    expect(reverted.rootIds).toEqual(['f', 'c'])
    expect(reverted.nodes['f']?.childIds).toEqual(['a', 'b'])
    expect(reverted.nodes['c']?.parentId).toBeNull()
  })
})

describe('createRenameNodeCommand', () => {
  it('改名可以撤销', () => {
    const command = createRenameNodeCommand('a', '新名字')
    const renamed = command.apply(makeGraph())
    expect(renamed.nodes['a']?.name).toBe('新名字')
    expect(command.revert(renamed).nodes['a']?.name).toBe('a')
  })

  it('节点不存在时不动图', () => {
    const graph = makeGraph()
    expect(createRenameNodeCommand('没有', 'x').apply(graph)).toBe(graph)
  })
})

describe('createSetNodeFlagsCommand', () => {
  it('显隐与锁定可以撤销', () => {
    const command = createSetNodeFlagsCommand('a', { visible: false, locked: true })
    const applied = command.apply(makeGraph())
    expect(applied.nodes['a']).toMatchObject({ visible: false, locked: true })
    expect(command.revert(applied).nodes['a']).toMatchObject({ visible: true, locked: false })
  })
})

describe('createReorderCommand', () => {
  it('同层内挪动顺序，可撤销', () => {
    const command = createReorderCommand('f', 0, 1)
    const moved = command.apply(makeGraph())
    expect(orderOf(moved, 'f')).toEqual(['b', 'a'])
    expect(orderOf(command.revert(moved), 'f')).toEqual(['a', 'b'])
  })

  it('顶层也能排序', () => {
    const moved = createReorderCommand(null, 0, 1).apply(makeGraph())
    expect(moved.rootIds).toEqual(['c', 'f'])
  })

  it('越界的下标不会破坏结构', () => {
    const moved = createReorderCommand('f', 5, 9).apply(makeGraph())
    expect(orderOf(moved, 'f')).toEqual(['a', 'b'])
  })
})

describe('createMoveNodeCommand', () => {
  it('换父节点', () => {
    const moved = createMoveNodeCommand('a', null, 0).apply(makeGraph())
    expect(moved.nodes['a']?.parentId).toBeNull()
    expect(orderOf(moved, 'f')).toEqual(['b'])
    expect(moved.rootIds).toEqual(['a', 'f', 'c'])
  })

  it('撤销回到原来的父与位置', () => {
    const command = createMoveNodeCommand('a', null, 0)
    const moved = command.apply(makeGraph())
    const back = command.revert(moved)
    expect(back.nodes['a']?.parentId).toBe('f')
    expect(orderOf(back, 'f')).toEqual(['a', 'b'])
  })

  it('同层内移动不会插错位置', () => {
    const moved = createMoveNodeCommand('a', 'f', 1).apply(makeGraph())
    expect(orderOf(moved, 'f')).toEqual(['b', 'a'])
  })

  it('不允许把节点拖进自己的子孙', () => {
    const graph = makeGraph()
    expect(createMoveNodeCommand('f', 'a', 0).apply(graph)).toBe(graph)
    expect(createMoveNodeCommand('f', 'f', 0).apply(graph)).toBe(graph)
  })
})

describe('createRemoveNodesCommand', () => {
  it('删掉节点连同子孙，并从父级顺序里摘掉', () => {
    const removed = createRemoveNodesCommand(['f']).apply(makeGraph())
    expect(removed.nodes['f']).toBeUndefined()
    expect(removed.nodes['a']).toBeUndefined()
    expect(removed.nodes['b']).toBeUndefined()
    expect(removed.rootIds).toEqual(['c'])
  })

  it('可以撤销', () => {
    const command = createRemoveNodesCommand(['f'])
    const graph = makeGraph()
    const removed = command.apply(graph)
    const restored = command.revert(removed)

    expect(Object.keys(restored.nodes).sort()).toEqual(['a', 'b', 'c', 'f'])
    expect(restored.rootIds).toEqual(['f', 'c'])
    expect(descendantsOf(restored, 'f')).toEqual(['a', 'b'])
  })

  it('删不存在的节点是空操作', () => {
    const graph = makeGraph()
    expect(createRemoveNodesCommand(['没有']).apply(graph)).toBe(graph)
  })
})

describe('createGroupCommand', () => {
  it('把选中的节点打进一个组，位置与顺序不变', () => {
    const graph = createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(makeGraph())

    expect(orderOf(graph, 'f')).toEqual(['g'])
    expect(orderOf(graph, 'g')).toEqual(['a', 'b'])
    expect(graph.nodes['a']?.parentId).toBe('g')
    // 组占据原来两个节点的位置：a 在 (0,0) 10×10，b 也是 → 组 10×10
    expect(graph.nodes['g']).toMatchObject({ x: 0, y: 0, w: 10, h: 10 })
  })

  it('组的位置是选中节点的包围盒', () => {
    const base = makeGraph()
    base.nodes['a'] = asset('a', 'f', { x: 100, y: 50 })
    base.nodes['b'] = asset('b', 'f', { x: 300, y: 200, w: 40, h: 20 })

    const graph = createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(base)

    expect(graph.nodes['g']).toMatchObject({ x: 100, y: 50, w: 240, h: 170 })
    // 子节点坐标换算成相对组
    expect(graph.nodes['a']).toMatchObject({ x: 0, y: 0 })
    expect(graph.nodes['b']).toMatchObject({ x: 200, y: 150 })
  })

  it('可以撤销', () => {
    const command = createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] })
    const graph = makeGraph()
    const grouped = command.apply(graph)
    const back = command.revert(grouped)

    expect(back.nodes['g']).toBeUndefined()
    expect(back.nodes['a']?.parentId).toBe('f')
    expect(orderOf(back, 'f')).toEqual(['a', 'b'])
  })

  it('选空或组 id 已存在时不动图', () => {
    const graph = makeGraph()
    expect(createGroupCommand({ groupId: 'g', nodeIds: [] }).apply(graph)).toBe(graph)
    expect(createGroupCommand({ groupId: 'f', nodeIds: ['a'] }).apply(graph)).toBe(graph)
  })
})

describe('createUngroupCommand', () => {
  it('解组：子节点上移一层，占据组原来的位置', () => {
    const grouped = createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(makeGraph())
    const ungrouped = createUngroupCommand('g').apply(grouped)

    expect(ungrouped.nodes['g']).toBeUndefined()
    expect(ungrouped.nodes['a']?.parentId).toBe('f')
    expect(orderOf(ungrouped, 'f')).toEqual(['a', 'b'])
  })

  it('可以撤销', () => {
    const command = createUngroupCommand('g')
    const grouped = createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(makeGraph())
    const ungrouped = command.apply(grouped)
    const back = command.revert(ungrouped)

    expect(back.nodes['g']).toBeDefined()
    expect(orderOf(back, 'g')).toEqual(['a', 'b'])
  })

  it('解一个不存在的组是空操作', () => {
    const graph = makeGraph()
    expect(createUngroupCommand('没有').apply(graph)).toBe(graph)
  })

  it('组不在画布原点时，解组后子节点的绝对位置也不动', () => {
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['a', 'b'],
      nodes: {
        a: asset('a', null, { x: 100, y: 50 }),
        b: asset('b', null, { x: 160, y: 90 })
      }
    }
    const grouped = createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(graph)
    // 组按内容的并集摆位，左上角落在 (100, 50)
    expect(grouped.nodes['g']).toMatchObject({ x: 100, y: 50 })

    const ungrouped = createUngroupCommand('g').apply(grouped)
    expect(ungrouped.nodes['a']).toMatchObject({ x: 100, y: 50 })
    expect(ungrouped.nodes['b']).toMatchObject({ x: 160, y: 90 })
  })
})

describe('createMoveNodeCommand 换父时保持画布位置', () => {
  it('坐标换算成相对新父级的偏移，绝对位置不变；撤销能复原', () => {
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['f', 'c'],
      nodes: {
        f: { ...frame('f', []), x: 50, y: 60 } as Node,
        c: asset('c', null, { x: 100, y: 100 })
      }
    }
    const command = createMoveNodeCommand('c', 'f', 0)
    const applied = command.apply(graph)

    expect(applied.nodes['c']?.parentId).toBe('f')
    // 相对 f：(100-50, 100-60)
    expect(applied.nodes['c']).toMatchObject({ x: 50, y: 40 })
    expect(layout(applied)['c']).toMatchObject({ x: 100, y: 100 })

    const back = command.revert(applied)
    expect(back.nodes['c']).toMatchObject({ parentId: null, x: 100, y: 100 })
  })
})

describe('createReorderNodesCommand', () => {
  /** 三个同级 a、b、c 都挂在 f 下 */
  function flat(): ProjectGraph {
    const nodes = [frame('f', ['a', 'b', 'c']), asset('a', 'f'), asset('b', 'f'), asset('c', 'f')]
    return { projectId: 'p1', rootIds: ['f'], nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) }
  }

  it('上移一格', () => {
    expect(orderOf(createReorderNodesCommand(['a'], 'forward').apply(flat()), 'f')).toEqual(['b', 'a', 'c'])
  })

  it('下移一格', () => {
    expect(orderOf(createReorderNodesCommand(['c'], 'backward').apply(flat()), 'f')).toEqual(['a', 'c', 'b'])
  })

  it('置顶 / 置底', () => {
    expect(orderOf(createReorderNodesCommand(['a'], 'front').apply(flat()), 'f')).toEqual(['b', 'c', 'a'])
    expect(orderOf(createReorderNodesCommand(['c'], 'back').apply(flat()), 'f')).toEqual(['c', 'a', 'b'])
  })

  it('多选一起搬、块内顺序不变，且可撤销', () => {
    const command = createReorderNodesCommand(['a', 'b'], 'front')
    const applied = command.apply(flat())
    expect(orderOf(applied, 'f')).toEqual(['c', 'a', 'b'])
    expect(orderOf(command.revert(applied), 'f')).toEqual(['a', 'b', 'c'])
  })
})

describe('所有命令都不修改入参', () => {
  const cases: [string, (graph: ProjectGraph) => ProjectGraph][] = [
    ['rename', (g) => createRenameNodeCommand('a', 'x').apply(g)],
    ['flags', (g) => createSetNodeFlagsCommand('a', { locked: true }).apply(g)],
    ['reorder', (g) => createReorderCommand('f', 0, 1).apply(g)],
    ['reorder-bulk', (g) => createReorderNodesCommand(['a', 'b'], 'front').apply(g)],
    ['move', (g) => createMoveNodeCommand('a', null, 0).apply(g)],
    ['remove', (g) => createRemoveNodesCommand(['f']).apply(g)],
    ['group', (g) => createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(g)],
    ['ungroup', (g) =>
      createUngroupCommand('g').apply(
        createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(g)
      )]
  ]

  for (const [label, run] of cases) {
    it(label, () => {
      const graph = makeGraph()
      const snapshot = JSON.stringify(graph)
      run(graph)
      expect(JSON.stringify(graph)).toBe(snapshot)
    })
  }
})

describe('与 flattenTree 配合：编组后图层列表的样子', () => {
  it('组出现在正确的位置并带一层缩进', () => {
    const grouped = createGroupCommand({ groupId: 'g', nodeIds: ['a', 'b'] }).apply(makeGraph())
    expect(flattenTree(grouped).map((row) => `${row.depth}:${row.id}`)).toEqual([
      '0:f',
      '1:g',
      '2:a',
      '2:b',
      '0:c'
    ])
  })
})
