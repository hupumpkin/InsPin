import type { SceneItem } from '../../../shared/scene'

/**
 * 命中测试与框选（路线图 D2.4 / D2.5）。
 *
 * 直接在**模型算出来的绝对坐标**上做，不依赖渲染器——所以可单测，也保证"看到的就是能点到的"。
 * 坐标一律是**世界坐标**（画布坐标系），调用方负责把屏幕坐标换算过来。
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function containsPoint(item: SceneItem, point: Point): boolean {
  return (
    point.x >= item.absX &&
    point.x <= item.absX + item.w &&
    point.y >= item.absY &&
    point.y <= item.absY + item.h
  )
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

const boxOf = (item: SceneItem): Rect => ({ x: item.absX, y: item.absY, w: item.w, h: item.h })

/**
 * 点中哪个节点：**取最上面的那个**（绘制顺序里靠后的压在上面），并且**取最深的那个**
 * ——点在子节点上应该选中子节点，而不是它所在的容器。
 */
export function hitTest(items: SceneItem[], point: Point): string | null {
  // 从后往前（越靠后越在上层）
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || !item.node.visible || item.node.locked) continue

    // 先把子节点看一遍：命中了就选子节点
    const inChild = hitTest(item.children, point)
    if (inChild) return inChild

    if (containsPoint(item, point)) return item.node.id
  }
  return null
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

/**
 * 框选：与矩形相交的节点。
 *
 * 两条规则（与 Figma 一致）：
 *   - 命中一个节点后**不再往下钻**——它是"作为一个整体"被选中的，否则容器和它的每个
 *     子节点都会进选中集，后续拖动就重复了；
 *   - 但如果矩形**完全落在某个有子节点的容器里**，说明用户想选的是容器里的东西，
 *     这时往下钻，而不是把容器本身选上。
 */
export function itemsInRect(items: SceneItem[], rect: Rect): string[] {
  const found: string[] = []
  const walk = (list: SceneItem[]): void => {
    for (const item of list) {
      if (!item.node.visible || item.node.locked) {
        // 锁定的不参与框选，但它的子节点仍可能可选
        walk(item.children)
        continue
      }
      const box = boxOf(item)
      if (item.children.length > 0 && containsRect(box, rect)) {
        walk(item.children)
        continue
      }
      if (intersects(box, rect)) found.push(item.node.id)
    }
  }
  walk(items)
  return found
}

/** 归一化矩形（拖框时起点可能在终点右下）。 */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  }
}

/** 一次遍历取出多个选中节点各自的包围盒（多选时每个都要画一圈细轮廓）。 */
export function boxesOfItems(items: SceneItem[], ids: string[]): Map<string, Rect> {
  const wanted = new Set(ids)
  const boxes = new Map<string, Rect>()
  const walk = (list: SceneItem[]): void => {
    for (const item of list) {
      if (wanted.has(item.node.id)) boxes.set(item.node.id, boxOf(item))
      walk(item.children)
    }
  }
  walk(items)
  return boxes
}

/** 一次遍历取出这些节点各自的旋转角（度）。选中框/悬停框要跟着转。 */
export function rotationsOfItems(items: SceneItem[], ids: string[]): Map<string, number> {
  const wanted = new Set(ids)
  const rotations = new Map<string, number>()
  const walk = (list: SceneItem[]): void => {
    for (const item of list) {
      if (wanted.has(item.node.id)) rotations.set(item.node.id, item.node.rotation)
      walk(item.children)
    }
  }
  walk(items)
  return rotations
}

/**
 * 若干节点的共同包围盒；给选中框用。空数组返回 null。
 *
 * `overrides` 是**拖动中的实时盒子**（世界坐标）：拖动时模型还没更新，
 * 选中框得按这个画才跟手（见 `SelectionOverlay`）。
 */
export function boundsOfItems(
  items: SceneItem[],
  ids: string[],
  overrides?: Map<string, Rect>
): Rect | null {
  const found = boxesOfItems(items, ids)
  for (const [id, box] of overrides ?? []) {
    if (found.has(id)) found.set(id, box)
  }
  const boxes = [...found.values()]
  if (boxes.length === 0) return null

  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.w))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * 指针是否压在选中框的**边框**上（不是里面）。
 * 压边时应当显示移动光标——Figma 就是这样，边框本身也能拖着走。
 */
export function onBoxEdge(bounds: Rect, point: Point, tolerance = 4): boolean {
  const insideX = point.x >= bounds.x - tolerance && point.x <= bounds.x + bounds.w + tolerance
  const insideY = point.y >= bounds.y - tolerance && point.y <= bounds.y + bounds.h + tolerance
  if (!insideX || !insideY) return false
  const innerX = point.x >= bounds.x + tolerance && point.x <= bounds.x + bounds.w - tolerance
  const innerY = point.y >= bounds.y + tolerance && point.y <= bounds.y + bounds.h - tolerance
  return !(innerX && innerY)
}
