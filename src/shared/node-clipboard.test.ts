import { describe, expect, it } from 'vitest'
import {
  createAssetNode,
  createFrameNode,
  createGroupNode,
  type Node,
  type ProjectGraph
} from './node'
import { copyNodes, createPasteCommand } from './node-clipboard'
import { buildScene } from './scene'
import { childrenOf } from './tree'

const asset = (
  id: string,
  parentId: string | null = null,
  extra: Partial<Node> = {}
): Node =>
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

const group = (id: string, parentId: string | null, childIds: string[]): Node =>
  ({
    ...createGroupNode({ id, projectId: 'p1', name: id, parentId }),
    childIds
  }) as Node

/** 顶层：组 g（里面 a、b）、单个 c */
function makeGraph(): ProjectGraph {
  const nodes = [group('g', null, ['a', 'b']), asset('a', 'g'), asset('b', 'g'), asset('c')]
  return {
    projectId: 'p1',
    rootIds: ['g', 'c'],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  }
}

/** 顺序固定、可预测的 id 工厂，方便断言。 */
function seqIds(): () => string {
  let n = 0
  return () => `new${++n}`
}

describe('copyNodes', () => {
  it('连子孙一起复制，并保留绘制顺序', () => {
    const clip = copyNodes(makeGraph(), ['g'])
    expect(clip?.roots).toEqual(['g'])
    expect(clip?.nodes.map((node) => node.id)).toEqual(['g', 'a', 'b'])
  })

  it('选中项里互为祖先时只留最外层，不会重复带子树', () => {
    const clip = copyNodes(makeGraph(), ['g', 'a'])
    expect(clip?.roots).toEqual(['g'])
    expect(clip?.nodes.map((node) => node.id)).toEqual(['g', 'a', 'b'])
  })

  it('空选或节点都不存在时返回 null', () => {
    expect(copyNodes(makeGraph(), [])).toBeNull()
    expect(copyNodes(makeGraph(), ['没有'])).toBeNull()
  })

  it('复制出来的是一份快照，改原图不影响它', () => {
    const graph = makeGraph()
    const clip = copyNodes(graph, ['c'])
    graph.nodes['c']!.name = '改了'
    expect(clip?.nodes[0]?.name).toBe('c')
  })
})

describe('createPasteCommand', () => {
  it('粘到顶层：新 id、结构保留、位置错开', () => {
    const graph = makeGraph()
    const clip = copyNodes(graph, ['g'])!
    const command = createPasteCommand(graph, clip, { idFactory: seqIds() })
    const pasted = command.apply(graph)

    // g -> new1, a -> new2, b -> new3
    expect(pasted.rootIds).toEqual(['g', 'c', 'new1'])
    expect(pasted.nodes['new1']?.childIds).toEqual(['new2', 'new3'])
    expect(pasted.nodes['new1']?.parentId).toBeNull()
    expect(pasted.nodes['new2']?.parentId).toBe('new1')
    // 原组在 (0,0)，粘贴后错开 16
    expect(pasted.nodes['new1']).toMatchObject({ x: 16, y: 16 })
    // 子节点保持相对坐标
    expect(pasted.nodes['new2']).toMatchObject({ x: 0, y: 0 })
  })

  it('撤销退回粘贴前的图，重做能再来一次且不重复', () => {
    const graph = makeGraph()
    const clip = copyNodes(graph, ['c'])!
    const command = createPasteCommand(graph, clip, { idFactory: seqIds() })

    const pasted = command.apply(graph)
    expect(pasted.rootIds).toEqual(['g', 'c', 'new1'])

    const undone = command.revert(pasted)
    expect(undone.rootIds).toEqual(['g', 'c'])
    expect(undone.nodes['new1']).toBeUndefined()

    const redone = command.apply(undone)
    expect(redone.rootIds).toEqual(['g', 'c', 'new1'])
  })

  it('粘进一个组时成为它的子节点，坐标相对新父级', () => {
    const graph = makeGraph()
    // 把 c 挪到 (100, 50)，粘进 g（g 在 0,0）
    graph.nodes['c'] = { ...graph.nodes['c']!, x: 100, y: 50 }
    const clip = copyNodes(graph, ['c'])!
    const command = createPasteCommand(graph, clip, { parentId: 'g', idFactory: seqIds() })
    const pasted = command.apply(graph)

    expect(pasted.nodes['new1']?.parentId).toBe('g')
    expect(childrenOf(pasted, 'g').map((node) => node.id)).toEqual(['a', 'b', 'new1'])
    expect(pasted.nodes['new1']).toMatchObject({ x: 116, y: 66 })
  })

  it('可在原位生成副本，供按住修饰键拖动后再决定位移', () => {
    const graph = makeGraph()
    graph.nodes['c'] = { ...graph.nodes['c']!, x: 100, y: 50 }
    const clip = copyNodes(graph, ['c'])!
    const pasted = createPasteCommand(graph, clip, { dx: 0, dy: 0, idFactory: seqIds() }).apply(graph)

    expect(pasted.nodes['new1']).toMatchObject({ x: 100, y: 50, parentId: null })
  })

  it('自动排列里的图片：原点复制用布局后的位置，不会跳到画布原点', () => {
    const frame = {
      ...createFrameNode({
        id: 'f',
        projectId: 'p1',
        name: 'f',
        x: 100,
        y: 100,
        w: 200,
        h: 100,
        props: { layoutMode: 'horizontal' }
      }),
      childIds: ['a']
    } as Node
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['f'],
      nodes: { f: frame, a: asset('a', 'f') }
    }

    const clip = copyNodes(graph, ['a'])!
    const pasted = createPasteCommand(graph, clip, { dx: 0, dy: 0, idFactory: seqIds() }).apply(graph)

    // 模型里 a 的 x/y 是 0，但布局把它摆在 (100,100)；副本必须落在这里
    expect(pasted.nodes['new1']).toMatchObject({ x: 100, y: 100, parentId: null })
    expect(buildScene(pasted).find((item) => item.node.id === 'new1')).toMatchObject({
      absX: 100,
      absY: 100
    })
  })

  it('复制组本身：原点归一到可见位置，直接子节点跟着换算，整组留在原地', () => {
    const graph = makeGraph()
    // 组自己仍在 (0,0)，子图被挪到了 (50,50)
    graph.nodes['a'] = { ...graph.nodes['a']!, x: 50, y: 50 }
    graph.nodes['b'] = { ...graph.nodes['b']!, x: 50, y: 50 }
    const clip = copyNodes(graph, ['g'])!
    const pasted = createPasteCommand(graph, clip, { dx: 0, dy: 0, idFactory: seqIds() }).apply(graph)

    expect(pasted.nodes['new1']).toMatchObject({ x: 50, y: 50, parentId: null })
    // 子节点相对坐标补偿了原点差，整组渲染出来仍在 (50,50)
    expect(pasted.nodes['new2']).toMatchObject({ x: 0, y: 0 })
    expect(buildScene(pasted).find((item) => item.node.id === 'new1')).toMatchObject({
      absX: 50,
      absY: 50
    })
  })

  it('指定画布落点时，整批对象以可见包围盒中心贴到该位置', () => {
    const graph = makeGraph()
    graph.nodes['c'] = { ...graph.nodes['c']!, x: 100, y: 50 }
    const clip = copyNodes(graph, ['g', 'c'])!

    const pasted = createPasteCommand(graph, clip, { center: { x: 300, y: 200 }, idFactory: seqIds() }).apply(graph)

    // 原可见包围盒为 (0, 0) → (110, 60)，故整体平移 (245, 170)。
    expect(pasted.nodes['new1']).toMatchObject({ x: 245, y: 170 })
    expect(pasted.nodes['new4']).toMatchObject({ x: 345, y: 220 })
  })

  it('剪切删掉原节点后粘贴，仍按复制时的位置回到落点', () => {
    const graph = makeGraph()
    graph.nodes['c'] = { ...graph.nodes['c']!, x: 100, y: 50 }
    const clip = copyNodes(graph, ['g', 'c'])!
    // 剪切后的画布：这批节点已经不在了
    const cutGraph: ProjectGraph = { ...graph, nodes: {}, rootIds: [] }

    const pasted = createPasteCommand(cutGraph, clip, {
      center: { x: 300, y: 200 },
      idFactory: seqIds()
    }).apply(cutGraph)

    expect(pasted.nodes['new1']).toMatchObject({ x: 245, y: 170 })
    expect(pasted.nodes['new4']).toMatchObject({ x: 345, y: 220 })
  })

  it('多张图片一起粘贴时横向排开，间距 16px', () => {
    const d = { ...asset('d'), x: 0, y: 0 } as Node
    const e = { ...asset('e'), x: 100, y: 50 } as Node
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['d', 'e'],
      nodes: { d, e }
    }
    const clip = copyNodes(graph, ['d', 'e'])!

    const pasted = createPasteCommand(graph, clip, {
      center: { x: 200, y: 200 },
      idFactory: seqIds()
    }).apply(graph)

    expect(pasted.nodes['new1']).toMatchObject({ x: 182, y: 195 })
    expect(pasted.nodes['new2']).toMatchObject({ x: 208, y: 195 })
  })
})
