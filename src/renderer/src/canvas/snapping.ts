import type { Rect } from './hit-test'

/**
 * 智能参考线与吸附（路线图 D2.6 的交互细节，对齐 Figma）。
 *
 * 做法：把被拖的盒子与"其它盒子"的**左/中/右**（横轴）和**上/中/下**（纵轴）两两比较，
 * 取距离最近、且在阈值内的那一组，把盒子吸过去，并输出一条参考线。
 *
 * 纯函数、世界坐标、可单测。阈值由调用方按缩放换算（屏幕上约 6px）。
 */

export interface GuideLine {
  axis: 'x' | 'y'
  /** 参考线在世界坐标里的位置（横轴是 x，纵轴是 y） */
  position: number
  /** 参考线覆盖的范围，用来画得刚好盖住"双方" */
  start: number
  end: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: GuideLine[]
}

export const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] }

interface AxisValues {
  /** 靠左/靠上 */
  start: number
  /** 居中 */
  center: number
  /** 靠右/靠下 */
  end: number
}

function xValues(rect: Rect): AxisValues {
  return { start: rect.x, center: rect.x + rect.w / 2, end: rect.x + rect.w }
}

function yValues(rect: Rect): AxisValues {
  return { start: rect.y, center: rect.y + rect.h / 2, end: rect.y + rect.h }
}

interface AxisSnap {
  delta: number
  position: number
  /** 参考线在该轴上的跨度（另一轴） */
  start: number
  end: number
}

/** 在一条轴上找最佳吸附：返回位移与参考线位置。 */
function snapAxis(
  moving: AxisValues,
  others: { values: AxisValues; span: [number, number] }[],
  threshold: number
): AxisSnap | null {
  const movingKeys: (keyof AxisValues)[] = ['start', 'center', 'end']
  let best: AxisSnap | null = null

  for (const other of others) {
    for (const movingKey of movingKeys) {
      for (const otherKey of movingKeys) {
        const delta = other.values[otherKey] - moving[movingKey]
        const distance = Math.abs(delta)
        if (distance > threshold) continue
        if (best && distance >= Math.abs(best.delta)) continue
        best = {
          delta,
          position: other.values[otherKey],
          start: other.span[0],
          end: other.span[1]
        }
      }
    }
  }
  return best
}

/**
 * 移动时的吸附。`others` 是画布上其它节点的盒子（不含被拖的）。
 * 横轴与纵轴各自独立求解，互不影响。
 */
export function snapBoxes(moving: Rect, others: Rect[], threshold: number): SnapResult {
  if (others.length === 0 || threshold <= 0) return NO_SNAP

  const xSnap = snapAxis(
    xValues(moving),
    others.map((rect) => ({ values: xValues(rect), span: [rect.y, rect.y + rect.h] })),
    threshold
  )
  const ySnap = snapAxis(
    yValues(moving),
    others.map((rect) => ({ values: yValues(rect), span: [rect.x, rect.x + rect.w] })),
    threshold
  )

  // 参考线只盖住"被拖的盒子"和"被对齐的那个盒子"，不是整条画布
  const guides: GuideLine[] = []
  if (xSnap) {
    guides.push({
      axis: 'x',
      position: xSnap.position,
      start: Math.min(moving.y, xSnap.start),
      end: Math.max(moving.y + moving.h, xSnap.end)
    })
  }
  if (ySnap) {
    guides.push({
      axis: 'y',
      position: ySnap.position,
      start: Math.min(moving.x, ySnap.start),
      end: Math.max(moving.x + moving.w, ySnap.end)
    })
  }

  return { dx: xSnap?.delta ?? 0, dy: ySnap?.delta ?? 0, guides }
}

/** 缩放时哪几条边在动：拖右边就只有 right，拖左上角则 left + top。 */
export interface MovingEdges {
  left?: boolean
  right?: boolean
  top?: boolean
  bottom?: boolean
}

export interface ResizeSnap {
  rect: Rect
  guides: GuideLine[]
}

/** 在一条轴上找离 `value` 最近、且在阈值内的对齐目标。 */
function nearestEdge(
  value: number,
  others: { values: AxisValues; span: [number, number] }[],
  threshold: number
): { value: number; span: [number, number] } | null {
  const keys: (keyof AxisValues)[] = ['start', 'center', 'end']
  let best: { value: number; span: [number, number] } | null = null

  for (const other of others) {
    for (const key of keys) {
      const candidate = other.values[key]
      const distance = Math.abs(candidate - value)
      if (distance > threshold) continue
      if (best && distance >= Math.abs(best.value - value)) continue
      best = { value: candidate, span: other.span }
    }
  }
  return best
}

/**
 * 缩放时的吸附：**只吸正在被拖动的那几条边**。
 *
 * 与移动不同——移动是整块平移，缩放只让被拖的边贴过去，对边（锚点）纹丝不动，
 * 所以修正量落在宽高上而不是位置上。每个轴最多一条边在动，横纵互不影响。
 */
export function snapResizeBox(
  moving: Rect,
  edges: MovingEdges,
  others: Rect[],
  threshold: number
): ResizeSnap {
  if (others.length === 0 || threshold <= 0) return { rect: moving, guides: [] }

  let { x, y, w, h } = moving
  const guides: GuideLine[] = []

  const xEdge = edges.left === true ? x : edges.right === true ? x + w : null
  if (xEdge !== null) {
    const hit = nearestEdge(
      xEdge,
      others.map((rect) => ({ values: xValues(rect), span: [rect.y, rect.y + rect.h] })),
      threshold
    )
    if (hit) {
      const delta = hit.value - xEdge
      if (edges.left === true) {
        x += delta
        w -= delta
      } else {
        w += delta
      }
      guides.push({
        axis: 'x',
        position: hit.value,
        start: Math.min(y, hit.span[0]),
        end: Math.max(y + h, hit.span[1])
      })
    }
  }

  const yEdge = edges.top === true ? y : edges.bottom === true ? y + h : null
  if (yEdge !== null) {
    const hit = nearestEdge(
      yEdge,
      others.map((rect) => ({ values: yValues(rect), span: [rect.x, rect.x + rect.w] })),
      threshold
    )
    if (hit) {
      const delta = hit.value - yEdge
      if (edges.top === true) {
        y += delta
        h -= delta
      } else {
        h += delta
      }
      guides.push({
        axis: 'y',
        position: hit.value,
        start: Math.min(x, hit.span[0]),
        end: Math.max(x + w, hit.span[1])
      })
    }
  }

  return { rect: { x, y, w, h }, guides }
}
