import { describe, expect, it } from 'vitest'
import {
  createAssetNode,
  createFrameNode,
  createGroupNode,
  defaultAutoLayoutProps,
  defaultChildLayoutProps
} from './node'

const BASE = { id: 'n1', projectId: 'p1', name: '测试节点' }

describe('默认值', () => {
  it('子节点布局字段的默认值', () => {
    expect(defaultChildLayoutProps()).toEqual({
      layoutAlign: 'inherit',
      layoutGrow: 0,
      layoutPositioning: 'auto'
    })
  })

  it('自动布局字段的默认值是"不布局"', () => {
    expect(defaultAutoLayoutProps()).toEqual({
      layoutMode: 'none',
      itemSpacing: 0,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      primaryAxisAlignItems: 'start',
      counterAxisAlignItems: 'start',
      primaryAxisSizing: 'fixed',
      counterAxisSizing: 'fixed',
      layoutWrap: 'nowrap',
      gridColumns: 1,
      clipsContent: false
    })
  })

  it('默认 padding 每次都是新对象，节点之间不共享', () => {
    const a = createFrameNode({ ...BASE, id: 'a' })
    const b = createFrameNode({ ...BASE, id: 'b' })
    a.props.padding.top = 99
    expect(b.props.padding.top).toBe(0)
  })
})

describe('createAssetNode', () => {
  it('带上通用默认值', () => {
    const node = createAssetNode({ ...BASE, assetId: 'a1', naturalWidth: 800, naturalHeight: 600 })
    expect(node.type).toBe('asset')
    expect(node.childIds).toEqual([])
    expect(node.parentId).toBeNull()
    expect(node.visible).toBe(true)
    expect(node.locked).toBe(false)
    expect(node.rotation).toBe(0)
    expect(node.x).toBe(0)
    expect(node.y).toBe(0)
    expect(node.props.assetId).toBe('a1')
    expect(node.props.naturalWidth).toBe(800)
    expect(node.props.layoutAlign).toBe('inherit')
  })

  it('可以覆盖位置尺寸与布局字段', () => {
    const node = createAssetNode({
      ...BASE,
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      parentId: 'p',
      assetId: 'a1',
      naturalWidth: 800,
      naturalHeight: 600,
      props: { layoutAlign: 'stretch', layoutGrow: 1 }
    })
    expect(node).toMatchObject({ x: 10, y: 20, w: 100, h: 50, parentId: 'p' })
    expect(node.props.layoutAlign).toBe('stretch')
    expect(node.props.layoutGrow).toBe(1)
    expect(node.props.layoutPositioning).toBe('auto')
  })
})

describe('createGroupNode', () => {
  it('只有包围盒与子节点布局字段', () => {
    const node = createGroupNode({ ...BASE, w: 300, h: 200 })
    expect(node.type).toBe('group')
    expect(Object.keys(node.props).sort()).toEqual(['layoutAlign', 'layoutGrow', 'layoutPositioning'])
  })
})

describe('createFrameNode', () => {
  it('默认不布局，可只覆盖部分字段', () => {
    const node = createFrameNode({ ...BASE, props: { layoutMode: 'horizontal', itemSpacing: 16 } })
    expect(node.type).toBe('frame')
    expect(node.props.layoutMode).toBe('horizontal')
    expect(node.props.itemSpacing).toBe(16)
    // 没提到的保持默认
    expect(node.props.primaryAxisSizing).toBe('fixed')
    expect(node.props.gridColumns).toBe(1)
  })

  it('padding 支持只覆盖一条边', () => {
    const node = createFrameNode({ ...BASE, props: { padding: { left: 12 } } })
    expect(node.props.padding).toEqual({ top: 0, right: 0, bottom: 0, left: 12 })
  })
})
