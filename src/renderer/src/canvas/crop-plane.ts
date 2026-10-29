import type { AssetCrop } from '../../../shared/node'
import type { Viewport } from '../../../shared/ipc'
import { normalizeCrop } from '../../../shared/crop'
import type { Rect } from './hit-test'
import { toScreen } from './viewport'

/**
 * 可视化裁切用的平面几何。
 *
 * 坐标系固定为**节点的局部空间**（未旋转，原点在节点左上角），单位与画布世界一致：
 *   - `image` 是整张原图铺开后的矩形（可能远大于节点）；
 *   - `selection` 是用户拖出来的裁切框。
 * 两者相除就是存进模型的归一化 `AssetCrop`，所以拖框、拖图、缩放全部只改这两个矩形。
 *
 * 提交时节点盒子直接收成 `selection`：所见即所得，也不会把裁好的图拉变形。
 */

export interface Point {
  x: number
  y: number
}

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const CROP_HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
export const CROP_CORNERS: CropHandle[] = ['nw', 'ne', 'se', 'sw']

export interface CropPlane {
  image: Rect
  selection: Rect
}

/** 进入裁切时的初始平面：裁切框正好落在节点当前可见区域上。 */
export function initialCropPlane(box: Rect, crop: AssetCrop): CropPlane {
  const safe = normalizeCrop(crop)
  const image = {
    x: -(safe.x / safe.w) * box.w,
    y: -(safe.y / safe.h) * box.h,
    w: box.w / safe.w,
    h: box.h / safe.h
  }
  return { image, selection: { x: 0, y: 0, w: box.w, h: box.h } }
}

/** 平面 → 存进模型的归一化裁切区域。 */
export function cropOfPlane(plane: CropPlane): AssetCrop {
  const { image, selection } = plane
  if (image.w <= 0 || image.h <= 0) return { x: 0, y: 0, w: 1, h: 1 }
  return normalizeCrop({
    x: (selection.x - image.x) / image.w,
    y: (selection.y - image.y) / image.h,
    w: selection.w / image.w,
    h: selection.h / image.h
  })
}

/**
 * 裁切框在世界坐标里的新节点盒子。
 *
 * 节点绕**中心**旋转，裁切框又可能不在节点正中，所以中心位移要跟着一起转；
 * 不这么做的话，旋转过的图裁完会跳一段距离。
 */
export function commitCropBox(box: Rect, rotation: number, selection: Rect): Rect {
  const centerX = box.x + box.w / 2
  const centerY = box.y + box.h / 2
  const localX = selection.x + selection.w / 2 - box.w / 2
  const localY = selection.y + selection.h / 2 - box.h / 2
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const worldX = centerX + localX * cos - localY * sin
  const worldY = centerY + localX * sin + localY * cos
  return { x: worldX - selection.w / 2, y: worldY - selection.h / 2, w: selection.w, h: selection.h }
}

/** 指针的屏幕坐标 → 去旋转后的节点局部坐标。 */
export function screenPointToLocal(
  screen: Point,
  centerScreen: Point,
  box: Rect,
  rotation: number,
  zoom: number
): Point {
  const dx = screen.x - centerScreen.x
  const dy = screen.y - centerScreen.y
  const radians = (-rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const safeZoom = zoom > 0 ? zoom : 1
  return {
    x: box.w / 2 + (dx * cos - dy * sin) / safeZoom,
    y: box.h / 2 + (dx * sin + dy * cos) / safeZoom
  }
}

/** 裁切框在屏幕上的轴对齐包围盒（工具条靠它找位置；旋转时也保持在画布内）。 */
export function screenAabb(
  selection: Rect,
  box: Rect,
  rotation: number,
  viewport: Viewport
): { left: number; top: number; right: number; bottom: number } {
  const center = toScreen(viewport, { x: box.x + box.w / 2, y: box.y + box.h / 2 })
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const corners = [
    { x: selection.x, y: selection.y },
    { x: selection.x + selection.w, y: selection.y },
    { x: selection.x + selection.w, y: selection.y + selection.h },
    { x: selection.x, y: selection.y + selection.h }
  ].map((corner) => {
    const localX = (corner.x - box.w / 2) * viewport.zoom
    const localY = (corner.y - box.h / 2) * viewport.zoom
    return {
      x: center.x + localX * cos - localY * sin,
      y: center.y + localX * sin + localY * cos
    }
  })
  return {
    left: Math.min(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)),
    bottom: Math.max(...corners.map((point) => point.y))
  }
}

/** 指针压在哪个手柄上；容差是屏幕像素换算到局部单位后的值。 */
export function cropHandleAt(selection: Rect, point: Point, tolerance: number): CropHandle | null {
  const right = selection.x + selection.w
  const bottom = selection.y + selection.h
  const nearLeft = Math.abs(point.x - selection.x) <= tolerance
  const nearRight = Math.abs(point.x - right) <= tolerance
  const nearTop = Math.abs(point.y - selection.y) <= tolerance
  const nearBottom = Math.abs(point.y - bottom) <= tolerance
  const withinX = point.x >= selection.x - tolerance && point.x <= right + tolerance
  const withinY = point.y >= selection.y - tolerance && point.y <= bottom + tolerance
  if (!withinX || !withinY) return null
  if (nearLeft && nearTop) return 'nw'
  if (nearRight && nearTop) return 'ne'
  if (nearRight && nearBottom) return 'se'
  if (nearLeft && nearBottom) return 'sw'
  if (nearTop) return 'n'
  if (nearRight) return 'e'
  if (nearBottom) return 's'
  if (nearLeft) return 'w'
  return null
}

export function pointInRect(point: Point, rect: Rect, padding = 0): boolean {
  return (
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.w + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.h + padding
  )
}

/** 拖动裁切框本身：整框只能压在图片里。 */
export function moveSelection(selection: Rect, dx: number, dy: number, image: Rect): Rect {
  return {
    ...selection,
    x: clamp(selection.x + dx, image.x, image.x + image.w - selection.w),
    y: clamp(selection.y + dy, image.y, image.y + image.h - selection.h)
  }
}

/** 拖动图片：松手前必须仍然盖住裁切框，否则会露出空底。 */
export function moveImage(image: Rect, dx: number, dy: number, selection: Rect): Rect {
  return coverImage({ ...image, x: image.x + dx, y: image.y + dy }, selection)
}

/**
 * 滚轮缩放图片。锚点（通常是光标处）保持不动，缩放后仍保证盖住裁切框。
 * `maxWidth` 限制放大倍率，避免糊成一片。
 */
export function zoomImage(
  image: Rect,
  selection: Rect,
  anchor: Point,
  factor: number,
  maxWidth: number
): Rect {
  if (image.w <= 0 || image.h <= 0 || !Number.isFinite(factor) || factor <= 0) return image
  const minFactor = Math.max(selection.w / image.w, selection.h / image.h)
  const maxFactor = Math.max(minFactor, maxWidth / image.w)
  const applied = clamp(factor, minFactor, maxFactor)
  const next = {
    x: anchor.x - (anchor.x - image.x) * applied,
    y: anchor.y - (anchor.y - image.y) * applied,
    w: image.w * applied,
    h: image.h * applied
  }
  return coverImage(next, selection)
}

/** 固定比例：在当前裁切框内居中收一个最大同比例矩形。 */
export function fitSelectionAspect(selection: Rect, ratio: number): Rect {
  if (!Number.isFinite(ratio) || ratio <= 0) return selection
  let w = selection.w
  let h = w / ratio
  if (h > selection.h) {
    h = selection.h
    w = h * ratio
  }
  return {
    x: selection.x + (selection.w - w) / 2,
    y: selection.y + (selection.h - h) / 2,
    w,
    h
  }
}

/**
 * 拖手柄改裁切框。
 *
 * `aspect` 为 null 时四边自由；有值时对边/对角固定，等比缩到图片边界为止。
 * `minSize` 是屏幕最小尺寸换算到局部的值。
 */
export function resizeSelection(
  selection: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  image: Rect,
  minSize: number,
  aspect: number | null
): Rect {
  const minX = image.x
  const minY = image.y
  const maxX = image.x + image.w
  const maxY = image.y + image.h
  let left = selection.x
  let top = selection.y
  let right = selection.x + selection.w
  let bottom = selection.y + selection.h
  if (handle.includes('w')) left += dx
  if (handle.includes('e')) right += dx
  if (handle.includes('n')) top += dy
  if (handle.includes('s')) bottom += dy

  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) {
    left = clamp(left, minX, right - minSize)
    right = clamp(right, left + minSize, maxX)
    top = clamp(top, minY, bottom - minSize)
    bottom = clamp(bottom, top + minSize, maxY)
    return { x: left, y: top, w: right - left, h: bottom - top }
  }

  const verticalEdge = handle === 'e' || handle === 'w'
  const horizontalEdge = handle === 'n' || handle === 's'
  const dirX = horizontalEdge ? 0 : handle.includes('w') ? -1 : 1
  const dirY = verticalEdge ? 0 : handle.includes('n') ? -1 : 1
  const anchorX = dirX < 0 ? right : dirX > 0 ? left : (left + right) / 2
  const anchorY = dirY < 0 ? bottom : dirY > 0 ? top : (top + bottom) / 2

  let w = right - left
  let h = bottom - top
  if (verticalEdge) h = w / aspect
  else if (horizontalEdge) w = h * aspect
  else if (w / aspect > h) h = w / aspect
  else w = h * aspect

  const maxW = dirX > 0
    ? maxX - anchorX
    : dirX < 0
      ? anchorX - minX
      : 2 * Math.min(anchorX - minX, maxX - anchorX)
  const maxH = dirY > 0
    ? maxY - anchorY
    : dirY < 0
      ? anchorY - minY
      : 2 * Math.min(anchorY - minY, maxY - anchorY)
  if (w > 0 && h > 0) {
    const scale = Math.min(1, maxW / w, maxH / h)
    if (scale > 0 && Number.isFinite(scale)) {
      w *= scale
      h *= scale
    }
    const grow = Math.max(1, minSize / w, minSize / h)
    w *= grow
    h *= grow
  }
  return {
    x: dirX > 0 ? anchorX : dirX < 0 ? anchorX - w : anchorX - w / 2,
    y: dirY > 0 ? anchorY : dirY < 0 ? anchorY - h : anchorY - h / 2,
    w,
    h
  }
}

/** 按原图像素尺寸估算裁切结果，工具条上的读数用。 */
export function cropPixelSize(
  plane: CropPlane,
  naturalWidth: number,
  naturalHeight: number
): { w: number; h: number } {
  const { image, selection } = plane
  if (image.w <= 0 || image.h <= 0) return { w: 0, h: 0 }
  return {
    w: Math.max(1, Math.round((selection.w / image.w) * naturalWidth)),
    h: Math.max(1, Math.round((selection.h / image.h) * naturalHeight))
  }
}

function coverImage(image: Rect, selection: Rect): Rect {
  const minX = selection.x + selection.w - image.w
  const maxX = selection.x
  const minY = selection.y + selection.h - image.h
  const maxY = selection.y
  return {
    ...image,
    x: minX <= maxX ? clamp(image.x, minX, maxX) : selection.x + (selection.w - image.w) / 2,
    y: minY <= maxY ? clamp(image.y, minY, maxY) : selection.y + (selection.h - image.h) / 2
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
