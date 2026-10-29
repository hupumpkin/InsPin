import { describe, expect, it } from 'vitest'
import { createAssetNode, createFrameNode, type Node, type ProjectGraph } from './node'
import {
  createRemoveAutoLayoutCommand,
  createSetAutoLayoutCommand,
  createSetChildLayoutCommand,
  createWrapInAutoLayoutCommand
} from './auto-layout-commands'
import { layout } from './layout'
import { childrenOf } from './tree'

const asset = (id: string, x: number, y: number, w = 100, h = 80): Node =>
  ({
    ...createAssetNode({
      id,
      projectId: 'p1',
      name: id,
      x,
      y,
      w,
      h,
      assetId: `a-${id}`,
      naturalWidth: w,
      naturalHeight: h
    })
  }) as Node

/** 两个顶层图片：a 在 (0,0)，b 在 (200, 50) */
function makeGraph(): ProjectGraph {
  return {
    projectId: 'p1',
    rootIds: ['a', 'b'],
    nodes: { a: asset('a', 0, 0), b: asset('b', 200, 50) }
  }
}

describe('createWrapInAutoLayoutCommand', () => {
  it('把选中节点装进一个带布局的容器，包围盒取并集', () => {
    const command = createWrapInAutoLayoutCommand(makeGraph(), ['a', 'b'], { frameId: 'f' })
    const applied = command.apply(makeGraph())

    expect(applied.rootIds).toEqual(['f'])
    expect(applied.nodes['a']?.parentId).toBe('f')
    expect(applied.nodes['b']?.parentId).toBe('f')
    expect(childrenOf(applied, 'f').map((node) => node.id)).toEqual(['a', 'b'])

    const frame = applied.nodes['f']
    expect(frame?.type).toBe('frame')
    // 并集：x 0..300、y 0..130
    expect(frame).toMatchObject({ x: 0, y: 0, w: 300, h: 130 })
    // 子节点坐标换算成相对容器
    expect(applied.nodes['b']).toMatchObject({ x: 200, y: 50 })
  })

  it('套上网格时带上按数量算的列数', () => {
    const applied = createWrapInAutoLayoutCommand(makeGraph(), ['a', 'b'], {
      frameId: 'f',
      mode: 'grid'
    }).apply(makeGraph())
    const frame = applied.nodes['f']
    expect(frame?.type === 'frame' && frame.props.layoutMode).toBe('grid')
    expect(frame?.type === 'frame' && frame.props.gridColumns).toBe(2)
  })

  it('求解器真的把子节点排开了（间距生效）', () => {
    const applied = createWrapInAutoLayoutCommand(makeGraph(), ['a', 'b'], { frameId: 'f' }).apply(
      makeGraph()
    )
    const boxes = layout(applied)
    // 横向、间距 16、内边距 16：a 在 (16,16)，b 在 (16+100+16, 16)
    expect(boxes['a']).toMatchObject({ x: 16, y: 16 })
    expect(boxes['b']).toMatchObject({ x: 132, y: 16 })
  })

  it('被套的对象不在画布原点时，框跟着它们走，内容不会被搬到原点', () => {
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['a', 'b'],
      nodes: { a: asset('a', 400, 0), b: asset('b', 600, 0) }
    }
    const applied = createWrapInAutoLayoutCommand(graph, ['a', 'b'], { frameId: 'f' }).apply(graph)

    expect(applied.nodes['f']).toMatchObject({ x: 400, y: 0 })
    // 框左上角 + 内边距 16 → a 排在 (416, 16)
    const boxes = layout(applied)
    expect(boxes['a']).toMatchObject({ x: 416, y: 16 })
  })

  it('撤销退回原来两张自由图片', () => {
    const graph = makeGraph()
    const command = createWrapInAutoLayoutCommand(graph, ['a', 'b'], { frameId: 'f' })
    const undone = command.revert(command.apply(graph))
    expect(undone.rootIds).toEqual(['a', 'b'])
    expect(undone.nodes['f']).toBeUndefined()
  })
})

describe('createSetAutoLayoutCommand', () => {
  const withFrame = (): ProjectGraph =>
    createWrapInAutoLayoutCommand(makeGraph(), ['a', 'b'], { frameId: 'f' }).apply(makeGraph())

  it('改间距、方向可以撤销', () => {
    const graph = withFrame()
    const command = createSetAutoLayoutCommand('f', { itemSpacing: 40 })
    const applied = command.apply(graph)
    expect(applied.nodes['f']?.type === 'frame' && applied.nodes['f'].props.itemSpacing).toBe(40)
    const back = command.revert(applied)
    expect(back.nodes['f']?.type === 'frame' && back.nodes['f'].props.itemSpacing).toBe(16)
  })

  it('解除自动布局 = 连那个套出来的框一起解散，孩子画布位置不动', () => {
    const graph = withFrame()
    const before = layout(graph)

    const applied = createRemoveAutoLayoutCommand('f').apply(graph)

    expect(applied.nodes['f']).toBeUndefined()
    expect(applied.rootIds).toEqual(['a', 'b'])
    // 绝对位置纹丝不动（框在 (0,0) 附近也不许平移）
    const after = layout(applied)
    expect(after['a']).toMatchObject({ x: before['a']!.x, y: before['a']!.y })
    expect(after['b']).toMatchObject({ x: before['b']!.x, y: before['b']!.y })
    expect(after['b']!.x).toBeGreaterThan(0)
  })

  it('解除自动布局可以撤销：框和布局一起回来', () => {
    const graph = withFrame()
    const command = createRemoveAutoLayoutCommand('f')
    const back = command.revert(command.apply(graph))

    expect(back.rootIds).toEqual(['f'])
    expect(back.nodes['f']?.type === 'frame' && back.nodes['f'].props.layoutMode).toBe('horizontal')
    expect(back.nodes['a']?.parentId).toBe('f')
  })

  it('对非 frame 是空操作', () => {
    const graph = makeGraph()
    expect(createSetAutoLayoutCommand('a', { itemSpacing: 1 }).apply(graph)).toBe(graph)
  })
})

describe('createSetChildLayoutCommand', () => {
  it('改子节点的撑满/占份数可以撤销', () => {
    const graph = makeGraph()
    const command = createSetChildLayoutCommand('a', { layoutAlign: 'stretch', layoutGrow: 1 })
    const applied = command.apply(graph)
    expect(applied.nodes['a']?.props).toMatchObject({ layoutAlign: 'stretch', layoutGrow: 1 })
    const back = command.revert(applied)
    expect(back.nodes['a']?.props).toMatchObject({ layoutAlign: 'inherit', layoutGrow: 0 })
  })
})

describe('不修改入参', () => {
  it('套上布局不改原图', () => {
    const graph = makeGraph()
    const snapshot = JSON.stringify(graph)
    createWrapInAutoLayoutCommand(graph, ['a', 'b'], { frameId: 'f' }).apply(graph)
    expect(JSON.stringify(graph)).toBe(snapshot)
  })
})
