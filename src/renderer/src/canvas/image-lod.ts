import { THUMBNAIL_MAX_EDGE } from '../../../shared/asset-url'

/**
 * 该不该为这张图加载原图（D6b）。
 *
 * 缩略图最长边只有 `THUMBNAIL_MAX_EDGE`：屏幕上的图再大，缩略图也只是被放大，糊；
 * 反过来，缩小看全局时每张图只占几十像素，解码原图纯属白占内存。
 *
 * **裁切会放大可见部分**：显示 300px 的裁切图，如果只裁了原图宽度的 20%，
 * 相当于整张图要按 1500px 显示。所以按"整张图在屏幕上的长边"判断，不是按可视框。
 */
export function fullEdgeAtZoom1(
  box: { w: number; h: number },
  crop: { w: number; h: number }
): number {
  const width = Math.max(box.w, 1) / Math.max(crop.w, 0.01)
  const height = Math.max(box.h, 1) / Math.max(crop.h, 0.01)
  return Math.max(width, height)
}

/** 屏幕上的整张图（按设备像素）是否已经超过缩略图的分辨率。 */
export function needsOriginalAt(edgeAtZoom1: number, zoom: number, pixelRatio: number): boolean {
  return edgeAtZoom1 * zoom * pixelRatio > THUMBNAIL_MAX_EDGE
}

export function needsOriginal(
  box: { w: number; h: number },
  crop: { w: number; h: number },
  zoom: number,
  pixelRatio: number
): boolean {
  // 参数异常时宁可加载原图，也不要拿一张糊图凑合
  if (!(zoom > 0) || !(pixelRatio > 0)) return true
  return needsOriginalAt(fullEdgeAtZoom1(box, crop), zoom, pixelRatio)
}
