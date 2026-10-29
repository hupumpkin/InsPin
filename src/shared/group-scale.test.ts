import { describe, expect, it } from 'vitest'
import { createAssetNode, createGroupNode, type Node, type ProjectGraph } from './node'
import { scaleGroupChanges } from './group-scale'
import type { BoxChange } from './node-commands'

/** 把命令里的 `to` 写进图（等价于 apply 那一步，只是为了断言方便）。 */
function applyResizeChanges(graph: ProjectGraph, changes: BoxChange[]): ProjectGraph {
  const nodes = { ...graph.nodes }
  for (const change of changes) {
    const node = nodes[change.id]
    if (node) nodes[change.id] = { ...node, ...change.to }
  }
  return { ...graph, nodes }
}

/** 每个节点在画布上的**绝对**盒子（父链坐标逐层累加）。 */
function boxesAfter(graph: ProjectGraph): Record<string, { x: number; y: number; w: number; h: number }> {
  const out: Record<string, { x: number; y: number; w: number; h: number }> = {}
  for (const id of Object.keys(graph.nodes)) {
    let node: Node | undefined = graph.nodes[id]
    let x = 0
    let y = 0
    while (node) {
      x += node.x
      y += node.y
      node = node.parentId ? graph.nodes[node.parentId] : undefined
    }
    const own = graph.nodes[id]!
    out[id] = { x, y, w: own.w, h: own.h }
  }
  return out
}

const asset = (
  id: string,
  parentId: string | null,
  x: number,
  y: number,
  w: number,
  h: number
): Node =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    parentId,
    x,
    y,
    w,
    h,
    assetId: `a-${id}`,
    naturalWidth: w,
    naturalHeight: h
  })

/** 组 g（原点 10,10；并集左上角在原点 + (0,0)）里两张图，另有一个独立顶层图 t。 */
function graphWithGroup(): ProjectGraph {
  const g = createGroupNode({ id: 'g', projectId: 'p1', name: '组', x: 10, y: 10, w: 500, h: 500 })
  g.childIds = ['a', 'b']
  return {
    projectId: 'p1',
    rootIds: ['g', 't'],
    nodes: {
      g,
      a: asset('a', 'g', 0, 0, 100, 50),
      b: asset('b', 'g', 30, 70, 120, 20),
      t: asset('t', null, 400, 300, 100, 100)
    }
  }
}

describe('scaleGroupChanges', () => {
  it('把组放大一倍：每个子孙的位置和尺寸都翻倍', () => {
    // 并集 = 原点(10,10) + 内容范围 (0,0)-(150,90) → from = 150×90
    const graph = graphWithGroup()
    const changes = scaleGroupChanges(graph, 'g', { x: 10, y: 10, w: 150, h: 90 }, { x: 10, y: 10, w: 300, h: 180 })

    const after = applyResizeChanges(graph, changes)
    // 组挪到新框的左上角
    expect(after.nodes['g']).toMatchObject({ x: 10, y: 10, w: 300, h: 180 })
    // a 在原点 (0,0) → 还是 (0,0)，尺寸翻倍
    expect(after.nodes['a']).toMatchObject({ x: 0, y: 0, w: 200, h: 100 })
    // b 在 (30,70) → (60,140)
    expect(after.nodes['b']).toMatchObject({ x: 60, y: 140, w: 240, h: 40 })
    // 画布上别的对象一动不动
    expect(after.nodes['t']).toMatchObject({ x: 400, y: 300, w: 100, h: 100 })
  })

  it('缩放后画布上的绝对位置正好是"围绕锚点按比例映射"', () => {
    const graph = graphWithGroup()
    const changes = scaleGroupChanges(graph, 'g', { x: 10, y: 10, w: 150, h: 90 }, { x: 10, y: 10, w: 300, h: 180 })
    const after = applyResizeChanges(graph, changes)

    // a 原绝对 (10,10)（组的左上角）→ 放大后仍是组的左上角
    expect(boxesAfter(after)['a']).toMatchObject({ x: 10, y: 10, w: 200, h: 100 })
    // b 原绝对 (40,80) → 距左上角 (30,70)，翻倍后距 (60,140) → 绝对 (70,150)
    expect(boxesAfter(after)['b']).toMatchObject({ x: 70, y: 150, w: 240, h: 40 })
  })

  it('组的原点不在并集左上角时，直接子节点要扣掉这段位移', () => {
    // 组原点在 (10,10)，但里面的图都摆在 (5,5) 之外 → 并集左上角 = (10+5, 10+5)
    const graph = graphWithGroup()
    graph.nodes['a'] = asset('a', 'g', 5, 5, 100, 50)
    graph.nodes['b'] = asset('b', 'g', 35, 75, 120, 20)

    const changes = scaleGroupChanges(graph, 'g', { x: 15, y: 15, w: 150, h: 90 }, { x: 15, y: 15, w: 300, h: 180 })
    const after = applyResizeChanges(graph, changes)

    // 并集左上角原本是 a 的左上角；放大后 a 仍贴着它（相对坐标归零）
    expect(after.nodes['a']).toMatchObject({ x: 0, y: 0, w: 200, h: 100 })
    expect(after.nodes['b']).toMatchObject({ x: 60, y: 140, w: 240, h: 40 })
  })

  it('嵌套的子组也一起缩', () => {
    const graph = graphWithGroup()
    const inner = createGroupNode({ id: 'inner', projectId: 'p1', name: '子组', x: 30, y: 70, w: 120, h: 20 })
    inner.parentId = 'g'
    inner.childIds = ['c']
    graph.nodes['inner'] = inner
    graph.nodes['c'] = asset('c', 'inner', 10, 5, 20, 10)
    graph.nodes['g'] = { ...graph.nodes['g']!, childIds: ['a', 'inner'] }
    delete graph.nodes['b']

    // 并集 = 内容 (0,0)-(100,90)
    const changes = scaleGroupChanges(graph, 'g', { x: 10, y: 10, w: 100, h: 90 }, { x: 10, y: 10, w: 200, h: 180 })
    const after = applyResizeChanges(graph, changes)

    expect(after.nodes['inner']).toMatchObject({ x: 60, y: 140, w: 240, h: 40 })
    // c 相对 inner：直接乘 2
    expect(after.nodes['c']).toMatchObject({ x: 20, y: 10, w: 40, h: 20 })
  })

  it('空组、零尺寸、组不存在都返回空', () => {
    const graph = graphWithGroup()
    graph.nodes['g'] = { ...graph.nodes['g']!, childIds: [] }
    expect(scaleGroupChanges(graph, 'g', { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 20, h: 20 })).toEqual([])
    expect(scaleGroupChanges(graphWithGroup(), 'g', { x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 1, h: 1 })).toEqual([])
    expect(scaleGroupChanges(graphWithGroup(), '没有', { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 20, h: 20 })).toEqual([])
  })
})
