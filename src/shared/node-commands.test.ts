import { describe, expect, it } from 'vitest'
import { HistoryStack } from './history'
import { createAssetNode, createCanvasElementNode, createFrameNode, type Node, type ProjectGraph } from './node'
import {
  createDeleteNodesCommand,
  createMoveNodesCommand,
  createResizeNodeCommand,
  createSetCanvasElementCommand,
  createSetAssetCropCommand,
  createRotateNodeCommand,
  normalizeAngle
} from './node-commands'

const asset = (id: string, opts: { x?: number; y?: number; parentId?: string | null } = {}): Node =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: 100,
    h: 50,
    parentId: opts.parentId ?? null,
    assetId: `a-${id}`,
    naturalWidth: 100,
    naturalHeight: 50
  })

function graphOf(nodes: Node[], rootIds: string[]): ProjectGraph {
  const map: ProjectGraph['nodes'] = {}
  for (const node of nodes) map[node.id] = node
  return { projectId: 'p1', rootIds, nodes: map }
}

describe('createMoveNodesCommand', () => {
  it('移动并撤销回原位', () => {
    const graph = graphOf([asset('n1', { x: 10, y: 20 })], ['n1'])
    const stack = new HistoryStack(graph)

    const moved = stack.execute(
      createMoveNodesCommand([{ id: 'n1', from: { x: 10, y: 20 }, to: { x: 110, y: 70 } }])
    )
    expect(moved.nodes['n1']).toMatchObject({ x: 110, y: 70 })

    const back = stack.undo()
    expect(back.nodes['n1']).toMatchObject({ x: 10, y: 20 })
  })

  it('一次移动多个节点', () => {
    const graph = graphOf([asset('n1'), asset('n2')], ['n1', 'n2'])
    const stack = new HistoryStack(graph)

    stack.execute(
      createMoveNodesCommand([
        { id: 'n1', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } },
        { id: 'n2', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }
      ])
    )
    expect(stack.graph.nodes['n1']).toMatchObject({ x: 5, y: 5 })
    expect(stack.graph.nodes['n2']).toMatchObject({ x: 5, y: 5 })
  })

  it('不就地改输入', () => {
    const graph = graphOf([asset('n1', { x: 1, y: 2 })], ['n1'])
    createMoveNodesCommand([{ id: 'n1', from: { x: 1, y: 2 }, to: { x: 9, y: 9 } }]).apply(graph)
    expect(graph.nodes['n1']).toMatchObject({ x: 1, y: 2 })
  })
})

describe('createResizeNodeCommand', () => {
  it('改尺寸并撤销', () => {
    const graph = graphOf([asset('n1', { x: 0, y: 0 })], ['n1'])
    const stack = new HistoryStack(graph)
    const from = { x: 0, y: 0, w: 100, h: 50 }
    const to = { x: -50, y: -25, w: 200, h: 100 }

    stack.execute(createResizeNodeCommand('n1', from, to))
    expect(stack.graph.nodes['n1']).toMatchObject(to)

    stack.undo()
    expect(stack.graph.nodes['n1']).toMatchObject(from)
  })
})

describe('createSetAssetCropCommand', () => {
  it('以一条命令保存裁切区域，并能撤销回完整原图', () => {
    const graph = graphOf([asset('n1')], ['n1'])
    const stack = new HistoryStack(graph)
    stack.execute(
      createSetAssetCropCommand(
        'n1',
        { box: { x: 0, y: 0, w: 100, h: 50 }, crop: { x: 0, y: 0, w: 1, h: 1 } },
        { box: { x: 20, y: 0, w: 80, h: 50 }, crop: { x: 0.2, y: 0, w: 0.8, h: 1 } }
      )
    )
    expect(stack.graph.nodes.n1).toMatchObject({ x: 20, w: 80, props: { crop: { x: 0.2, w: 0.8 } } })
    stack.undo()
    expect(stack.graph.nodes.n1).toMatchObject({ x: 0, w: 100 })
    expect(stack.graph.nodes.n1?.props).not.toHaveProperty('crop')
  })
})

describe('createSetCanvasElementCommand', () => {
  it('更新形状样式并能撤销', () => {
    const shape = createCanvasElementNode({
      id: 'shape', projectId: 'p1', name: '矩形', w: 100, h: 80,
      element: { kind: 'shape', shape: 'rectangle', fill: '#635BFF', cornerRadius: 12 }
    })
    const stack = new HistoryStack(graphOf([shape], ['shape']))
    const from = shape.props.element!
    const to = { ...from, fill: '#FF4D6D', cornerRadius: 24 } as typeof from
    stack.execute(createSetCanvasElementCommand(shape.id, from, to))
    expect((stack.graph.nodes.shape?.type === 'frame' ? stack.graph.nodes.shape.props.element : null)).toMatchObject(to)
    stack.undo()
    expect((stack.graph.nodes.shape?.type === 'frame' ? stack.graph.nodes.shape.props.element : null)).toMatchObject(from)
  })
})

describe('createRotateNodeCommand', () => {
  it('旋转并撤销', () => {
    const graph = graphOf([asset('n1')], ['n1'])
    const stack = new HistoryStack(graph)

    stack.execute(createRotateNodeCommand('n1', 0, 45))
    expect(stack.graph.nodes['n1']?.rotation).toBe(45)

    stack.undo()
    expect(stack.graph.nodes['n1']?.rotation).toBe(0)
  })

  it('角度归一化到 (-180, 180]', () => {
    expect(normalizeAngle(370)).toBe(10)
    expect(normalizeAngle(-370)).toBe(-10)
    expect(normalizeAngle(180)).toBe(180)
    expect(normalizeAngle(540)).toBe(180)
  })

  it('节点不存在时不动图', () => {
    const graph = graphOf([asset('n1')], ['n1'])
    expect(createRotateNodeCommand('nope', 0, 90).apply(graph)).toBe(graph)
  })
})

describe('createDeleteNodesCommand', () => {
  it('删掉节点并撤销回原顺序', () => {
    const graph = graphOf([asset('a'), asset('b'), asset('c')], ['a', 'b', 'c'])
    const stack = new HistoryStack(graph)

    stack.execute(createDeleteNodesCommand(graph, ['b']))
    expect(stack.graph.rootIds).toEqual(['a', 'c'])
    expect(stack.graph.nodes['b']).toBeUndefined()

    stack.undo()
    // 不光是回来了，还要回到中间那个位置
    expect(stack.graph.rootIds).toEqual(['a', 'b', 'c'])
  })

  it('一次删多个也能按原顺序放回', () => {
    const graph = graphOf([asset('a'), asset('b'), asset('c'), asset('d')], ['a', 'b', 'c', 'd'])
    const stack = new HistoryStack(graph)

    stack.execute(createDeleteNodesCommand(graph, ['d', 'b']))
    expect(stack.graph.rootIds).toEqual(['a', 'c'])

    stack.undo()
    expect(stack.graph.rootIds).toEqual(['a', 'b', 'c', 'd'])
  })

  it('删父节点会连子孙一起删，撤销一起回来', () => {
    const parent = createFrameNode({ id: 'f1', projectId: 'p1', name: '容器', x: 0, y: 0 })
    const child = asset('n1', { parentId: 'f1' })
    parent.childIds = ['n1']
    const graph = graphOf([parent, child], ['f1'])
    const stack = new HistoryStack(graph)

    stack.execute(createDeleteNodesCommand(graph, ['f1']))
    expect(stack.graph.rootIds).toEqual([])
    expect(stack.graph.nodes['n1']).toBeUndefined()

    stack.undo()
    expect(stack.graph.rootIds).toEqual(['f1'])
    expect(stack.graph.nodes['n1']).toBeDefined()
    expect(stack.graph.nodes['f1']?.childIds).toEqual(['n1'])
  })

  it('删不存在的 id 是空操作', () => {
    const graph = graphOf([asset('a')], ['a'])
    const stack = new HistoryStack(graph)
    stack.execute(createDeleteNodesCommand(graph, ['nope']))
    expect(stack.graph.rootIds).toEqual(['a'])
  })
})

describe('命令与历史栈配合', () => {
  it('撤销再重做等于峰值状态', () => {
    const graph = graphOf([asset('n1', { x: 0, y: 0 })], ['n1'])
    const stack = new HistoryStack(graph)

    stack.execute(createMoveNodesCommand([{ id: 'n1', from: { x: 0, y: 0 }, to: { x: 40, y: 0 } }]))
    stack.execute(createMoveNodesCommand([{ id: 'n1', from: { x: 40, y: 0 }, to: { x: 40, y: 90 } }]))
    const peak = structuredClone(stack.graph)

    stack.undo()
    stack.undo()
    expect(stack.graph.nodes['n1']).toMatchObject({ x: 0, y: 0 })

    stack.redo()
    stack.redo()
    expect(stack.graph).toEqual(peak)
  })
})
