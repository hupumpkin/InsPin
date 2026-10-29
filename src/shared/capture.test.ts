import { describe, expect, it } from 'vitest'
import { isUsableCrop, toImageCrop } from './capture'

const IMAGE = { width: 2000, height: 1000 }
const BOX = { width: 1000, height: 500 } // Retina 2x
const ORIGIN = { x: 100, y: 200 } // 截取区在窗口里的左上角

describe('toImageCrop', () => {
  it('按倍率把 CSS 像素换算成图像素', () => {
    // 窗口坐标里从截取区左上角往右下 100×50 → 图像素里是 200×100
    expect(toImageCrop({ x: 100, y: 200, width: 100, height: 50 }, ORIGIN, IMAGE, BOX)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100
    })
  })

  it('不在原点起手也算得对', () => {
    expect(toImageCrop({ x: 300, y: 300, width: 200, height: 100 }, ORIGIN, IMAGE, BOX)).toEqual({
      x: 400,
      y: 200,
      width: 400,
      height: 200
    })
  })

  it('拖出图片边界就夹回去，不会裁出黑边', () => {
    const crop = toImageCrop({ x: 0, y: 0, width: 5000, height: 5000 }, ORIGIN, IMAGE, BOX)
    expect(crop.x).toBe(0)
    expect(crop.y).toBe(0)
    expect(crop.width).toBeLessThanOrEqual(IMAGE.width)
    expect(crop.height).toBeLessThanOrEqual(IMAGE.height)
    expect(crop.x + crop.width).toBeLessThanOrEqual(IMAGE.width)
    expect(crop.y + crop.height).toBeLessThanOrEqual(IMAGE.height)
  })

  it('反向拖（从右下拖到左上）也能得到正的矩形', () => {
    // 窗口 (400,400) → (200,300)，换算成图像素是 (600,400) → (200,200)
    const crop = toImageCrop({ x: 400, y: 400, width: -200, height: -100 }, ORIGIN, IMAGE, BOX)
    expect(crop).toEqual({ x: 200, y: 200, width: 400, height: 200 })
  })

  it('尺寸不合法时给空矩形，不抛异常', () => {
    expect(toImageCrop({ x: 0, y: 0, width: 10, height: 10 }, ORIGIN, { width: 0, height: 0 }, BOX)).toEqual(
      { x: 0, y: 0, width: 0, height: 0 }
    )
    expect(toImageCrop({ x: 0, y: 0, width: 10, height: 10 }, ORIGIN, IMAGE, { width: 0, height: 0 })).toEqual(
      { x: 0, y: 0, width: 0, height: 0 }
    )
  })
})

describe('isUsableCrop', () => {
  it('太小的一律不算（手抖一下的 1×1 没有意义）', () => {
    expect(isUsableCrop({ x: 0, y: 0, width: 7, height: 100 })).toBe(false)
    expect(isUsableCrop({ x: 0, y: 0, width: 100, height: 7 })).toBe(false)
    expect(isUsableCrop({ x: 0, y: 0, width: 8, height: 8 })).toBe(true)
  })
})
