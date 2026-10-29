import { describe, expect, it } from 'vitest'
import { layout } from './layout'
import { createAssetNode, createFrameNode, createGroupNode, type Node, type ProjectGraph } from './node'

function graph(rootIds: string[], nodes: Node[]): ProjectGraph {
  return {
    projectId: 'p1',
    rootIds,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  }
}

const asset = (
  id: string,
  w: number,
  h: number,
  extra: Partial<Parameters<typeof createAssetNode>[0]> = {}
): Node =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    w,
    h,
    assetId: `a-${id}`,
    naturalWidth: w,
    naturalHeight: h,
    ...extra
  })

type FramePropsInput = NonNullable<Parameters<typeof createFrameNode>[0]['props']>

const frame = (id: string, props: FramePropsInput = {}, extra: Record<string, unknown> = {}): Node => {
  const node = createFrameNode({ id, projectId: 'p1', name: id, ...extra })
  return {
    ...node,
    props: {
      ...node.props,
      ...props,
      // padding 是嵌套对象，只传一条边时其余边保持默认
      padding: { ...node.props.padding, ...props.padding }
    }
  } as Node
}

/** 给容器挂子节点 */
function withChildren(parent: Node, childIds: string[]): Node {
  return { ...parent, childIds }
}

describe('不参与自动布局的情况', () => {
  it('顶层节点用自己声明的坐标', () => {
    const result = layout(graph(['n1'], [asset('n1', 100, 50, { x: 30, y: 40 })]))
    expect(result['n1']).toEqual({ x: 30, y: 40, w: 100, h: 50 })
  })

  it('普通容器（layoutMode 为 none）子节点按相对偏移累加', () => {
    const parent = withChildren(
      createFrameNode({ id: 'p', projectId: 'p1', name: 'p', x: 100, y: 200 }),
      ['c']
    )
    const child = asset('c', 10, 10, { x: 5, y: 7, parentId: 'p' })

    const result = layout(graph(['p'], [parent, child]))
    expect(result['p']).toEqual({ x: 100, y: 200, w: 0, h: 0 })
    expect(result['c']).toEqual({ x: 105, y: 207, w: 10, h: 10 })
  })

  it('不修改输入', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal' }, { w: 300, h: 100 }),
      ['c']
    )
    const input = graph(['p'], [parent, asset('c', 100, 50, { parentId: 'p' })])
    const snapshot = JSON.stringify(input)
    layout(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('只遍历 rootIds 可达的节点', () => {
    expect(Object.keys(layout(graph(['n1'], [asset('n1', 10, 10), asset('orphan', 10, 10)])))).toEqual([
      'n1'
    ])
  })

  it('rootIds 指向不存在的节点时跳过', () => {
    expect(layout(graph(['missing'], []))).toEqual({})
  })

  it('数据成环时不会无限递归', () => {
    const a = createGroupNode({ id: 'a', projectId: 'p1', name: 'a' })
    const b = createGroupNode({ id: 'b', projectId: 'p1', name: 'b' })
    expect(() => layout(graph(['a'], [withChildren(a, ['b']), withChildren(b, ['a'])]))).not.toThrow()
  })
})

describe('D4b.1 横向 / 纵向 + hug / fixed', () => {
  it('横向：按间距依次排开', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', itemSpacing: 10 }, { w: 400, h: 100 }),
      ['a', 'b', 'c']
    )
    const result = layout(
      graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p' }), asset('b', 100, 50, { parentId: 'p' }), asset('c', 100, 50, { parentId: 'p' })])
    )

    expect(result['a']).toMatchObject({ x: 0, y: 0 })
    expect(result['b']).toMatchObject({ x: 110, y: 0 })
    expect(result['c']).toMatchObject({ x: 220, y: 0 })
  })

  it('纵向：主轴变成高度', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'vertical', itemSpacing: 10 }, { w: 100, h: 300 }),
      ['a', 'b']
    )
    const result = layout(graph(['p'], [parent, asset('a', 50, 100, { parentId: 'p' }), asset('b', 50, 100, { parentId: 'p' })]))

    expect(result['a']).toMatchObject({ x: 0, y: 0, w: 50, h: 100 })
    expect(result['b']).toMatchObject({ x: 0, y: 110, w: 50, h: 100 })
  })

  it('hug：容器由内容撑开（含内边距）', () => {
    const parent = withChildren(
      frame(
        'p',
        {
          layoutMode: 'horizontal',
          itemSpacing: 10,
          primaryAxisSizing: 'hug',
          counterAxisSizing: 'hug',
          padding: { top: 10, bottom: 10, left: 20, right: 20 }
        },
        { w: 0, h: 0 }
      ),
      ['a', 'b']
    )
    const result = layout(graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p' }), asset('b', 100, 50, { parentId: 'p' })]))

    expect(result['p']).toEqual({ x: 0, y: 0, w: 250, h: 70 })
    expect(result['a']).toMatchObject({ x: 20, y: 10 })
    expect(result['b']).toMatchObject({ x: 130, y: 10 })
  })

  it('fixed：容器用自己的尺寸', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', primaryAxisSizing: 'fixed', counterAxisSizing: 'fixed' }, { w: 500, h: 120 }),
      ['a']
    )
    const result = layout(graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p' })]))
    expect(result['p']).toEqual({ x: 0, y: 0, w: 500, h: 120 })
  })

  it('主轴居中与靠尾对齐', () => {
    const xFor = (align: 'center' | 'end'): number => {
      const parent = withChildren(
        frame('p', { layoutMode: 'horizontal', primaryAxisAlignItems: align }, { w: 300, h: 100 }),
        ['a']
      )
      return layout(graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p' })]))['a']?.x ?? -1
    }

    expect(xFor('center')).toBe(100)
    expect(xFor('end')).toBe(200)
  })

  it('主轴 space-between 均分剩余空间', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', primaryAxisAlignItems: 'space-between' }, { w: 400, h: 100 }),
      ['a', 'b', 'c']
    )
    const result = layout(
      graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p' }), asset('b', 100, 50, { parentId: 'p' }), asset('c', 100, 50, { parentId: 'p' })])
    )

    expect(result['a']?.x).toBe(0)
    expect(result['b']?.x).toBe(150)
    expect(result['c']?.x).toBe(300)
  })

  it('次轴居中', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', counterAxisAlignItems: 'center' }, { w: 300, h: 200 }),
      ['a']
    )
    const result = layout(graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p' })]))
    expect(result['a']?.y).toBe(75)
  })
})

describe('D4b.2 stretch / grow', () => {
  it('grow 按比例分掉多余空间', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal' }, { w: 400, h: 100 }),
      ['a', 'b']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 100, 50, { parentId: 'p', props: { layoutGrow: 1 } }),
        asset('b', 100, 50, { parentId: 'p', props: { layoutGrow: 1 } })
      ])
    )

    expect(result['a']).toMatchObject({ x: 0, w: 200 })
    expect(result['b']).toMatchObject({ x: 200, w: 200 })
  })

  it('没有 grow 的节点保持原尺寸', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal' }, { w: 400, h: 100 }),
      ['a', 'b']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 100, 50, { parentId: 'p', props: { layoutGrow: 1 } }),
        asset('b', 100, 50, { parentId: 'p' })
      ])
    )

    expect(result['a']).toMatchObject({ x: 0, w: 300 })
    expect(result['b']).toMatchObject({ x: 300, w: 100 })
  })

  it('空间不够时不会把节点挤成负宽度', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal' }, { w: 100, h: 100 }),
      ['a']
    )
    const result = layout(
      graph(['p'], [parent, asset('a', 200, 50, { parentId: 'p', props: { layoutGrow: 1 } })])
    )
    expect(result['a']?.w).toBe(200)
  })

  it('stretch 撑满次轴', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal' }, { w: 300, h: 200 }),
      ['a']
    )
    const result = layout(
      graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p', props: { layoutAlign: 'stretch' } })])
    )
    expect(result['a']).toMatchObject({ x: 0, y: 0, w: 100, h: 200 })
  })

  it('stretch 配合内边距不会溢出', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', padding: { top: 20, bottom: 20, left: 5, right: 5 } }, { w: 300, h: 200 }),
      ['a']
    )
    const result = layout(
      graph(['p'], [parent, asset('a', 100, 50, { parentId: 'p', props: { layoutAlign: 'stretch' } })])
    )
    expect(result['a']).toMatchObject({ x: 5, y: 20, h: 160 })
  })
})

describe('D4b.3 网格与换行', () => {
  it('网格：图片保持原尺寸，只按单元格对齐', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'grid', gridColumns: 2, itemSpacing: 10 }, { w: 220, h: 100 }),
      ['a', 'b', 'c', 'd']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 100, 40, { parentId: 'p' }),
        asset('b', 100, 40, { parentId: 'p' }),
        asset('c', 100, 40, { parentId: 'p' }),
        asset('d', 100, 40, { parentId: 'p' })
      ])
    )

    // 列宽仍是 105（固定宽度容器），但图片保持 100×40，不被拉宽
    expect(result['a']).toMatchObject({ x: 0, y: 0, w: 100, h: 40 })
    expect(result['b']).toMatchObject({ x: 115, y: 0, w: 100, h: 40 })
    expect(result['c']).toMatchObject({ x: 0, y: 50, w: 100, h: 40 })
    expect(result['d']).toMatchObject({ x: 115, y: 50, w: 100, h: 40 })
  })

  it('网格：不同宽高的图片都不改变原尺寸和比例', () => {
    const parent = withChildren(
      frame(
        'p',
        { layoutMode: 'grid', gridColumns: 2, itemSpacing: 10, primaryAxisSizing: 'hug', counterAxisSizing: 'hug' },
        { w: 0, h: 0 }
      ),
      ['a', 'b', 'c', 'd']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 200, 100, { parentId: 'p' }),
        asset('b', 100, 80, { parentId: 'p' }),
        asset('c', 100, 40, { parentId: 'p' }),
        asset('d', 150, 60, { parentId: 'p' })
      ])
    )

    expect(result['a']).toMatchObject({ x: 0, y: 0, w: 200, h: 100 })
    expect(result['b']).toMatchObject({ x: 210, y: 0, w: 100, h: 80 })
    expect(result['c']).toMatchObject({ x: 0, y: 110, w: 100, h: 40 })
    expect(result['d']).toMatchObject({ x: 210, y: 110, w: 150, h: 60 })
    // 宽高比保持
    expect(result['a']!.w / result['a']!.h).toBeCloseTo(2)
    expect(result['b']!.w / result['b']!.h).toBeCloseTo(1.25)
  })

  it('网格：行高取该行最高的节点', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'grid', gridColumns: 2, itemSpacing: 0 }, { w: 200, h: 100 }),
      ['a', 'b', 'c']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 100, 40, { parentId: 'p' }),
        asset('b', 100, 80, { parentId: 'p' }),
        asset('c', 100, 40, { parentId: 'p' })
      ])
    )
    // 第二行接在第一行最高的 80 之后
    expect(result['c']?.y).toBe(80)
  })

  it('网格：列数超过节点数时不报错', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'grid', gridColumns: 5 }, { w: 200, h: 100 }),
      ['a']
    )
    expect(() => layout(graph(['p'], [parent, asset('a', 50, 40, { parentId: 'p' })]))).not.toThrow()
  })

  it('网格 + hug 高度：由行数撑开', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'grid', gridColumns: 2, itemSpacing: 10, counterAxisSizing: 'hug' }, { w: 220, h: 0 }),
      ['a', 'b', 'c', 'd']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 100, 40, { parentId: 'p' }),
        asset('b', 100, 40, { parentId: 'p' }),
        asset('c', 100, 40, { parentId: 'p' }),
        asset('d', 100, 40, { parentId: 'p' })
      ])
    )
    expect(result['p']?.h).toBe(90)
  })

  it('横向换行：放不下就换到下一行', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', layoutWrap: 'wrap', itemSpacing: 10 }, { w: 220, h: 100 }),
      ['a', 'b', 'c']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 100, 40, { parentId: 'p' }),
        asset('b', 100, 40, { parentId: 'p' }),
        asset('c', 100, 40, { parentId: 'p' })
      ])
    )

    expect(result['a']).toMatchObject({ x: 0, y: 0 })
    expect(result['b']).toMatchObject({ x: 110, y: 0 })
    expect(result['c']).toMatchObject({ x: 0, y: 50 })
  })

  it('换行不加时保持一行', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', layoutWrap: 'nowrap', itemSpacing: 10 }, { w: 220, h: 100 }),
      ['a', 'b']
    )
    const result = layout(
      graph(['p'], [parent, asset('a', 150, 40, { parentId: 'p' }), asset('b', 150, 40, { parentId: 'p' })])
    )
    expect(result['b']?.y).toBe(0)
  })
})

describe('D4b.4 嵌套容器', () => {
  it('内层 hug 容器先撑开，外层再按它排布', () => {
    const outer = withChildren(
      frame('outer', { layoutMode: 'vertical', itemSpacing: 10, primaryAxisSizing: 'hug', counterAxisSizing: 'hug' }, { w: 0, h: 0 }),
      ['inner', 'tail']
    )
    const inner = withChildren(
      frame(
        'inner',
        { layoutMode: 'horizontal', itemSpacing: 5, primaryAxisSizing: 'hug', counterAxisSizing: 'hug', padding: { top: 5, bottom: 5, left: 5, right: 5 } },
        { w: 0, h: 0 }
      ),
      ['x', 'y']
    )

    const result = layout(
      graph(['outer'], [
        outer,
        { ...inner, parentId: 'outer' },
        asset('x', 100, 50, { parentId: 'inner' }),
        asset('y', 100, 50, { parentId: 'inner' }),
        asset('tail', 50, 30, { parentId: 'outer' })
      ])
    )

    // 内层：内容 100+5+100=205，加左右内边距 10 → 215；高 50+10=60
    expect(result['inner']).toMatchObject({ x: 0, y: 0, w: 215, h: 60 })
    expect(result['x']).toMatchObject({ x: 5, y: 5 })
    expect(result['y']).toMatchObject({ x: 110, y: 5 })
    // 外层：内层之下再排 tail（间距 10）
    expect(result['tail']?.y).toBe(70)
  })

  it('父容器移动时子节点整体跟随', () => {
    const outer = withChildren(
      frame('outer', { layoutMode: 'vertical' }, { x: 500, y: 300, w: 200, h: 200 }),
      ['inner']
    )
    const inner = withChildren(
      frame('inner', { layoutMode: 'horizontal' }, { w: 100, h: 50 }),
      ['x']
    )

    const result = layout(
      graph(['outer'], [
        outer,
        { ...inner, parentId: 'outer' },
        asset('x', 30, 20, { parentId: 'inner' })
      ])
    )

    expect(result['inner']).toMatchObject({ x: 500, y: 300 })
    expect(result['x']).toMatchObject({ x: 500, y: 300 })
  })

  it('嵌套里的 grow 只吃自己容器的剩余空间', () => {
    const outer = withChildren(
      frame('outer', { layoutMode: 'vertical' }, { w: 200, h: 300 }),
      ['inner']
    )
    const inner = withChildren(
      frame('inner', { layoutMode: 'horizontal' }, { w: 200, h: 100 }),
      ['x']
    )

    const result = layout(
      graph(['outer'], [
        outer,
        { ...inner, parentId: 'outer' },
        asset('x', 50, 100, { parentId: 'inner', props: { layoutGrow: 1 } })
      ])
    )

    expect(result['x']?.w).toBe(200)
    expect(result['x']?.h).toBe(100)
  })
})

describe('绝对定位的子节点', () => {
  it('不参与流，按自己的坐标摆', () => {
    const parent = withChildren(
      frame('p', { layoutMode: 'horizontal', itemSpacing: 10 }, { w: 300, h: 100 }),
      ['a', 'pin']
    )
    const result = layout(
      graph(['p'], [
        parent,
        asset('a', 100, 50, { parentId: 'p' }),
        asset('pin', 20, 20, { parentId: 'p', x: 200, y: 60, props: { layoutPositioning: 'absolute' } })
      ])
    )

    expect(result['a']).toMatchObject({ x: 0, y: 0 })
    expect(result['pin']).toMatchObject({ x: 200, y: 60 })
  })
})
