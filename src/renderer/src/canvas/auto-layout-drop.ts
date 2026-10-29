import type { ProjectGraph } from '../../../shared/node'
import type { SceneItem } from '../../../shared/scene'
import { insertionIndex, isAutoLayoutContainer } from '../../../shared/auto-layout'
import type { Point, Rect } from './hit-test'

/**
 * 拖到自动布局容器上时的落点计算（路线图 D4b.7 / D4b.8）。
 *
 * 纯函数：拿渲染树（SceneItem，带绝对坐标）和指针位置，算出"落进哪个容器的第几个"，
 * 以及那条**蓝色插入线**该画在哪（世界坐标）。
 */

export interface ContainerDrop {
  containerId: string
  index: number
  /** 插入线在世界坐标里的矩形（横向布局是竖线，纵向是横线） */
  line: Rect
}

function boxOf(item: SceneItem): Rect {
  return { x: item.absX, y: item.absY, w: item.w, h: item.h }
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
}

/** 用 id 在渲染树里找条目。 */
export function findItem(items: SceneItem[], id: string): SceneItem | null {
  for (const item of items) {
    if (item.node.id === id) return item
    const found = findItem(item.children, id)
    if (found) return found
  }
  return null
}

/** 指针底下的、最深的自动布局容器（排除自己与被拖动的子树）。 */
export function findContainerAt(
  items: SceneItem[],
  point: Point,
  excludeIds: Set<string> = new Set()
): SceneItem | null {
  let best: SceneItem | null = null

  const walk = (list: SceneItem[]): void => {
    for (const item of list) {
      if (excludeIds.has(item.node.id)) continue
      const hit = isAutoLayoutContainer(item.node) && contains(boxOf(item), point)
      if (hit) best = item // 深度优先，后命中的更深
      walk(item.children)
    }
  }
  walk(items)
  return best
}

/** 容器里参与流的子条目（绝对定位的不占位，跳过）。 */
function flowChildren(item: SceneItem): SceneItem[] {
  return item.children.filter((child) => child.node.props.layoutPositioning !== 'absolute')
}

/** 算出插入线的矩形。 */
function insertionLine(
  container: SceneItem,
  children: SceneItem[],
  index: number,
  gap: number
): Rect {
  const mode = container.node.type === 'frame' ? container.node.props.layoutMode : 'horizontal'
  const pad =
    container.node.type === 'frame'
      ? container.node.props.padding
      : { top: 0, right: 0, bottom: 0, left: 0 }

  const left = container.absX + pad.left
  const top = container.absY + pad.top
  const right = container.absX + container.w - pad.right
  const bottom = container.absY + container.h - pad.bottom
  const thickness = 2

  if (children.length === 0) {
    // 空容器：贴着内容区左边
    return { x: left - thickness / 2, y: top, w: thickness, h: Math.max(0, bottom - top) }
  }

  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

  if (mode === 'vertical') {
    const before = children[index]
    const after = children[index - 1]
    const y = before
      ? before.absY - gap / 2
      : (after?.absY ?? 0) + (after?.h ?? 0) + gap / 2
    return { x: left, y: clamp(y, top, bottom) - thickness / 2, w: Math.max(0, right - left), h: thickness }
  }

  // 横向与网格都按"竖线"画；网格取该行的高度
  const before = children[index]
  const after = children[index - 1]
  const x = before ? before.absX - gap / 2 : (after?.absX ?? 0) + (after?.w ?? 0) + gap / 2

  if (mode === 'grid') {
    const rowItem = before ?? after
    const rowTop = rowItem ? rowItem.absY : top
    const rowBottom = rowItem ? rowItem.absY + rowItem.h : bottom
    return { x: clamp(x, left, right) - thickness / 2, y: rowTop, w: thickness, h: Math.max(0, rowBottom - rowTop) }
  }

  return { x: clamp(x, left, right) - thickness / 2, y: top, w: thickness, h: Math.max(0, bottom - top) }
}

/**
 * 指针落在某个自动布局容器里时，返回落点与插入线；否则 null。
 *
 * `excludeIds` 是被拖动的节点：既不能落进容器自己，也要从流里去掉——
 * 插入线画的是“把它摘掉之后”会落在哪，才不会被它自己的原位置带偏。
 */
export function computeContainerDrop(
  graph: ProjectGraph,
  items: SceneItem[],
  point: Point,
  excludeIds: string[] = []
): ContainerDrop | null {
  const excluded = new Set(excludeIds)
  const container = findContainerAt(items, point, excluded)
  if (!container) return null

  const children = flowChildren(container).filter((child) => !excluded.has(child.node.id))
  const boxes = children.map((child) => ({ x: child.absX, y: child.absY, w: child.w, h: child.h }))
  const mode = container.node.type === 'frame' ? container.node.props.layoutMode : 'horizontal'
  const gap = container.node.type === 'frame' ? container.node.props.itemSpacing : 0

  const index = insertionIndex(mode, boxes, point)
  return {
    containerId: container.node.id,
    index,
    line: insertionLine(container, children, index, gap)
  }
}

/** 一个节点是不是自动布局容器的直接子节点（用来判断"拖出去"）。 */
export function parentIsContainer(graph: ProjectGraph, nodeId: string): boolean {
  const node = graph.nodes[nodeId]
  if (!node?.parentId) return false
  return isAutoLayoutContainer(graph.nodes[node.parentId])
}
