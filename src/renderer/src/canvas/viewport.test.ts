import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  boxContains,
  clampZoom,
  expandBox,
  fitViewport,
  panFromWheel,
  panDeltasFromWheel,
  resetZoom,
  snapZoomToPreset,
  toScreen,
  toWorld,
  zoomAt,
  zoomByStep,
  zoomFromWheel,
  zoomPercent
} from './viewport'

const view = (x: number, y: number, zoom: number) => ({ x, y, zoom })

describe('clampZoom', () => {
  it('夹在上下限之间', () => {
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
    expect(clampZoom(2)).toBe(2)
  })

  it('非法值时回到 1', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('toScreen / toWorld', () => {
  it('互为逆运算', () => {
    const v = view(30, -20, 1.5)
    const world = { x: 120, y: 80 }
    const back = toWorld(v, toScreen(v, world))
    expect(back.x).toBeCloseTo(world.x)
    expect(back.y).toBeCloseTo(world.y)
  })
})

describe('zoomAt', () => {
  it('锚点下的世界坐标保持不动', () => {
    const v = view(0, 0, 1)
    const anchor = { x: 400, y: 300 }
    const worldBefore = toWorld(v, anchor)

    const next = zoomAt(v, 2, anchor)
    const worldAfter = toWorld(next, anchor)

    expect(worldAfter.x).toBeCloseTo(worldBefore.x)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y)
  })

  it('缩放倍率被夹住', () => {
    expect(zoomAt(view(0, 0, 1), 999, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM)
  })
})

describe('zoomFromWheel', () => {
  it('向上滚放大、向下滚缩小', () => {
    expect(zoomFromWheel(1, -100)).toBeGreaterThan(1)
    expect(zoomFromWheel(1, 100)).toBeLessThan(1)
  })

  it('不会超出上下限', () => {
    expect(zoomFromWheel(1, 100000)).toBe(MIN_ZOOM)
    expect(zoomFromWheel(1, -100000)).toBe(MAX_ZOOM)
  })

  it('连续缩放比旧曲线更灵敏', () => {
    expect(zoomFromWheel(1, -100)).toBeGreaterThan(1.3)
  })

  it('接近 50%、100%、200% 时轻微吸附', () => {
    expect(snapZoomToPreset(0.51)).toBe(0.5)
    expect(snapZoomToPreset(0.99)).toBe(1)
    expect(snapZoomToPreset(2.04)).toBe(2)
    expect(snapZoomToPreset(1.04)).toBe(1.04)
  })
})

describe('zoomByStep', () => {
  it('放大一步再缩小一步回到原处', () => {
    const size = { w: 800, h: 600 }
    const start = view(10, 20, 1)
    const zoomedIn = zoomByStep(start, size, 1)
    const back = zoomByStep(zoomedIn, size, -1)

    expect(back.zoom).toBeCloseTo(1)
    expect(back.x).toBeCloseTo(start.x)
    expect(back.y).toBeCloseTo(start.y)
  })

  it('沿用 Figma 的 50% → 100% → 200% 倍率档位', () => {
    const size = { w: 800, h: 600 }
    expect(zoomByStep(view(0, 0, 0.5), size, 1).zoom).toBe(1)
    expect(zoomByStep(view(0, 0, 1), size, 1).zoom).toBe(2)
  })
})

describe('panFromWheel', () => {
  it('无修饰键的滚动平移视口，不改变缩放', () => {
    expect(panFromWheel(view(120, 80, 1.5), 24, -40)).toEqual({ x: 96, y: 120, zoom: 1.5 })
  })
})

describe('panDeltasFromWheel', () => {
  it('普通滚轮保留横纵方向，Shift + 滚轮转换为横移', () => {
    expect(panDeltasFromWheel(12, 48, false)).toEqual({ x: 12, y: 48 })
    expect(panDeltasFromWheel(0, 48, true)).toEqual({ x: 48, y: 0 })
    expect(panDeltasFromWheel(12, 48, true)).toEqual({ x: 12, y: 0 })
  })
})

describe('resetZoom', () => {
  it('回到 100% 且锚在中心', () => {
    const size = { w: 800, h: 600 }
    const result = resetZoom(view(-500, -300, 3), size)
    expect(result.zoom).toBe(1)
    // 中心点对应的世界坐标前后一致
    const before = toWorld(view(-500, -300, 3), { x: 400, y: 300 })
    const after = toWorld(result, { x: 400, y: 300 })
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })
})

describe('fitViewport', () => {
  it('把内容居中装进视口', () => {
    const result = fitViewport({ x: 100, y: 100, w: 400, h: 200 }, { w: 1000, h: 800 }, 50)
    // 400x200 装进 900x700 → 受宽度限制 900/400 = 2.25
    expect(result.zoom).toBeCloseTo(2.25)
    // 内容中心落在视口中心
    const center = toScreen(result, { x: 300, y: 200 })
    expect(center.x).toBeCloseTo(500)
    expect(center.y).toBeCloseTo(400)
  })

  it('内容为空时回到原点 100%', () => {
    expect(fitViewport(null, { w: 800, h: 600 })).toEqual({ x: 400, y: 300, zoom: 1 })
    expect(fitViewport({ x: 0, y: 0, w: 0, h: 0 }, { w: 800, h: 600 }).zoom).toBe(1)
  })
})

describe('zoomPercent', () => {
  it('四舍五入显示', () => {
    expect(zoomPercent(1)).toBe(100)
    expect(zoomPercent(0.3333)).toBe(33)
    expect(zoomPercent(1.5)).toBe(150)
  })
})

describe('expandBox / boxContains', () => {
  const box = { x: 100, y: 200, w: 400, h: 300 }

  it('四周各扩 factor 倍', () => {
    // 400x300 各扩一半 → 每边多 200 / 150
    expect(expandBox(box, 0.5)).toEqual({ x: -100, y: 50, w: 800, h: 600 })
    expect(expandBox(box, 0)).toEqual(box)
  })

  it('放大后的框一定包住原框，反过来不成立', () => {
    const grown = expandBox(box, 0.75)
    expect(boxContains(grown, box)).toBe(true)
    expect(boxContains(box, grown)).toBe(false)
  })

  it('平移出界就不算包含', () => {
    const grown = expandBox(box, 0)
    expect(boxContains(grown, { ...box, x: 101 })).toBe(false)
    // 贴着边、刚好装下算包含
    expect(boxContains(grown, { x: 100, y: 200, w: 400, h: 300 })).toBe(true)
    expect(boxContains(grown, { x: 100, y: 200, w: 400.5, h: 300 })).toBe(false)
  })
})
