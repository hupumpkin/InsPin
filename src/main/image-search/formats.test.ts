import { describe, expect, it } from 'vitest'
import { needsClipboardPngConversion } from './formats'

describe('以图搜图剪贴板格式', () => {
  it('PNG 可直接声明为 image/png', () => {
    expect(needsClipboardPngConversion('/tmp/image.png')).toBe(false)
    expect(needsClipboardPngConversion('/tmp/image.PNG')).toBe(false)
  })

  it('JPEG 与其他格式必须先转换成 PNG，不能只改 MIME', () => {
    expect(needsClipboardPngConversion('/tmp/image.jpg')).toBe(true)
    expect(needsClipboardPngConversion('/tmp/image.jpeg')).toBe(true)
    expect(needsClipboardPngConversion('/tmp/image.webp')).toBe(true)
  })
})
