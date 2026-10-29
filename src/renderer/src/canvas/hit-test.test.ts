import { describe, expect, it } from 'vitest'
import { createAssetNode, createFrameNode, type Node } from '../../../shared/node'
import { buildScene } from '../../../shared/scene'
import { boundsOfItems, hitTest, itemsInRect, rectFromPoints } from './hit-test'

function sceneOf(nodes: Node[], rootIds: string[]): ReturnType<typeof buildScene> {
  const map: Record<string, Node> = {}
  for (const node of nodes) map[node.id] = node
  return buildScene({ projectId: 'p1', rootIds, nodes: map })
}

const asset = (id: string, x: number, y: number, w = 100, h = 50, parentId: string | null = null) =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    x,
    y,
    w,
    h,
    parentId,
    assetId: `a-${id}`,
    naturalWidth: w,
    naturalHeight: h
  })

describe('hitTest', () => {
  it('点中节点的矩形内返回它', () => {
    const items = sceneOf([asset('n1', 0, 0)], ['n1'])
    expect(hitTest(items, { x: 50, y: 25 })).toBe('n1')
    expect(hitTest(items, { x: 200, y: 200 })).toBeNull()
  })

  it('叠在一起时取上面那个（绘制顺序靠后的）', () => {
    const items = sceneOf([asset('bottom', 0, 0), asset('top', 0, 0)], ['bottom', 'top'])
    expect(hitTest(items, { x: 10, y: 10 })).toBe('top')
  })

  it('点在子节点上时选子节点，不是容器', () => {
    const parent = createFrameNode({ id: 'f1', projectId: 'p1', name: '容器', x: 0, y: 0, w: 400, h: 400 })
    const child = asset('n1', 50, 50, 100, 100, 'f1')
    parent.childIds = ['n1']
    const items = sceneOf([parent, child], ['f1'])

    expect(hitTest(items, { x: 100, y: 100 })).toBe('n1')
    // 容器里、子节点外的位置选中容器本身
    expect(hitTest(items, { x: 350, y: 350 })).toBe('f1')
  })

  it('隐藏与锁定的节点点不到', () => {
    const hidden = asset('h', 0, 0)
    hidden.visible = false
    const locked = asset('l', 200, 0)
    locked.locked = true

    const items = sceneOf([hidden, locked], ['h', 'l'])
    expect(hitTest(items, { x: 10, y: 10 })).toBeNull()
    expect(hitTest(items, { x: 210, y: 10 })).toBeNull()
  })
})

describe('itemsInRect', () => {
  it('框到相交的节点，命中后不再往下钻', () => {
    const parent = createFrameNode({ id: 'f1', projectId: 'p1', name: '容器', x: 0, y: 0, w: 400, h: 400 })
    const child = asset('n1', 50, 50, 100, 100, 'f1')
    parent.childIds = ['n1']
    const items = sceneOf([parent, child], ['f1'])

    // 框住容器 → 只选容器，不把子节点也塞进来
    expect(itemsInRect(items, { x: -10, y: -10, w: 500, h: 500 })).toEqual(['f1'])
  })

  it('只框到子节点时选子节点', () => {
    const parent = createFrameNode({ id: 'f1', projectId: 'p1', name: '容器', x: 0, y: 0, w: 400, h: 400 })
    const child = asset('n2', 350, 350, 40, 40, 'f1')
    parent.childIds = ['n2']
    const sibling = asset('n1', 900, 900)
    const items = sceneOf([parent, child, sibling], ['f1', 'n1'])

    expect(itemsInRect(items, { x: 340, y: 340, w: 60, h: 60 })).toEqual(['n2'])
  })

  it('空框不选中任何东西', () => {
    const items = sceneOf([asset('n1', 0, 0)], ['n1'])
    expect(itemsInRect(items, { x: 500, y: 500, w: 10, h: 10 })).toEqual([])
  })
})

describe('rectFromPoints', () => {
  it('起点在右下时也能得到正矩形', () => {
    expect(rectFromPoints({ x: 100, y: 100 }, { x: 20, y: 30 })).toEqual({
      x: 20,
      y: 30,
      w: 80,
      h: 70
    })
  })
})

describe('boundsOfItems', () => {
  it('多个节点的共同包围盒', () => {
    const items = sceneOf([asset('a', 0, 0, 100, 50), asset('b', 200, 100, 100, 50)], ['a', 'b'])
    expect(boundsOfItems(items, ['a', 'b'])).toEqual({ x: 0, y: 0, w: 300, h: 150 })
  })

  it('单个节点就是它自己', () => {
    const items = sceneOf([asset('a', 30, 40, 100, 50)], ['a'])
    expect(boundsOfItems(items, ['a'])).toEqual({ x: 30, y: 40, w: 100, h: 50 })
  })

  it('空选择返回 null', () => {
    const items = sceneOf([asset('a', 0, 0)], ['a'])
    expect(boundsOfItems(items, [])).toBeNull()
    expect(boundsOfItems(items, ['nope'])).toBeNull()
  })
})
