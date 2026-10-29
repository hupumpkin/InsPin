import { describe, expect, it } from 'vitest'
import { dimensionsFromImageHeader } from './image-dimensions'

function withPngSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.set([(width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255], 16)
  bytes.set([(height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255], 20)
  return bytes
}

describe('dimensionsFromImageHeader', () => {
  it('在常规解码器失效时，仍能从 PNG 文件头读出竖图比例', () => {
    expect(dimensionsFromImageHeader(withPngSize(600, 900))).toEqual({ width: 600, height: 900 })
  })

  it('读取 WebP VP8X 的画布尺寸', () => {
    const bytes = new Uint8Array(30)
    bytes.set(new TextEncoder().encode('RIFF'), 0)
    bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
    // VP8X 存的是“减一后的 24-bit 小端”尺寸：480 × 720。
    bytes.set([479 & 255, 479 >> 8, 0], 24)
    bytes.set([719 & 255, 719 >> 8, 0], 27)
    expect(dimensionsFromImageHeader(bytes)).toEqual({ width: 480, height: 720 })
  })

  it('读取 AVIF ispe 属性盒中的尺寸', () => {
    const bytes = new Uint8Array(28)
    bytes.set(new TextEncoder().encode('ftypavif'), 4)
    bytes.set(new TextEncoder().encode('ispe'), 8)
    bytes.set([0x00, 0x00, 0x02, 0x58], 16)
    bytes.set([0x00, 0x00, 0x03, 0x84], 20)
    expect(dimensionsFromImageHeader(bytes)).toEqual({ width: 600, height: 900 })
  })

  it('读取 SVG 的 width / height', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"></svg>'
    expect(dimensionsFromImageHeader(new TextEncoder().encode(svg))).toEqual({
      width: 320,
      height: 180
    })
  })

  it('SVG 没有 width / height 时退回 viewBox', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 48"></svg>'
    expect(dimensionsFromImageHeader(new TextEncoder().encode(svg))).toEqual({
      width: 24,
      height: 48
    })
  })

  it('SVG 的百分比尺寸退回 viewBox', () => {
    const svg = '<svg width="100%" height="100%" viewBox="0 0 800 600"></svg>'
    expect(dimensionsFromImageHeader(new TextEncoder().encode(svg))).toEqual({
      width: 800,
      height: 600
    })
  })

  it('不是可识别图片时不猜尺寸', () => {
    expect(dimensionsFromImageHeader(new TextEncoder().encode('not an image'))).toBeNull()
  })
})
