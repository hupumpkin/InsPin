import type { AutoLayoutProps, LayoutMode, Node, ProjectGraph } from './node'
import { defaultAutoLayoutProps } from './node'

/**
 * 自动布局的纯逻辑（路线图 D4b.5–D4b.10 里不碰界面的部分）。
 *
 * 求解器在 `layout.ts`（早先的批次已完成）；这里只放"套上布局时的默认值"和
 * "拖进容器该插到第几个"这类判断，纯函数、可单测。
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 套上自动布局时的默认参数（横向、间距与内边距各 16、尺寸贴合内容）。 */
export function defaultAutoLayoutPreset(mode: LayoutMode = 'horizontal'): AutoLayoutProps {
  return {
    ...defaultAutoLayoutProps(),
    layoutMode: mode,
    itemSpacing: 16,
    padding: { top: 16, right: 16, bottom: 16, left: 16 },
    // 网格也贴合内容：图片保持原尺寸，框由内容撑开，不能为了均分列宽去拉伸图片
    primaryAxisSizing: 'hug',
    counterAxisSizing: 'hug',
    gridColumns: 2
  }
}

/** 一键整理成网格时，列数按数量的平方根取整（2 张→2 列，9 张→3 列）。 */
export function gridColumnsFor(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))))
}

/** 当前列数下实际有几横排，工具条把列数换算成用户能直接理解的“横排数量”。 */
export function gridRowsFor(count: number, columns: number): number {
  return Math.max(1, Math.ceil(Math.max(1, count) / Math.max(1, columns)))
}

/** 用户想要 N 个横排时，等价于每排几列；排不满时最多就是 N 排。 */
export function gridColumnsForRows(count: number, rows: number): number {
  return Math.max(1, Math.ceil(Math.max(1, count) / Math.max(1, rows)))
}

/** 多选后套上自动布局用的参数；网格模式带上合适的列数。 */
export function autoLayoutPresetFor(mode: LayoutMode, count: number): AutoLayoutProps {
  const preset = defaultAutoLayoutPreset(mode)
  return mode === 'grid' ? { ...preset, gridColumns: gridColumnsFor(count) } : preset
}

/**
 * 拖进自动布局容器时，"该插到第几个"。
 *
 * 规则和 Figma 一致：按落点与每个子节点**中心**的比较，落在谁之前就插在谁前面。
 * 网格按"行优先"比（先比行，再比列）。
 */
export function insertionIndex(mode: LayoutMode, children: Box[], point: { x: number; y: number }): number {
  if (children.length === 0) return 0

  if (mode === 'vertical') {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      if (point.y < child.y + child.h / 2) return i
    }
    return children.length
  }

  if (mode === 'grid') {
    // 行优先：先按行分，再在行内按 x 比
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      const centerY = child.y + child.h / 2
      const sameRowAbove = point.y < centerY
      const anchored = Math.abs(point.y - centerY) <= child.h / 2
      if (sameRowAbove || anchored) {
        if (point.x < child.x + child.w / 2) return i
        // 落在这个子节点的右半边：继续往后比，但若下一个已在下一行就停在这里
        const next = children[i + 1]
        if (!next || next.y > child.y + child.h / 2) return i + 1
      } else if (point.y < child.y + child.h) {
        return i
      }
    }
    return children.length
  }

  // 横向
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    if (point.x < child.x + child.w / 2) return i
  }
  return children.length
}

/** 节点是不是"自动布局容器"（带布局的 frame）。 */
export function isAutoLayoutContainer(node: Node | null | undefined): boolean {
  return Boolean(node && node.type === 'frame' && node.props.layoutMode !== 'none')
}

/** 容器里参与流的子节点 id（绝对定位的除外）。 */
export function flowChildIds(graph: ProjectGraph, containerId: string): string[] {
  const container = graph.nodes[containerId]
  if (!container) return []
  return container.childIds.filter((id) => {
    const child = graph.nodes[id]
    return child ? child.props.layoutPositioning !== 'absolute' : false
  })
}
