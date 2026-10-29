import { describe, expect, it } from 'vitest'
import { cropFromResize, FULL_CROP, normalizeCrop } from './crop'

describe('crop helpers', () => {
  it('把快捷缩框映射为原图中的裁切区域', () => {
    expect(cropFromResize(FULL_CROP, { x: 100, y: 50, w: 200, h: 100 }, { x: 150, y: 50, w: 100, h: 100 })).toEqual({
      x: 0.25, y: 0, w: 0.5, h: 1
    })
  })

  it('越界数据会被夹回合法的原图范围', () => {
    const crop = normalizeCrop({ x: -1, y: 0.9, w: 2, h: 2 })
    expect(crop.x).toBe(0)
    expect(crop.y + crop.h).toBe(1)
  })
})
