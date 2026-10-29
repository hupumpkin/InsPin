import { describe, expect, it } from 'vitest'
import { snapBoxes, snapResizeBox } from './snapping'

const others = [
  { x: 200, y: 0, w: 100, h: 100 },
  { x: 0, y: 300, w: 100, h: 100 }
]

describe('snapBoxes', () => {
  it('没有其它盒子时不吸附', () => {
    expect(snapBoxes({ x: 0, y: 0, w: 10, h: 10 }, [], 6)).toEqual({
      dx: 0,
      dy: 0,
      guides: []
    })
  })

  it('左边缘靠近别人的左边缘时吸过去', () => {
    // 被拖盒子左边在 203，别人左边在 200 → 差 3，在阈值内
    const result = snapBoxes({ x: 203, y: 500, w: 50, h: 50 }, others, 6)
    expect(result.dx).toBe(-3)
    expect(result.guides.some((g) => g.axis === 'x' && g.position === 200)).toBe(true)
  })

  it('中线也能吸（居中对齐）', () => {
    // 别人第一个盒子中轴 x = 250；被拖盒子中心在 248 → 差 2
    const result = snapBoxes({ x: 223, y: 500, w: 50, h: 50 }, others, 6)
    expect(result.dx).toBe(2)
  })

  it('超出阈值就不吸', () => {
    // 最近的一组是"中心 240 vs 250"，差 10 > 6
    const result = snapBoxes({ x: 215, y: 500, w: 50, h: 50 }, others, 6)
    expect(result.dx).toBe(0)
    expect(result.guides).toEqual([])
  })

  it('横纵各自独立', () => {
    // 左边差 3（横轴吸），上边差 2（纵轴吸）
    const result = snapBoxes({ x: 203, y: 298, w: 50, h: 50 }, others, 6)
    expect(result.dx).toBe(-3)
    expect(result.dy).toBe(2)
    expect(result.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('参考线只盖住双方，不铺满整块画布', () => {
    const result = snapBoxes({ x: 203, y: 490, w: 50, h: 50 }, others, 6)
    const guide = result.guides.find((g) => g.axis === 'x')
    // 被拖盒子 y 490..540，被对齐的盒子 y 0..100 → 参考线 0..540
    expect(guide).toMatchObject({ start: 0, end: 540 })
  })

  it('多个候选时取最近的那个', () => {
    // 被拖盒子右边在 297，别人的右边在 300（差 3）——比"左边 200 差 97"近得多
    const result = snapBoxes({ x: 247, y: 500, w: 50, h: 50 }, others, 6)
    expect(result.dx).toBe(3)
  })

  it('阈值为 0 等于不吸附', () => {
    expect(snapBoxes({ x: 203, y: 0, w: 50, h: 50 }, others, 0).dx).toBe(0)
  })
})

describe('snapResizeBox', () => {
  it('没有其它盒子时不吸附', () => {
    const moving = { x: 0, y: 0, w: 100, h: 100 }
    expect(snapResizeBox(moving, { right: true }, [], 6)).toEqual({ rect: moving, guides: [] })
  })

  it('拖右边时只吸右边，左边纹丝不动', () => {
    // 右边缘在 203，别人的左边在 200 → 差 3
    const result = snapResizeBox({ x: 0, y: 500, w: 203, h: 50 }, { right: true }, others, 6)
    expect(result.rect.x).toBe(0)
    expect(result.rect.w).toBe(200)
    expect(result.guides.some((g) => g.axis === 'x' && g.position === 200)).toBe(true)
  })

  it('拖左边时左边缘贴过去，右边缘（锚点）保持不动', () => {
    // 左边缘在 203，别人的左边在 200 → 吸过去后右边仍是原来的 300
    const result = snapResizeBox({ x: 203, y: 500, w: 97, h: 50 }, { left: true }, others, 6)
    expect(result.rect.x).toBe(200)
    expect(result.rect.w).toBe(100)
    expect(result.rect.x + result.rect.w).toBe(300)
  })

  it('拖角落时横纵各自独立吸附', () => {
    // 右边差 3（→200），下边差 2（→同 300 那条的顶部对齐到它的下边）
    const result = snapResizeBox({ x: 0, y: 0, w: 203, h: 398 }, { right: true, bottom: true }, others, 6)
    expect(result.rect.w).toBe(200)
    expect(result.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('没在拖的边不参与吸附', () => {
    // 左边缘 203 本来能吸到 200，但这次拖的是右边 → 不该动
    const result = snapResizeBox({ x: 203, y: 500, w: 297, h: 50 }, { right: true }, others, 6)
    expect(result.rect.x).toBe(203)
  })

  it('超出阈值就不吸', () => {
    const result = snapResizeBox({ x: 0, y: 500, w: 210, h: 50 }, { right: true }, others, 6)
    expect(result.rect.w).toBe(210)
    expect(result.guides).toEqual([])
  })

  it('参考线只盖住双方，不铺满整块画布', () => {
    const result = snapResizeBox({ x: 0, y: 490, w: 203, h: 50 }, { right: true }, others, 6)
    const guide = result.guides.find((g) => g.axis === 'x')
    // 被缩放的盒子 y 490..540，被对齐的盒子 y 0..100 → 参考线 0..540
    expect(guide).toMatchObject({ start: 0, end: 540 })
  })
})
