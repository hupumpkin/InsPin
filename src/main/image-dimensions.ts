/**
 * 从图片文件头读取像素尺寸。
 *
 * Electron 的解码器偶尔会对网页拿到的某些低清副本返回空图；这不是理由把竖图
 * 硬塞进固定 4:3 盒子。这里不解码像素，只读取 PNG / JPEG / GIF / WebP 的尺寸字段，
 * 作为导入时的保比例后备。读不出来时返回 null，仍交给原来的可选中兜底盒子。
 */

export interface ImageDimensions {
  width: number
  height: number
}

function valid(width: number, height: number): ImageDimensions | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

function has(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= bytes.length
}

function u16be(bytes: Uint8Array, offset: number): number | null {
  if (!has(bytes, offset, 2)) return null
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u16le(bytes: Uint8Array, offset: number): number | null {
  if (!has(bytes, offset, 2)) return null
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u24le(bytes: Uint8Array, offset: number): number | null {
  if (!has(bytes, offset, 3)) return null
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function u32be(bytes: Uint8Array, offset: number): number | null {
  if (!has(bytes, offset, 4)) return null
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (!has(bytes, offset, length)) return ''
  let out = ''
  for (let index = 0; index < length; index++) out += String.fromCharCode(bytes[offset + index]!)
  return out
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (ascii(bytes, 1, 3) !== 'PNG' || ascii(bytes, 12, 4) !== 'IHDR') return null
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  return width === null || height === null ? null : valid(width, height)
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (ascii(bytes, 0, 6) !== 'GIF87a' && ascii(bytes, 0, 6) !== 'GIF89a') return null
  const width = u16le(bytes, 6)
  const height = u16le(bytes, 8)
  return width === null || height === null ? null : valid(width, height)
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null
    // 独立标记没有段长。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = u16be(bytes, offset)
    if (length === null || length < 2 || !has(bytes, offset, length)) return null
    if (JPEG_SOF.has(marker)) {
      const height = u16be(bytes, offset + 3)
      const width = u16be(bytes, offset + 5)
      return width === null || height === null ? null : valid(width, height)
    }
    offset += length
  }
  return null
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
  const kind = ascii(bytes, 12, 4)
  if (kind === 'VP8X') {
    const width = u24le(bytes, 24)
    const height = u24le(bytes, 27)
    return width === null || height === null ? null : valid(width + 1, height + 1)
  }
  if (kind === 'VP8 ') {
    const width = u16le(bytes, 26)
    const height = u16le(bytes, 28)
    return width === null || height === null ? null : valid(width & 0x3fff, height & 0x3fff)
  }
  if (kind === 'VP8L' && has(bytes, 21, 4) && bytes[20] === 0x2f) {
    const b1 = bytes[21]!
    const b2 = bytes[22]!
    const b3 = bytes[23]!
    const b4 = bytes[24]!
    return valid(1 + (b1 | ((b2 & 0x3f) << 8)), 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)))
  }
  return null
}

/** AVIF 的像素尺寸存放在 ISO BMFF 的 `ispe` 属性盒中。 */
function avifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (ascii(bytes, 4, 4) !== 'ftyp') return null
  for (let offset = 0; offset <= bytes.length - 16; offset++) {
    if (ascii(bytes, offset, 4) !== 'ispe') continue
    const width = u32be(bytes, offset + 8)
    const height = u32be(bytes, offset + 12)
    return width === null || height === null ? null : valid(width, height)
  }
  return null
}

/** 从根 `<svg>` 标签上读一个长度属性（只认 px 或纯数字，百分比交给 viewBox）。 */
function svgLength(tag: string, name: string): number | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i'))
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** SVG 尺寸：先看 width/height，没有再退回 viewBox 的宽高。 */
function svgDimensions(bytes: Uint8Array): ImageDimensions | null {
  const text = new TextDecoder('utf-8').decode(
    bytes.subarray(0, Math.min(bytes.length, 64 * 1024))
  )
  const tag = text.match(/<svg\b[^>]*>/i)?.[0]
  if (!tag) return null

  const width = svgLength(tag, 'width')
  const height = svgLength(tag, 'height')
  if (width !== null && height !== null) return valid(width, height)

  const viewBox = tag.match(
    /viewBox\s*=\s*["']\s*([-0-9.]+)[\s,]+([-0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i
  )
  if (!viewBox) return null
  const viewWidth = Number(viewBox[3])
  const viewHeight = Number(viewBox[4])
  return Number.isFinite(viewWidth) && Number.isFinite(viewHeight)
    ? valid(Math.round(viewWidth), Math.round(viewHeight))
    : null
}

/** 识别到的图片格式才会返回尺寸；格式未知或头不完整时返回 null。 */
export function dimensionsFromImageHeader(bytes: Uint8Array): ImageDimensions | null {
  return (
    pngDimensions(bytes) ??
    gifDimensions(bytes) ??
    jpegDimensions(bytes) ??
    webpDimensions(bytes) ??
    avifDimensions(bytes) ??
    svgDimensions(bytes)
  )
}
