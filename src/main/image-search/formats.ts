import { extname } from 'node:path'

/** ClipboardItem 声明 image/png 时，字节也必须确实是 PNG。 */
export function needsClipboardPngConversion(filePath: string): boolean {
  return extname(filePath).toLowerCase() !== '.png'
}
