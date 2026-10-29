import type { Viewport } from '../../../shared/ipc'

/**
 * 画布视图的纯数学（路线图 D2.1 / D2.2）。
 *
 * 约定：`viewport.x/y` 是**世界坐标原点在屏幕上的位置**，`zoom` 是缩放倍率。
 *   screen = world × zoom + viewport.xy
 * 不碰 Pixi、不碰 DOM，所以能直接单测——缩放"以光标为锚点"这类容易写错的地方，
 * 全靠这里的小用例守住。
 */

/** InsPin 支持的缩放范围：1% 至 25,600%。 */
export const MIN_ZOOM = 0.01
export const MAX_ZOOM = 256
/** Figma 默认的键盘缩放档位：50% → 100% → 200%。 */
export const ZOOM_STEP = 2
export const ZOOM_SNAP_LEVELS = [0.5, 1, 2] as const
/** 连续捏合接近常用档位时，给一个不阻滞手势的轻微吸附范围。 */
const ZOOM_SNAP_TOLERANCE = 0.025
/** 捏合 / ⌘ 或 Ctrl + 滚轮的连续缩放灵敏度。 */
const WHEEL_ZOOM_SENSITIVITY = 0.006

export interface Point {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

export interface Box extends Point, Size {}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function toScreen(viewport: Viewport, world: Point): Point {
  return {
    x: world.x * viewport.zoom + viewport.x,
    y: world.y * viewport.zoom + viewport.y
  }
}

export function toWorld(viewport: Viewport, screen: Point): Point {
  return {
    x: (screen.x - viewport.x) / viewport.zoom,
    y: (screen.y - viewport.y) / viewport.zoom
  }
}

/**
 * 以屏幕上某点为锚点缩放到 `nextZoom`：**该点下方的世界坐标保持不动**
 * （滚轮缩放手感好坏就取决于这一条）。
 */
export function zoomAt(viewport: Viewport, nextZoom: number, anchor: Point): Viewport {
  const zoom = clampZoom(nextZoom)
  const ratio = zoom / viewport.zoom
  return {
    zoom,
    x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio
  }
}

/** 常用缩放点的轻吸附：50%、100%、200%。 */
export function snapZoomToPreset(zoom: number): number {
  const nearest = ZOOM_SNAP_LEVELS.find(
    (preset) => Math.abs(zoom - preset) / preset <= ZOOM_SNAP_TOLERANCE
  )
  return nearest ?? zoom
}

/** 滚轮增量 → 目标倍率。向上滚（deltaY < 0）放大。 */
export function zoomFromWheel(currentZoom: number, deltaY: number): number {
  return snapZoomToPreset(clampZoom(currentZoom * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY)))
}

/**
 * 触控板双指滑动/无修饰键滚轮 → 平移视口。
 * WheelEvent 的 delta 已按系统滚动方向给出；按网页滚动的惯例取反，画布内容会
 * 随滚动方向连续移动，和 Figma 的“双指滑动平移”保持一致。
 */
export function panFromWheel(viewport: Viewport, deltaX: number, deltaY: number): Viewport {
  return {
    ...viewport,
    x: viewport.x - deltaX,
    y: viewport.y - deltaY
  }
}

/**
 * Figma 风格的滚轮平移增量：正常跟随双指 / 滚轮方向；按住 Shift 时把纵向滚动
 * 映射为横向，触控板已经给出横向增量时则优先保留它。
 */
export function panDeltasFromWheel(deltaX: number, deltaY: number, shiftKey: boolean): Point {
  if (!shiftKey) return { x: deltaX, y: deltaY }
  return { x: deltaX || deltaY, y: 0 }
}

/** 围绕视口中心倍数缩放（按钮用）。 */
export function zoomByStep(viewport: Viewport, size: Size, steps: number): Viewport {
  const center = { x: size.w / 2, y: size.h / 2 }
  return zoomAt(viewport, viewport.zoom * ZOOM_STEP ** steps, center)
}

/** 把视口重置为 100%，围绕中心。 */
export function resetZoom(viewport: Viewport, size: Size): Viewport {
  return zoomAt(viewport, 1, { x: size.w / 2, y: size.h / 2 })
}

/** 让内容正好装进视口（"适合内容"）。内容为空时回到原点 100%。 */
export function fitViewport(content: Box | null, size: Size, padding = 48): Viewport {
  if (!content || content.w <= 0 || content.h <= 0) {
    return { x: size.w / 2, y: size.h / 2, zoom: 1 }
  }
  const zoom = clampZoom(
    Math.min((size.w - padding * 2) / content.w, (size.h - padding * 2) / content.h)
  )
  return {
    zoom,
    x: size.w / 2 - (content.x + content.w / 2) * zoom,
    y: size.h / 2 - (content.y + content.h / 2) * zoom
  }
}

/** 显示用的百分比。 */
export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100)
}

/**
 * 把一个矩形四周各放大 `factor` 倍。
 *
 * 用在"建层范围"上：按看得见的范围再多建一圈，平移一点点就不用整棵重建。
 */
export function expandBox(box: Box, factor: number): Box {
  const dx = box.w * factor
  const dy = box.h * factor
  return { x: box.x - dx, y: box.y - dy, w: box.w + dx * 2, h: box.h + dy * 2 }
}

/** `outer` 是否完全包住 `inner`。 */
export function boxContains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}
