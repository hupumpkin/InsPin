import type { Viewport } from '../../../shared/ipc'
import type { Rect } from './hit-test'
import type { MovingEdges } from './snapping'
import { toScreen } from './viewport'

/**
 * 选中框的边角命中区与光标（路线图 D2.4 的交互细节，对齐 Figma）。
 *
 * **不画可见的手柄方块**：可发现性交给光标——鼠标压到边或角上，光标变成对应的缩放箭头。
 * 命中区是**屏幕像素**，不随缩放变化（否则放大后要瞄得很准）。
 *
 * 八向：四角 + 四边。角落优先级高于边（角落附近两者重叠时按角处理）。
 */

/** 命中区半宽（屏幕像素）。比视觉线宽大得多，才好点。 */
export const HANDLE_TOLERANCE = 6
/** 选中框线宽（设计规范） */
export const SELECTION_BORDER = 1.5
/** 旋转区：角外侧多远开始算旋转（Figma 是角外侧一小圈） */
export const ROTATE_ZONE = 18

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const CORNERS: HandleId[] = ['nw', 'ne', 'se', 'sw']
export const EDGES: HandleId[] = ['n', 'e', 's', 'w']
export const HANDLES: HandleId[] = [...CORNERS, ...EDGES]

export const isCorner = (handle: HandleId): boolean => CORNERS.includes(handle)

/**
 * 拖这个手柄时**哪几条边在动**——缩放吸附只吸这几条（对边是锚点，不该跟着动）。
 */
export function movingEdges(handle: HandleId): MovingEdges {
  return {
    left: handle.includes('w'),
    right: handle.includes('e'),
    top: handle.includes('n'),
    bottom: handle.includes('s')
  }
}

/** 方向 → 光标。水平/垂直边是单向箭头，四角是对角箭头。 */
export function cursorForHandle(handle: HandleId): string {
  switch (handle) {
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'n':
    case 's':
      return 'ns-resize'
    default:
      return 'ew-resize'
  }
}

/**
 * 把世界坐标的点转到节点的**局部坐标系**（以矩形中心为原点，按 -rotation 反向旋转）。
 *
 * 节点旋转后，它的"边/角"在屏幕上也是转过的，所以判定必须先转回局部坐标系再做，
 * 否则旋转 45° 后手柄位置全错。
 */
export function rotateAround(
  point: { x: number; y: number },
  center: { x: number; y: number },
  degrees: number
): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
}

export function toLocalPoint(bounds: Rect, rotationDeg: number, point: { x: number; y: number }): { x: number; y: number } {
  return rotateAround(point, { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }, -rotationDeg)
}

/** 命中的部位在屏幕上的中心点（四角在角上，四边在中点）。 */
export function handleCenter(bounds: Rect, handle: HandleId, viewport: Viewport): { x: number; y: number } {
  const topLeft = toScreen(viewport, { x: bounds.x, y: bounds.y })
  const bottomRight = toScreen(viewport, { x: bounds.x + bounds.w, y: bounds.y + bounds.h })
  const midX = (topLeft.x + bottomRight.x) / 2
  const midY = (topLeft.y + bottomRight.y) / 2

  const x = handle.includes('w') ? topLeft.x : handle.includes('e') ? bottomRight.x : midX
  const y = handle.includes('n') ? topLeft.y : handle.includes('s') ? bottomRight.y : midY
  return { x, y }
}

/**
 * 命中哪个缩放部位。**四角优先于四边**——角落附近两者重叠时，应该按角处理。
 * 边只在"贴着那条边、且没跑到角上"时命中。
 */
export function handleAtPoint(
  bounds: Rect,
  viewport: Viewport,
  point: { x: number; y: number },
  tolerance = HANDLE_TOLERANCE
): HandleId | null {
  const topLeft = toScreen(viewport, { x: bounds.x, y: bounds.y })
  const bottomRight = toScreen(viewport, { x: bounds.x + bounds.w, y: bounds.y + bounds.h })

  const nearLeft = Math.abs(point.x - topLeft.x) <= tolerance
  const nearRight = Math.abs(point.x - bottomRight.x) <= tolerance
  const nearTop = Math.abs(point.y - topLeft.y) <= tolerance
  const nearBottom = Math.abs(point.y - bottomRight.y) <= tolerance
  const withinX = point.x >= topLeft.x - tolerance && point.x <= bottomRight.x + tolerance
  const withinY = point.y >= topLeft.y - tolerance && point.y <= bottomRight.y + tolerance

  // 角优先
  if (nearLeft && nearTop) return 'nw'
  if (nearRight && nearTop) return 'ne'
  if (nearRight && nearBottom) return 'se'
  if (nearLeft && nearBottom) return 'sw'

  if (nearTop && withinX) return 'n'
  if (nearBottom && withinX) return 's'
  if (nearLeft && withinY) return 'w'
  if (nearRight && withinY) return 'e'
  return null
}

/**
 * 是否落在"旋转区"：角的外侧一小圈（Figma 把光标移到角外就变成旋转）。
 * 旋转区**不含**角与边本身（那些是缩放），所以先判缩放、再判旋转。
 */
export function rotateZoneAtPoint(
  bounds: Rect,
  viewport: Viewport,
  point: { x: number; y: number },
  inner = HANDLE_TOLERANCE,
  outer = ROTATE_ZONE
): boolean {
  for (const corner of CORNERS) {
    const center = handleCenter(bounds, corner, viewport)
    const distance = Math.hypot(point.x - center.x, point.y - center.y)
    if (distance > inner && distance <= outer) return true
  }
  return false
}

/**
 * 世界坐标的矩形 → 屏幕上的 CSS 盒子（带旋转）。
 * 用"中心点 + transform 旋转"表达，这样节点转多少、框就跟着转多少。
 */
export function screenBoxRotated(
  bounds: Rect,
  rotationDeg: number,
  viewport: Viewport
): { left: number; top: number; width: number; height: number; transform: string } {
  const center = toScreen(viewport, { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 })
  return {
    left: center.x,
    top: center.y,
    width: bounds.w * viewport.zoom,
    height: bounds.h * viewport.zoom,
    transform: `translate(-50%, -50%) rotate(${rotationDeg}deg)`
  }
}

/** 世界坐标的矩形 → 屏幕上的 CSS 盒子。 */
export function screenBox(
  bounds: Rect,
  viewport: Viewport
): { left: number; top: number; width: number; height: number } {
  const topLeft = toScreen(viewport, { x: bounds.x, y: bounds.y })
  return {
    left: topLeft.x,
    top: topLeft.y,
    width: bounds.w * viewport.zoom,
    height: bounds.h * viewport.zoom
  }
}

/**
 * 自动布局插入线：长度跟着画布缩放，**厚度固定 2 屏幕像素**。
 *
 * 直接对世界坐标的 2 单位厚度用 `screenBox` 的话，缩到“适合内容”时会变成
 * 0.x 像素、几乎看不见——外边框是屏幕恒定的，所以用户只看到边框、看不到插入线。
 * 世界坐标里短边是厚度、长边是长度，这里只把厚度拉回屏幕像素。
 */
export function screenInsertionLine(
  line: Rect,
  viewport: Viewport
): { left: number; top: number; width: number; height: number } {
  const box = screenBox(line, viewport)
  const thickness = 2
  if (line.w <= line.h) {
    return {
      left: box.left + (box.width - thickness) / 2,
      top: box.top,
      width: thickness,
      height: Math.max(thickness, box.height)
    }
  }
  return {
    left: box.left,
    top: box.top + (box.height - thickness) / 2,
    width: Math.max(thickness, box.width),
    height: thickness
  }
}
