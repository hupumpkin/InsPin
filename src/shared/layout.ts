import type { FrameNode, Node, ProjectGraph } from './node'

/**
 * 布局求解（路线图 §5.5.4 / D4b.1–D4b.4）。
 *
 * **纯函数**：收图、返每个节点的绝对位置与尺寸，不改输入、不碰渲染，
 * 因此可单测、可撤销。
 *
 * 两趟走（§5.5.4 的规则）：
 *   1. **自底向上定尺寸** —— 先算子节点；`hug` 容器由内容撑开；
 *      `fixed` 容器用自己的 width/height。
 *   2. **自顶向下定位置** —— 容器尺寸确定后，按主轴对齐、次轴对齐摆子节点；
 *      `grow` 分掉多余空间、`stretch` 撑满次轴。
 *
 * 不参与布局的：`layoutPositioning: 'absolute'` 的子节点按自己的 x/y 摆，
 * 不占流的位置（和 Figma 一致）。
 */

export interface LayoutBox {
  /** 画布绝对坐标 */
  x: number
  y: number
  w: number
  h: number
}

/** 节点 id → 它在画布上的绝对位置与尺寸 */
export type LayoutResult = Record<string, LayoutBox>

interface Size {
  w: number
  h: number
}

function isAutoLayout(node: Node): node is FrameNode {
  return node.type === 'frame' && node.props.layoutMode !== 'none'
}

function flowChildren(graph: ProjectGraph, node: Node): Node[] {
  return node.childIds
    .map((id) => graph.nodes[id])
    .filter((child): child is Node => Boolean(child))
    .filter((child) => child.props.layoutPositioning !== 'absolute')
}

function absoluteChildren(graph: ProjectGraph, node: Node): Node[] {
  return node.childIds
    .map((id) => graph.nodes[id])
    .filter((child): child is Node => Boolean(child))
    .filter((child) => child.props.layoutPositioning === 'absolute')
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values)
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

export function layout(graph: ProjectGraph): LayoutResult {
  const result: LayoutResult = {}
  const cache = new Map<string, Size>()

  /** 自底向上：节点"本身"要多大。hug 容器由内容撑开。 */
  const measure = (id: string, path: Set<string>): Size => {
    const node = graph.nodes[id]
    if (!node || path.has(id)) return { w: 0, h: 0 }

    const cached = cache.get(id)
    if (cached) return cached

    if (!isAutoLayout(node)) {
      const size = { w: node.w, h: node.h }
      cache.set(id, size)
      return size
    }

    path.add(id)
    const props = node.props
    const pad = props.padding
    const gap = props.itemSpacing
    const horizontal = props.layoutMode === 'horizontal'
    const grid = props.layoutMode === 'grid'
    const wrap = horizontal && props.layoutWrap === 'wrap'

    const items = flowChildren(graph, node).map((child) => ({
      node: child,
      size: measure(child.id, path)
    }))

    // 主轴 / 次轴分别对应宽还是高。网格按横向处理（与 Figma 一致）
    const horizontalish = horizontal || grid
    const sizingW = horizontalish ? props.primaryAxisSizing : props.counterAxisSizing
    const sizingH = horizontalish ? props.counterAxisSizing : props.primaryAxisSizing

    let contentW = 0
    let contentH = 0

    if (grid) {
      const columns = Math.max(1, Math.min(props.gridColumns, Math.max(1, items.length)))
      const rows = chunk(items, columns)
       const columnWidths = Array.from({ length: columns }, (_, column) =>
        max(rows.map((row) => row[column]?.size.w ?? 0))
      )
      contentW = sum(columnWidths) + gap * Math.max(0, columns - 1)
      contentH = sum(rows.map((row) => max(row.map((item) => item.size.h)))) + gap * Math.max(0, rows.length - 1)
    } else if (wrap && sizingW === 'fixed') {
      // 有确定宽度才能算换行；hug 宽度下的换行没有定义，按不换行处理
      const available = Math.max(0, node.w - pad.left - pad.right)
      const rows = packRows(items, available, gap)
      contentW = available
      contentH = sum(rows.map((row) => max(row.map((item) => item.size.h)))) + gap * Math.max(0, rows.length - 1)
    } else {
      const totalPrimary = sum(items.map((item) => (horizontal ? item.size.w : item.size.h)))
      const maxCounter = max(items.map((item) => (horizontal ? item.size.h : item.size.w)))
      const primary = totalPrimary + gap * Math.max(0, items.length - 1)
      contentW = horizontal ? primary : maxCounter
      contentH = horizontal ? maxCounter : primary
    }

    path.delete(id)

    const size: Size = {
      w: sizingW === 'hug' ? contentW + pad.left + pad.right : node.w,
      h: sizingH === 'hug' ? contentH + pad.top + pad.bottom : node.h
    }
    cache.set(id, size)
    return size
  }

  /** 把 items 按可用宽度贪心排成若干行（横向换行用） */
  function packRows(
    items: { node: Node; size: Size }[],
    available: number,
    gap: number
  ): { node: Node; size: Size }[][] {
    const rows: { node: Node; size: Size }[][] = []
    let current: { node: Node; size: Size }[] = []
    let used = 0

    for (const item of items) {
      const needed = current.length === 0 ? item.size.w : used + gap + item.size.w
      if (current.length > 0 && needed > available) {
        rows.push(current)
        current = [item]
        used = item.size.w
      } else {
        current.push(item)
        used = needed
      }
    }
    if (current.length > 0) rows.push(current)
    return rows
  }

  /** 自顶向下：把节点摆在 (x, y)，尺寸用 w/h（可能已被父级拉伸）；再递归摆它的子节点。 */
  const place = (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    path: Set<string>
  ): void => {
    const node = graph.nodes[id]
    if (!node || path.has(id)) return

    result[id] = { x, y, w, h }
    path.add(id)

    // 绝对定位的子节点不参与流，按自己的 x/y 摆
    for (const child of absoluteChildren(graph, node)) {
      const size = measure(child.id, new Set())
      const stretch = child.props.layoutAlign === 'stretch'
      place(
        child.id,
        x + child.x,
        y + child.y,
        stretch ? w : size.w,
        size.h,
        path
      )
    }

    if (!isAutoLayout(node)) {
      for (const child of flowChildren(graph, node)) {
        const size = measure(child.id, new Set())
        place(child.id, x + child.x, y + child.y, size.w, size.h, path)
      }
      path.delete(id)
      return
    }

    const props = node.props
    const pad = props.padding
    const gap = props.itemSpacing
    const horizontal = props.layoutMode === 'horizontal'
    const grid = props.layoutMode === 'grid'
    const wrap = horizontal && props.layoutWrap === 'wrap'

    const contentX = x + pad.left
    const contentY = y + pad.top
    const contentW = Math.max(0, w - pad.left - pad.right)
    const contentH = Math.max(0, h - pad.top - pad.bottom)

    const items = flowChildren(graph, node).map((child) => ({
      node: child,
      size: measure(child.id, new Set())
    }))

    const counterAlign = props.counterAxisAlignItems
    const crossOffset = (available: number, size: number): number => {
      if (counterAlign === 'center') return Math.max(0, (available - size) / 2)
      if (counterAlign === 'end') return Math.max(0, available - size)
      return 0
    }

    if (grid || wrap) {
      const rows = grid
        ? chunk(items, Math.max(1, Math.min(props.gridColumns, Math.max(1, items.length))))
        : packRows(items, contentW, gap)

      const columns = grid ? Math.max(1, Math.min(props.gridColumns, Math.max(1, items.length))) : 0
      const hugColumns = grid
        ? Array.from({ length: columns }, (_, column) =>
            max(rows.map((row) => row[column]?.size.w ?? 0))
          )
        : []
      const fixedColumnWidth =
        columns > 0 ? Math.max(0, (contentW - gap * Math.max(0, columns - 1)) / columns) : 0

      let cursorY = contentY
      for (const row of rows) {
        const rowHeight = max(row.map((item) => item.size.h))

        let cursorX = contentX
        row.forEach((item, columnIndex) => {
          // 网格且有确定宽度时，节点撑满整列（"一键整理成网格"的预期行为）
          const columnWidth =
            columns > 0
              ? props.primaryAxisSizing === 'fixed' && grid
                ? fixedColumnWidth
                : (hugColumns[columnIndex] ?? item.size.w)
              : item.size.w

          // 图片保持原始尺寸和比例：网格只负责对齐单元格，不能把图拉宽
          const itemW = grid && item.node.type !== 'asset' ? columnWidth : item.size.w
          const itemH = item.size.h
          const cross = crossOffset(rowHeight, itemH)

          place(item.node.id, cursorX, cursorY + cross, itemW, itemH, path)
          cursorX += (grid ? columnWidth : itemW) + gap
        })

        cursorY += rowHeight + gap
      }

      path.delete(id)
      return
    }

    // ---- 单行：横向或纵向 ----
    const available = horizontal ? contentW : contentH
    const counterAvailable = horizontal ? contentH : contentW

    const gapTotal = gap * Math.max(0, items.length - 1)
    const basePrimary = items.map((item) => (horizontal ? item.size.w : item.size.h))
    const totalBase = sum(basePrimary)
    const extra = Math.max(0, available - gapTotal - totalBase)

    const growTotal = sum(items.map((item) => item.node.props.layoutGrow ?? 0))
    const primarySizes = items.map((item, index) => {
      const grow = item.node.props.layoutGrow ?? 0
      return (basePrimary[index] ?? 0) + (growTotal > 0 ? (extra * grow) / growTotal : 0)
    })

    const totalPrimary = sum(primarySizes) + gapTotal
    const align = props.primaryAxisAlignItems

    let cursor = 0
    let effectiveGap = gap
    if (align === 'center') cursor = Math.max(0, (available - totalPrimary) / 2)
    else if (align === 'end') cursor = Math.max(0, available - totalPrimary)
    else if (align === 'space-between' && items.length > 1) {
      effectiveGap = gap + Math.max(0, available - totalPrimary) / (items.length - 1)
    }

    items.forEach((item, index) => {
      const primarySize = primarySizes[index] ?? 0
      const stretch = item.node.props.layoutAlign === 'stretch'
      const counterSize = stretch
        ? counterAvailable
        : horizontal
          ? item.size.h
          : item.size.w
      const cross = stretch ? 0 : crossOffset(counterAvailable, counterSize)

      const childX = horizontal ? contentX + cursor : contentX + cross
      const childY = horizontal ? contentY + cross : contentY + cursor
      const childW = horizontal ? primarySize : counterSize
      const childH = horizontal ? counterSize : primarySize

      place(item.node.id, childX, childY, childW, childH, path)
      cursor += primarySize + effectiveGap
    })

    path.delete(id)
  }

  for (const rootId of graph.rootIds) {
    const root = graph.nodes[rootId]
    if (!root) continue
    // 顶层节点的 x/y 是相对画布原点的位置
    const size = measure(rootId, new Set())
    place(rootId, root.x, root.y, size.w, size.h, new Set())
  }

  return result
}
