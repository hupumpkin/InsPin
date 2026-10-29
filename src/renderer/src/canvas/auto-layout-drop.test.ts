import { describe, expect, it } from 'vitest'
import { createAssetNode, createFrameNode, type Node, type ProjectGraph } from '../../../shared/node'
import type { SceneItem } from '../../../shared/scene'
import { computeContainerDrop, findContainerAt, findItem, parentIsContainer } from './auto-layout-drop'

const asset = (id: string): Node =>
  ({
    ...createAssetNode({
      id,
      projectId: 'p',
      name: id,
      assetId: `a-${id}`,
      naturalWidth: 1,
      naturalHeight: 1
    })
  }) as Node

const frame = (id: string, mode: 'none' | 'horizontal' | 'vertical' | 'grid', childIds: string[]): Node =>
  ({
    ...createFrameNode({
      id,
      projectId: 'p',
      name: id,
      props: { layoutMode: mode, itemSpacing: 10, padding: { top: 16, right: 16, bottom: 16, left: 16 } }
    }),
    childIds
  }) as Node

function item(node: Node, box: [number, number, number, number], children: SceneItem[] = []): SceneItem {
  return { node, absX: box[0], absY: box[1], w: box[2], h: box[3], x: box[0], y: box[1], children }
}

/** 横向容器 f：内边距 16、间距 10，里面三个 100×80 的图，起点 (16,16) */
function scene(): SceneItem[] {
  const children = [
    item(asset('a'), [16, 16, 100, 80]),
    item(asset('b'), [126, 16, 100, 80]),
    item(asset('c'), [236, 16, 100, 80])
  ]
  return [item(frame('f', 'horizontal', ['a', 'b', 'c']), [0, 0, 352, 112], children)]
}

const graphOf = (mode: 'horizontal' | 'vertical' | 'grid' = 'horizontal'): ProjectGraph => ({
  projectId: 'p',
  rootIds: ['f'],
  nodes: { f: frame('f', mode, ['a']), a: asset('a') }
})

describe('findItem / findContainerAt', () => {
  it('按 id 找到条目', () => {
    expect(findItem(scene(), 'b')?.node.id).toBe('b')
    expect(findItem(scene(), '没有')).toBeNull()
  })

  it('找到指针下最深的自动布局容器，排除被拖动的节点', () => {
    expect(findContainerAt(scene(), { x: 50, y: 50 })?.node.id).toBe('f')
    expect(findContainerAt(scene(), { x: 999, y: 999 })).toBeNull()
    expect(findContainerAt(scene(), { x: 50, y: 50 }, new Set(['f']))).toBeNull()
  })

  it('布局为 none 的 frame 不算容器', () => {
    const items = [item(frame('g', 'none', ['a']), [0, 0, 100, 100], [item(asset('a'), [10, 10, 50, 50])])]
    expect(findContainerAt(items, { x: 20, y: 20 })).toBeNull()
  })
})

describe('computeContainerDrop', () => {
  it('落在某张图左半边 → 插在它前面，插入线画在它左边', () => {
    const drop = computeContainerDrop(graphOf(), scene(), { x: 30, y: 50 })
    expect(drop?.containerId).toBe('f')
    expect(drop?.index).toBe(0)
    // 第一条左边 16，线想画在 16 - gap/2 = 11，但夹在内边距里 → 落在 16
    expect(drop?.line).toMatchObject({ w: 2 })
    expect(drop?.line.x).toBeCloseTo(15, 5)
  })

  it('落在中间图的右半边 → 插在第三张前面', () => {
    const drop = computeContainerDrop(graphOf(), scene(), { x: 200, y: 50 })
    expect(drop?.index).toBe(2)
  })

  it('落在最后一张之后 → 插到末尾', () => {
    const drop = computeContainerDrop(graphOf(), scene(), { x: 340, y: 50 })
    expect(drop?.index).toBe(3)
  })

  it('不在任何容器里返回 null', () => {
    expect(computeContainerDrop(graphOf(), scene(), { x: 900, y: 900 })).toBeNull()
  })

  it('拖动列表里的某项时，落点按“摘掉它之后”计算', () => {
    // b 被拖动：流里只剩 a、c，插入线才不会指向它自己的原位置
    expect(computeContainerDrop(graphOf(), scene(), { x: 20, y: 50 }, ['b'])?.index).toBe(0)
    expect(computeContainerDrop(graphOf(), scene(), { x: 200, y: 50 }, ['b'])?.index).toBe(1)
    expect(computeContainerDrop(graphOf(), scene(), { x: 340, y: 50 }, ['b'])?.index).toBe(2)
  })
})

describe('parentIsContainer', () => {
  it('父级是自动布局容器才为真', () => {
    const graph: ProjectGraph = {
      projectId: 'p',
      rootIds: ['f', 'z'],
      nodes: { f: frame('f', 'horizontal', ['a']), a: asset('a'), z: asset('z') }
    }
    // a 的 parentId 需要指向 f
    graph.nodes['a'] = { ...graph.nodes['a']!, parentId: 'f' }
    expect(parentIsContainer(graph, 'a')).toBe(true)
    expect(parentIsContainer(graph, 'z')).toBe(false)
  })
})
