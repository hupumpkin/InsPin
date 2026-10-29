import { describe, expect, it } from 'vitest'
import {
  createAssetNode,
  createFrameNode,
  createGroupNode,
  type Node,
  type ProjectGraph
} from './node'
import { buildScene, contentBounds } from './scene'

function graphOf(nodes: Node[], rootIds: string[]): ProjectGraph {
  const map: ProjectGraph['nodes'] = {}
  for (const node of nodes) map[node.id] = node
  return { projectId: 'p1', rootIds, nodes: map }
}

const asset = (
  id: string,
  opts: { x?: number; y?: number; w?: number; h?: number; parentId?: string | null } = {}
) =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: opts.w ?? 100,
    h: opts.h ?? 50,
    parentId: opts.parentId ?? null,
    assetId: `a-${id}`,
    naturalWidth: 100,
    naturalHeight: 50
  })

describe('buildScene', () => {
  it('顶层按 rootIds 顺序返回，坐标就是模型里的绝对坐标', () => {
    const items = buildScene(graphOf([asset('n1', { x: 10, y: 20 }), asset('n2', { x: 30, y: 40 })], ['n2', 'n1']))

    expect(items.map((item) => item.node.id)).toEqual(['n2', 'n1'])
    expect({ x: items[0]?.absX, y: items[0]?.absY }).toEqual({ x: 30, y: 40 })
  })

  it('子节点嵌在父节点里，偏移是"相对父节点"的', () => {
    const parent = createFrameNode({ id: 'f1', projectId: 'p1', name: '容器', x: 100, y: 50, w: 300, h: 200 })
    const child = asset('n1', { x: 10, y: 20, parentId: 'f1' })
    // 父子关系由 parentId + childIds 两处表达（loadGraph 读库时就是这么建的）
    parent.childIds = ['n1']

    const [root] = buildScene(graphOf([parent, child], ['f1']))

    expect(root?.children.map((item) => item.node.id)).toEqual(['n1'])
    const nested = root?.children[0]
    // 绝对坐标 = 父的绝对 + 自己的相对
    expect({ x: nested?.absX, y: nested?.absY }).toEqual({ x: 110, y: 70 })
    // 相对偏移保持原样：渲染时嵌容器直接用它，父动子跟着动
    expect({ x: nested?.x, y: nested?.y }).toEqual({ x: 10, y: 20 })
  })

  it('组的盒子 = 内容的并集，而不是模型里存的 w/h', () => {
    // 组自己声明 500×500，可内容只有 (20,20)-(170,110) 这一块
    const group = createGroupNode({ id: 'g1', projectId: 'p1', name: '组', x: 20, y: 20, w: 500, h: 500 })
    const a = asset('a', { x: 0, y: 0, w: 100, h: 50, parentId: 'g1' })
    const b = asset('b', { x: 30, y: 70, w: 120, h: 20, parentId: 'g1' })
    group.childIds = ['a', 'b']

    const [root] = buildScene(graphOf([group, a, b], ['g1']))

    // 子节点绝对位置：a 在 (20,20)、b 在 (50,90) → 并集 (20,20) 起，150×90
    expect({ x: root?.absX, y: root?.absY, w: root?.w, h: root?.h }).toEqual({
      x: 20,
      y: 20,
      w: 150,
      h: 90
    })
    // 绝对位置纹丝不动，相对坐标反向挪回来（组现在按内容的左上角对齐）
    expect(root?.children.map((c) => ({ id: c.node.id, absX: c.absX, absY: c.absY }))).toEqual([
      { id: 'a', absX: 20, absY: 20 },
      { id: 'b', absX: 50, absY: 90 }
    ])
    expect(root?.children.map((c) => ({ x: c.x, y: c.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 70 }
    ])
  })

  it('动了组里的元素之后，组的盒子跟着内容走', () => {
    const group = createGroupNode({ id: 'g1', projectId: 'p1', name: '组', x: 0, y: 0, w: 100, h: 50 })
    const a = asset('a', { x: 0, y: 0, w: 100, h: 50, parentId: 'g1' })
    group.childIds = ['a']

    expect({ x: buildScene(graphOf([group, a], ['g1']))[0]?.absX }).toEqual({ x: 0 })

    // 把图挪到右边 200 处：组的左边界跟过去，宽度不变
    const moved = asset('a', { x: 200, y: 0, w: 100, h: 50, parentId: 'g1' })
    const [root] = buildScene(graphOf([group, moved], ['g1']))
    expect({ x: root?.absX, w: root?.w }).toEqual({ x: 200, w: 100 })
  })

  it('空组保留自己的盒子', () => {
    const group = createGroupNode({ id: 'g1', projectId: 'p1', name: '空组', x: 5, y: 6, w: 30, h: 40 })
    const [root] = buildScene(graphOf([group], ['g1']))
    expect({ x: root?.absX, y: root?.absY, w: root?.w, h: root?.h }).toEqual({
      x: 5,
      y: 6,
      w: 30,
      h: 40
    })
  })

  it('数据成环时不无限递归', () => {
    const a = asset('a', { parentId: 'b' })
    const b = asset('b', { parentId: 'a' })
    a.childIds = ['b']
    b.childIds = ['a']

    const items = buildScene(graphOf([a, b], ['a']))
    expect(items).toHaveLength(1)
  })

  it('空画布返回空数组', () => {
    expect(buildScene(graphOf([], []))).toEqual([])
  })
})

describe('contentBounds', () => {
  it('空画布返回 null', () => {
    expect(contentBounds([])).toBeNull()
  })

  it('把嵌套子节点一起算进包围盒', () => {
    const parent = createFrameNode({ id: 'f1', projectId: 'p1', name: '容器', x: 100, y: 100, w: 200, h: 100 })
    const child = asset('n1', { x: 150, y: 150, w: 100, h: 100, parentId: 'f1' })
    parent.childIds = ['n1']

    const bounds = contentBounds(buildScene(graphOf([parent, child], ['f1'])))
    // 父 (100,100,200x100)；子在其内偏移 (150,150) → 绝对 (250,250,100x100)，
    // 于是包围盒被子里那张撑到右下 (350,350)
    expect(bounds).toEqual({ x: 100, y: 100, w: 250, h: 250 })
  })

  it('忽略隐藏节点', () => {
    const hidden = asset('n1', { x: 0, y: 0, w: 10, h: 10 })
    hidden.visible = false
    expect(contentBounds(buildScene(graphOf([hidden], ['n1'])))).toBeNull()
  })
})
