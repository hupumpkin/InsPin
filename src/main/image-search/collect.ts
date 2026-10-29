import type { ImportResult } from '../../shared/ipc'
import type { ImageSearchCollectLayout } from '../../shared/image-search'
import { finishImport, type CanvasIpcDeps } from '../canvas-ipc'
import { LogEvent } from '../logger'
import { importResolvedImage, resolveWebImage } from '../web-import'

/** 页面里最多先扫多少个候选，最终收多少由设置决定（1–50）。 */
export const MAX_SCAN_RESULTS = 100
/** 新图之间的间距。 */
export const RESULT_GAP = 16
/** 小于这个边长的元素按图标 / 装饰处理。 */
export const MIN_RESULT_SIDE = 160
/** 并发下载上限：再高容易触发图床限流，收益也被网络带宽吃平。 */
const DOWNLOAD_CONCURRENCY = 4

/**
 * 结果页上"看得到、够大"的图片地址。
 *
 * 不走智能采集的候选框：Google 结果页的候选识别是 0（图片在自定义元素 / 背景图里），
 * 所以这里直接扫 `<img>` 与 `background-image`，并递归进 shadow DOM。
 */
export const VISIBLE_IMAGES_SCRIPT = `(() => {
  const MIN = ${MIN_RESULT_SIDE}
  const MAX = ${MAX_SCAN_RESULTS}
  const out = []
  const seen = new Set()
  const viewport = { w: Math.max(1, innerWidth), h: Math.max(1, innerHeight) }
  const visible = (rect) =>
    rect.width >= MIN &&
    rect.height >= MIN &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewport.h &&
    rect.left < viewport.w
  const push = (url, width, height) => {
    if (!url || seen.has(url)) return
    if (!/^https?:\\/\\//i.test(url)) return
    if (width && width < MIN) return
    if (height && height < MIN) return
    seen.add(url)
    out.push(url)
  }
  // 一次遍历同时处理图片和背景图：元素只量一次尺寸，图片也不再白算一遍样式
  const walk = (root) => {
    const all = root.querySelectorAll('*')
    for (const element of all) {
      if (out.length >= MAX) return
      if (element.shadowRoot) walk(element.shadowRoot)
      const rect = element.getBoundingClientRect()
      if (!visible(rect)) continue
      if (element.tagName === 'IMG') {
        push(element.currentSrc || element.src, element.naturalWidth, element.naturalHeight)
        continue
      }
      const background = getComputedStyle(element).backgroundImage
      if (!background || background === 'none' || !background.includes('url(')) continue
      const match = /url\\((['"]?)(.*?)\\1\\)/.exec(background)
      if (match && match[2]) push(match[2], rect.width, rect.height)
    }
  }
  walk(document)
  return out
})()`

type CollectDeps = Pick<
  CanvasIpcDeps,
  'db' | 'assetsDir' | 'measure' | 'fetchImpl' | 'thumbnails' | 'logger'
>

/** 把当前视口里的大图并发取回，再按原顺序入库排版，最后一次性把画布交回界面。 */
export async function collectVisibleImages(
  deps: CollectDeps,
  projectId: string,
  webContents: Electron.WebContents,
  options: { limit: number; layout: ImageSearchCollectLayout }
): Promise<ImportResult> {
  const startedAt = Date.now()
  const pageUrl = webContents.getURL()
  let urls: string[] = []
  try {
    urls = (await webContents.executeJavaScript(VISIBLE_IMAGES_SCRIPT)) as string[]
  } catch {
    return { ok: false, message: '这个页面暂时读不到图片，换一个站点试试' }
  }
  const scanMs = Date.now() - startedAt
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, message: '当前视野里没有可收下的图片，先把结果滚到能看到的位置' }
  }

  const imported: Parameters<typeof finishImport>[2]['imported'] = []
  const errors: Parameters<typeof finishImport>[2]['errors'] = []
  const limit = Math.min(50, Math.max(1, Math.round(options.limit)))
  const { x: startX, y: startY, maxWidth } = options.layout

  // 下载是最慢的一段：先并发取回来，再按原顺序逐张落库、排版
  const downloadStartedAt = Date.now()
  const downloads = await mapLimit(urls.slice(0, limit), DOWNLOAD_CONCURRENCY, (url) =>
    resolveWebImage(deps, projectId, { payload: { textPlain: url }, pageUrl, position: null })
  )
  const downloadMs = Date.now() - downloadStartedAt
  const importStartedAt = Date.now()

  // 按实际显示尺寸逐张排布，保证相邻两张至少留 16px；排满一行再换行
  let cursorX = startX
  let cursorY = startY
  let rowHeight = 0

  for (const download of downloads) {
    if (!download.image) {
      errors.push(...download.errors)
      continue
    }
    const outcome = await importResolvedImage(deps, projectId, download.image, {
      importMethod: 'collect',
      at: { x: cursorX, y: cursorY }
    })
    imported.push(...outcome.imported)
    errors.push(...outcome.errors)
    const node = outcome.imported[0]?.node
    if (!node) continue
    cursorX += node.w + RESULT_GAP
    rowHeight = Math.max(rowHeight, node.h)
    if (cursorX >= startX + maxWidth) {
      cursorX = startX
      cursorY += rowHeight + RESULT_GAP
      rowHeight = 0
    }
  }

  deps.logger.info(LogEvent.imageSearchCollected, {
    projectId,
    candidates: urls.length,
    limit,
    imported: imported.length,
    scanMs,
    downloadMs,
    importMs: Date.now() - importStartedAt
  })

  if (imported.length === 0) {
    return { ok: false, message: errors[0]?.message ?? '这些图片都没能下载下来' }
  }
  return finishImport(deps, projectId, { imported, errors })
}

/** 限并发地跑一串异步任务，结果顺序与输入一致。 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
