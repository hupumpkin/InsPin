import { describe, expect, it } from 'vitest'
import { alignBoxes } from './alignment'

const boxes = new Map([
  ['a', { x: 10, y: 20, w: 40, h: 20 }],
  ['b', { x: 100, y: 80, w: 20, h: 40 }],
  ['c', { x: 180, y: 60, w: 60, h: 20 }]
])

describe('alignBoxes', () => {
  it('按共同包围盒的边缘和中心对齐', () => {
    expect(alignBoxes(boxes, 'left')).toEqual([
      { id: 'a', x: 10, y: 20 }, { id: 'b', x: 10, y: 80 }, { id: 'c', x: 10, y: 60 }
    ])
    expect(alignBoxes(boxes, 'center-y')).toEqual([
      { id: 'a', x: 10, y: 60 }, { id: 'b', x: 100, y: 50 }, { id: 'c', x: 180, y: 60 }
    ])
  })

  it('等距分布固定首尾，只移动中间对象', () => {
    expect(alignBoxes(boxes, 'distribute-x')).toEqual([
      { id: 'a', x: 10, y: 20 }, { id: 'b', x: 105, y: 80 }, { id: 'c', x: 180, y: 60 }
    ])
  })

  it('两个对象不提供等距分布', () => {
    expect(alignBoxes(new Map([...boxes].slice(0, 2)), 'distribute-x')).toEqual([])
  })
})
