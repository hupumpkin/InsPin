import { describe, expect, it } from 'vitest'
import { fullEdgeAtZoom1, needsOriginal, needsOriginalAt } from './image-lod'

const FULL = { w: 1, h: 1 }

describe('needsOriginal', () => {
  it('缩小看全局时只用缩略图', () => {
    // 400 × 0.5 × 2 = 400 设备像素，仍在 512 以内
    expect(needsOriginal({ w: 400, h: 300 }, FULL, 0.5, 2)).toBe(false)
  })

  it('放大到撑破缩略图分辨率时加载原图', () => {
    // 400 × 1 × 2 = 800 > 512
    expect(needsOriginal({ w: 400, h: 300 }, FULL, 1, 2)).toBe(true)
  })

  it('按实际设备像素算，非高分屏更晚需要原图', () => {
    expect(needsOriginal({ w: 400, h: 300 }, FULL, 1, 1)).toBe(false)
  })

  it('裁切后可见部分被放大，更早需要原图', () => {
    // 只裁了 25% 的宽度：整张图相当于按 1200 设备像素显示
    expect(needsOriginal({ w: 300, h: 300 }, { w: 0.25, h: 1 }, 1, 2)).toBe(true)
  })

  it('参数异常时宁可加载原图', () => {
    expect(needsOriginal({ w: 100, h: 100 }, FULL, 0, 2)).toBe(true)
    expect(needsOriginal({ w: 100, h: 100 }, FULL, 1, 0)).toBe(true)
    expect(needsOriginal({ w: 100, h: 100 }, { w: 0, h: 0 }, 1, 2)).toBe(true)
  })
})

describe('fullEdgeAtZoom1 / needsOriginalAt', () => {
  it('把裁切换算成整张图的显示长边', () => {
    expect(fullEdgeAtZoom1({ w: 300, h: 300 }, { w: 0.25, h: 0.5 })).toBe(1200)
  })

  it('阈值边界：等于缩略图上限时仍算够用', () => {
    expect(needsOriginalAt(512, 1, 1)).toBe(false)
    expect(needsOriginalAt(513, 1, 1)).toBe(true)
  })
})
