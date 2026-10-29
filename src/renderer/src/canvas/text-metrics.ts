/**
 * 画布文本的字体度量：编辑框（DOM）和落定后的文字（Pixi）必须共用同一套。
 *
 * 行高取字体自己的 ascent + descent，而不是字号——否则浏览器会把字形往
 * 行盒外溢出几个像素，编辑态和落定后的文字就会上下错位、上下留白也不一致。
 */

export const TEXT_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'

let context: CanvasRenderingContext2D | null | undefined
const lineHeights = new Map<number, number>()

function metricsContext(): CanvasRenderingContext2D | null {
  if (context === undefined) context = document.createElement('canvas').getContext('2d')
  return context
}

/**
 * 与 Pixi 的 CanvasTextMetrics 用同一串字符测量（它也用这串算 ascent/descent），
 * 这样编辑框和画布文字拿到的行高是同一个数。
 */
const METRICS_TEXT = '|ÉqÅM'

/** 字号 → 该字体真实的行高（px，整数）。同字号会缓存。 */
export function textLineHeight(fontSize: number): number {
  const cached = lineHeights.get(fontSize)
  if (cached !== undefined) return cached
  const ctx = metricsContext()
  let height = Math.round(fontSize * 1.2)
  if (ctx) {
    ctx.font = `${fontSize}px ${TEXT_FONT_FAMILY}`
    const metrics = ctx.measureText(METRICS_TEXT)
    const ascent = metrics.actualBoundingBoxAscent
    const descent = metrics.actualBoundingBoxDescent
    if (Number.isFinite(ascent) && Number.isFinite(descent)) {
      height = Math.ceil(ascent + descent)
    }
  }
  lineHeights.set(fontSize, height)
  return height
}

/** 单行文字的字宽（px，未取整）。 */
export function measureTextWidth(text: string, fontSize: number): number {
  const ctx = metricsContext()
  if (!ctx) return Array.from(text).length * fontSize
  ctx.font = `${fontSize}px ${TEXT_FONT_FAMILY}`
  return ctx.measureText(text).width
}
