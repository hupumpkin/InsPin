/**
 * 图片格式识别与完整性判断（路线图 D1.6）。
 *
 * 为什么不看 HTTP 的 Content-Type / 文件后缀：两者都可以随便写。
 * 这里直接看**文件头部的特征字节**，并按格式做一次轻量的结构检查，
 * 用来把"不是图片"和"图片坏了"区分开——两者要给用户看的提示完全不同。
 *
 * 纯函数，不依赖 Electron，可直接单测。
 */

export interface ImageFormat {
  mime: string
  ext: string
}

const PNG: ImageFormat = { mime: 'image/png', ext: 'png' }
const JPEG: ImageFormat = { mime: 'image/jpeg', ext: 'jpg' }
const GIF: ImageFormat = { mime: 'image/gif', ext: 'gif' }
const WEBP: ImageFormat = { mime: 'image/webp', ext: 'webp' }
const AVIF: ImageFormat = { mime: 'image/avif', ext: 'avif' }
/** SVG 是文本格式，没有固定文件头，只能看开头的 XML/根元素。 */
const SVG: ImageFormat = { mime: 'image/svg+xml', ext: 'svg' }

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return ''
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!)
  return out
}

function indexOfAscii(bytes: Uint8Array, text: string, from = 0): number {
  const needle = text.split('').map((c) => c.charCodeAt(0))
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** 取开头一段文本，用来判断 SVG（它没有固定二进制头）。 */
function textHead(bytes: Uint8Array, limit = 4096): string {
  return new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, limit)))
}

/**
 * 是否是一份 SVG。
 *
 * 不能简单搜 `<svg`：HTML 页面里也可能嵌 SVG。这里要求**根元素**就是 `<svg>`，
 * 允许前面有 BOM、空白、XML 声明、注释和 DOCTYPE。
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  let text = textHead(bytes)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.trimStart()

  // 逐段跳过 XML 声明 / 注释 / DOCTYPE，再看剩下的根元素。
  // 不能用一个宽松的 `<!DOCTYPE[\s\S]*?>`：非贪婪也会一路吞到 HTML 的 <body>。
  for (let guard = 0; guard < 8; guard += 1) {
    if (text.startsWith('<?')) {
      const end = text.indexOf('?>')
      if (end < 0) return false
      text = text.slice(end + 2).trimStart()
      continue
    }
    if (text.startsWith('<!--')) {
      const end = text.indexOf('-->')
      if (end < 0) return false
      text = text.slice(end + 3).trimStart()
      continue
    }
    if (/^<!DOCTYPE\b/i.test(text)) {
      const end = text.indexOf('>')
      if (end < 0) return false
      text = text.slice(end + 1).trimStart()
      continue
    }
    break
  }

  return /^<svg[\s/>]/i.test(text)
}

/** 认出图片格式；不是已知图片则返回 null。 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return GIF
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return WEBP
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4)
    if (brand === 'avif' || brand === 'avis') return AVIF
  }
  if (looksLikeSvg(bytes)) return SVG
  return null
}

/**
 * 对常见的非图片格式给一个更好懂的判断，用于错误提示。
 * 返回人话描述，认不出来就返回 null。
 */
export function describeNonImage(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'PDF 文档'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return '压缩包或 Office 文档'
  if (startsWith(bytes, [0x1f, 0x8b])) return 'gzip 压缩文件'
  if (startsWith(bytes, [0x4d, 0x5a])) return 'Windows 程序文件'
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return '可执行文件'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WAVE') {
    return '音频文件'
  }
  if (startsWith(bytes, [0x00, 0x00, 0x00]) && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4)
    if (brand.startsWith('qt')) return 'QuickTime 视频'
    if (brand === 'isom' || brand === 'mp42') return '视频文件'
  }
  // 没有控制字符 → 多半是文本（0x80 以上放行，因为 UTF-8 中文就在这个区间）
  const sample = bytes.subarray(0, Math.min(bytes.length, 512))
  if (sample.length > 0) {
    let looksText = true
    for (const byte of sample) {
      const ok = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127) || byte >= 128
      if (!ok) {
        looksText = false
        break
      }
    }
    if (looksText) return '文本文件'
  }
  return null
}

/**
 * 结构完整性检查：明显缺胳膊少腿的图片在这里拦下，避免存进去一张永远显示不出来的图。
 * 只做轻量判断，不做完整解码。
 */
export function looksIntact(bytes: Uint8Array, format: ImageFormat): boolean {
  switch (format.mime) {
    case PNG.mime:
      // 头部声明必须在 12 字节处，末尾必须有 IEND
      return ascii(bytes, 12, 4) === 'IHDR' && indexOfAscii(bytes, 'IEND') !== -1
    case JPEG.mime:
      return bytes.length >= 4 && startsWith(bytes, [0xff, 0xd9], bytes.length - 2)
    case GIF.mime:
      return bytes.length >= 14 && bytes[bytes.length - 1] === 0x3b
    case WEBP.mime: {
      const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        4,
        true
      )
      return bytes.length >= 16 && declared + 8 <= bytes.length
    }
    case SVG.mime: {
      const text = new TextDecoder('utf-8').decode(bytes)
      return /<svg[\s/>]/i.test(text) && (/<\/svg\s*>/i.test(text) || /<svg\b[^>]*\/>/i.test(text))
    }
    default:
      // AVIF 等不做轻量结构检查，认出头就算数
      return true
  }
}
