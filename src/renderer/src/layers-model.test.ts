import { describe, expect, it } from 'vitest'
import { createAssetNode, createCanvasElementNode, createGroupNode, type Node, type ProjectGraph } from '../../shared/node'
import { displayChildIds, displayToModelIndex, layerDisplayName, layerKind, toArboristTree } from './layers-model'

const asset = (id: string, parentId: string | null = null): Node =>
  ({
    ...createAssetNode({
      id,
      projectId: 'p1',
      name: id,
      parentId,
      assetId: `a-${id}`,
      naturalWidth: 1,
      naturalHeight: 1
    })
  }) as Node

const group = (id: string, parentId: string | null, childIds: string[]): Node =>
  ({ ...createGroupNode({ id, projectId: 'p1', name: id, parentId }), childIds }) as Node

/** 顶层：a、b、组 g（里面 c、d）——绘制顺序 a,b,g */
function makeGraph(): ProjectGraph {
  const nodes = [asset('a'), asset('b'), group('g', null, ['c', 'd']), asset('c', 'g'), asset('d', 'g')]
  return {
    projectId: 'p1',
    rootIds: ['a', 'b', 'g'],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  }
}

describe('displayChildIds', () => {
  it('返回面板显示顺序（模型倒序），最上层在前', () => {
    expect(displayChildIds(makeGraph(), null)).toEqual(['g', 'b', 'a'])
    expect(displayChildIds(makeGraph(), 'g')).toEqual(['d', 'c'])
  })
})

describe('toArboristTree', () => {
  it('最上层排最前，子节点挂在父节点下', () => {
    const tree = toArboristTree(makeGraph())
    expect(tree.map((node) => node.id)).toEqual(['g', 'b', 'a'])
    expect(tree[0]?.children?.map((node) => node.id)).toEqual(['d', 'c'])
  })

  it('叶子节点不带 children（不画展开箭头）', () => {
    const tree = toArboristTree(makeGraph())
    const a = tree.find((node) => node.id === 'a')
    expect(a?.children).toBeUndefined()
  })

  it('带上行要用的显示状态', () => {
    const graph = makeGraph()
    graph.nodes['a'] = { ...graph.nodes['a']!, visible: false, locked: true }
    const a = toArboristTree(graph).find((node) => node.id === 'a')
    expect(a).toMatchObject({ type: 'asset', visible: false, locked: true })
  })

  it('默认文本名展示正文，图片名隐藏文件扩展名，自定义名保持原样', () => {
    const text = createCanvasElementNode({
      id: 't',
      projectId: 'p1',
      name: '文本',
      element: { kind: 'text', text: '本月可领 1 次\n第二行', color: '#000', fontSize: 16 }
    })
    const renamed = { ...text, name: '领取说明' }
    const picture = createAssetNode({
      id: 'p', projectId: 'p1', name: '海边日落.PNG', assetId: 'a-p', naturalWidth: 1, naturalHeight: 1
    })
    expect(layerDisplayName(text)).toBe('本月可领 1 次')
    expect(layerDisplayName(renamed)).toBe('领取说明')
    expect(layerDisplayName(picture)).toBe('海边日落')
    expect(layerKind(text)).toBe('text')
  })

  it('跳过指向不存在节点的引用，也不会因为成环卡死', () => {
    const graph: ProjectGraph = {
      projectId: 'p1',
      rootIds: ['a', '缺失'],
      nodes: { a: group('a', null, ['a']) }
    }
    expect(toArboristTree(graph).map((node) => node.id)).toEqual(['a'])
  })
})

describe('displayToModelIndex', () => {
  it('显示顺序与模型顺序互为倒序，插入位置要翻过来', () => {
    // 模型 [a,b,c] → 显示 [c,b,a]；显示里插到最前(0) 等价于模型里插到最后(3)
    expect(displayToModelIndex(0, 3)).toBe(3)
    expect(displayToModelIndex(3, 3)).toBe(0)
    expect(displayToModelIndex(1, 3)).toBe(2)
  })
})
