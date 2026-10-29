/** Apple Vision 能处理的位图格式；SVG 是矢量，首版不参与一键抠图。 */
const CUTOUT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/bmp',
  'image/heic',
  'image/heif'
])

export function isCutoutMime(mime: string): boolean {
  return CUTOUT_MIMES.has(mime)
}
