import { describe, expect, it } from 'vitest'
import { describeNonImage, looksIntact, sniffImageFormat } from './mime'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/** 最小的结构完整 PNG：签名 + IHDR + IEND */
function png(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
    0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82
  ])
}

const jpeg = (): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9])

const gif = (): Uint8Array =>
  Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x3b
  ])

/** 长度 16、RIFF 声明大小 8（= 文件长度 - 8），结构自洽 */
const webp = (): Uint8Array =>
  Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
  ])

const avif = (): Uint8Array =>
  Uint8Array.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])

const svg = (): Uint8Array =>
  text(
    '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24"/></svg>'
  )

describe('sniffImageFormat', () => {
  it('认得出四种常用格式', () => {
    expect(sniffImageFormat(png())).toEqual({ mime: 'image/png', ext: 'png' })
    expect(sniffImageFormat(jpeg())).toEqual({ mime: 'image/jpeg', ext: 'jpg' })
    expect(sniffImageFormat(gif())).toEqual({ mime: 'image/gif', ext: 'gif' })
    expect(sniffImageFormat(webp())).toEqual({ mime: 'image/webp', ext: 'webp' })
    expect(sniffImageFormat(avif())).toEqual({ mime: 'image/avif', ext: 'avif' })
    expect(sniffImageFormat(svg())).toEqual({ mime: 'image/svg+xml', ext: 'svg' })
  })

  it('不把嵌了 SVG 的 HTML 页面当成 SVG', () => {
    expect(
      sniffImageFormat(text('<!DOCTYPE html><html><body><svg></svg></body></html>'))
    ).toBeNull()
  })

  it('非图片返回 null', () => {
    expect(sniffImageFormat(text('hello world'))).toBeNull()
    expect(sniffImageFormat(text('%PDF-1.7'))).toBeNull()
    expect(sniffImageFormat(bytes())).toBeNull()
  })

  it('只看文件头，改名骗不过去', () => {
    // 一个文本文件，即使叫 .png 也认不出来
    expect(sniffImageFormat(text('not really a png at all'))).toBeNull()
  })
})

describe('describeNonImage', () => {
  it('能给常见格式一个人话描述', () => {
    expect(describeNonImage(text('%PDF-1.7'))).toBe('PDF 文档')
    expect(describeNonImage(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe('压缩包或 Office 文档')
    expect(describeNonImage(text('这是一段中文文本'))).toBe('文本文件')
  })

  it('认不出来时返回 null', () => {
    expect(describeNonImage(bytes(0x01, 0x02, 0x03, 0x99, 0xfe))).toBeNull()
  })
})

describe('looksIntact', () => {
  it('结构完整的图片通过', () => {
    expect(looksIntact(png(), { mime: 'image/png', ext: 'png' })).toBe(true)
    expect(looksIntact(jpeg(), { mime: 'image/jpeg', ext: 'jpg' })).toBe(true)
    expect(looksIntact(gif(), { mime: 'image/gif', ext: 'gif' })).toBe(true)
    expect(looksIntact(webp(), { mime: 'image/webp', ext: 'webp' })).toBe(true)
    expect(looksIntact(svg(), { mime: 'image/svg+xml', ext: 'svg' })).toBe(true)
    expect(
      looksIntact(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        mime: 'image/svg+xml',
        ext: 'svg'
      })
    ).toBe(true)
  })

  it('SVG 缺结束标签判为损坏', () => {
    expect(
      looksIntact(text('<svg xmlns="http://www.w3.org/2000/svg"><rect/>'), {
        mime: 'image/svg+xml',
        ext: 'svg'
      })
    ).toBe(false)
  })

  it('PNG 缺 IEND 判为损坏', () => {
    const truncated = png().subarray(0, 33)
    expect(looksIntact(truncated, { mime: 'image/png', ext: 'png' })).toBe(false)
  })

  it('JPEG 结尾不是 FFD9 判为损坏', () => {
    const truncated = jpeg().subarray(0, jpeg().length - 1)
    expect(looksIntact(truncated, { mime: 'image/jpeg', ext: 'jpg' })).toBe(false)
  })

  it('GIF 缺结尾标记判为损坏', () => {
    const truncated = gif().subarray(0, gif().length - 1)
    expect(looksIntact(truncated, { mime: 'image/gif', ext: 'gif' })).toBe(false)
  })

  it('WebP 声明长度大于实际长度判为损坏', () => {
    const broken = webp()
    broken[4] = 0xff
    broken[5] = 0xff
    expect(looksIntact(broken, { mime: 'image/webp', ext: 'webp' })).toBe(false)
  })
})
