import { describe, expect, it } from 'vitest'
import { createAssetNode, createFrameNode, type Node, type ProjectGraph } from './node'
import {
  autoLayoutPresetFor,
  defaultAutoLayoutPreset,
  flowChildIds,
  gridColumnsFor,
  gridColumnsForRows,
  gridRowsFor,
  insertionIndex,
  isAutoLayoutContainer
} from './auto-layout'

describe('默认参数', () => {
  it('横向预设：间距与内边距 16、贴合内容', () => {
    const preset = defaultAutoLayoutPreset('horizontal')
    expect(preset.layoutMode).toBe('horizontal')
    expect(preset.itemSpacing).toBe(16)
    expect(preset.padding).toEqual({ top: 16, right: 16, bottom: 16, left: 16 })
    expect(preset.primaryAxisSizing).toBe('hug')
    expect(preset.counterAxisSizing).toBe('hug')
  })

  it('网格预设：宽高都贴合内容，图片保持原尺寸', () => {
    const preset = defaultAutoLayoutPreset('grid')
    expect(preset.primaryAxisSizing).toBe('hug')
    expect(preset.counterAxisSizing).toBe('hug')
  })

  it('列数按数量的平方根取整', () => {
    expect(gridColumnsFor(1)).toBe(1)
    expect(gridColumnsFor(2)).toBe(2)
    expect(gridColumnsFor(4)).toBe(2)
    expect(gridColumnsFor(5)).toBe(3)
    expect(gridColumnsFor(9)).toBe(3)
  })

  it('网格模式带上算好的列数', () => {
    expect(autoLayoutPresetFor('grid', 9).gridColumns).toBe(3)
    expect(autoLayoutPresetFor('horizontal', 9).layoutMode).toBe('horizontal')
  })

  it('工具条的“横排数量”按当前列数换算', () => {
    expect(gridRowsFor(7, 4)).toBe(2)
    expect(gridRowsFor(6, 3)).toBe(2)
    expect(gridRowsFor(9, 3)).toBe(3)
    expect(gridRowsFor(1, 1)).toBe(1)
  })

  it('用户改横排数量时反推列数', () => {
    expect(gridColumnsForRows(7, 2)).toBe(4)
    expect(gridColumnsForRows(6, 2)).toBe(3)
    expect(gridColumnsForRows(9, 3)).toBe(3)
    expect(gridColumnsForRows(9, 2)).toBe(5)
  })
})

describe('insertionIndex', () => {
  const boxes = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 110, y: 0, w: 100, h: 100 },
    { x: 220, y: 0, w: 100, h: 100 }
  ]

  it('横向：落在谁左半边就插在谁前面', () => {
    expect(insertionIndex('horizontal', boxes, { x: -10, y: 50 })).toBe(0)
    expect(insertionIndex('horizontal', boxes, { x: 40, y: 50 })).toBe(0)
    expect(insertionIndex('horizontal', boxes, { x: 60, y: 50 })).toBe(1)
    expect(insertionIndex('horizontal', boxes, { x: 214, y: 50 })).toBe(2)
    expect(insertionIndex('horizontal', boxes, { x: 999, y: 50 })).toBe(3)
  })

  it('纵向：按 y 比', () => {
    const column = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 110, w: 100, h: 100 }
    ]
    expect(insertionIndex('vertical', column, { x: 50, y: 40 })).toBe(0)
    expect(insertionIndex('vertical', column, { x: 50, y: 150 })).toBe(1)
    expect(insertionIndex('vertical', column, { x: 50, y: 400 })).toBe(2)
  })

  it('空容器插到 0', () => {
    expect(insertionIndex('horizontal', [], { x: 5, y: 5 })).toBe(0)
  })

  it('网格：按行优先判断', () => {
    // 2 列 2 行
    const grid = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 110, y: 0, w: 100, h: 100 },
      { x: 0, y: 110, w: 100, h: 100 },
      { x: 110, y: 110, w: 100, h: 100 }
    ]
    expect(insertionIndex('grid', grid, { x: 10, y: 10 })).toBe(0)
    expect(insertionIndex('grid', grid, { x: 160, y: 10 })).toBe(2)
    expect(insertionIndex('grid', grid, { x: 10, y: 160 })).toBe(2)
    expect(insertionIndex('grid', grid, { x: 900, y: 900 })).toBe(4)
  })
})

describe('容器判断', () => {
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
  const frame = (id: string, mode: 'none' | 'horizontal' | 'vertical', childIds: string[]): Node =>
    ({
      ...createFrameNode({ id, projectId: 'p', name: id, props: { layoutMode: mode } }),
      childIds
    }) as Node

  it('带布局的 frame 才算容器', () => {
    expect(isAutoLayoutContainer(frame('f', 'horizontal', []))).toBe(true)
    expect(isAutoLayoutContainer(frame('f', 'none', []))).toBe(false)
    expect(isAutoLayoutContainer(asset('a'))).toBe(false)
    expect(isAutoLayoutContainer(null)).toBe(false)
  })

  it('流里的子节点排除绝对定位的', () => {
    const graph: ProjectGraph = {
      projectId: 'p',
      rootIds: ['f'],
      nodes: {
        f: frame('f', 'horizontal', ['a', 'b']),
        a: asset('a'),
        b: {
          ...asset('b'),
          props: { ...asset('b').props, layoutPositioning: 'absolute' }
        } as Node
      }
    }
    expect(flowChildIds(graph, 'f')).toEqual(['a'])
  })
})
