import { layout, type LayoutBox } from './layout'
import type { Node, ProjectGraph } from './node'

/**
 * 把对象模型投影成"渲染树"（路线图 D2.3 / D2.11）。
 *
 * 渲染器只认这个结构，**不认识数据库、也不碰命令**：模型是唯一事实来源，这里是它的投影。
 * 每个条目除了自己的绝对坐标，还带**相对父节点的偏移**——渲染时按父子嵌套摆容器，
 * 于是"移动父节点、子节点跟着走"是结构自带的，不需要额外同步代码（D2.11）。
 *
 * 纯函数，可单测。
 */

export interface SceneItem {
  node: Node
  /** 画布绝对坐标与尺寸 */
  absX: number
  absY: number
  w: number
  h: number
  /** 相对父节点的偏移，用来摆嵌套容器 */
  x: number
  y: number
  children: SceneItem[]
}

function boxOf(boxes: Record<string, LayoutBox>, node: Node): LayoutBox {
  return boxes[node.id] ?? { x: node.x, y: node.y, w: node.w, h: node.h }
}

/** 若干条目的共同包围盒。 */
function unionBox(items: SceneItem[]): LayoutBox {
  const left = Math.min(...items.map((item) => item.absX))
  const top = Math.min(...items.map((item) => item.absY))
  const right = Math.max(...items.map((item) => item.absX + item.w))
  const bottom = Math.max(...items.map((item) => item.absY + item.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * 顶层节点按 `rootIds` 的绘制顺序返回；子节点按各自 `childIds` 顺序嵌套。
 *
 * **组没有自己的尺寸**（Figma 的规矩）：它的边框永远等于**内容的并集**，而不是存在
 * 模型里的 w/h——动一下组里的图、或把图移进移出组，蓝框都会跟着内容收紧/张开。
 * 这里在**投影层**算，模型不动，所以命令与撤销重做完全不受影响。
 * 组对齐到内容之后，直接子节点的**相对坐标要反向挪回去**，它们在画布上的绝对位置才纹丝不动。
 */
export function buildScene(graph: ProjectGraph): SceneItem[] {
  const boxes = layout(graph)
  const seen = new Set<string>()

  const build = (id: string, parentAbsX: number, parentAbsY: number): SceneItem | null => {
    const node = graph.nodes[id]
    // 数据意外成环时直接跳过，不无限递归
    if (!node || seen.has(id)) return null
    seen.add(id)

    const box = boxOf(boxes, node)
    const children = node.childIds.flatMap((childId) => {
      const child = build(childId, box.x, box.y)
      return child ? [child] : []
    })

    // 空组没有内容可依，保留自己的盒子
    const fit = node.type === 'group' && children.length > 0 ? unionBox(children) : null

    const item: SceneItem = {
      node,
      absX: fit ? fit.x : box.x,
      absY: fit ? fit.y : box.y,
      w: fit ? fit.w : box.w,
      h: fit ? fit.h : box.h,
      x: (fit ? fit.x : box.x) - parentAbsX,
      y: (fit ? fit.y : box.y) - parentAbsY,
      children: fit
        ? children.map((child) => ({ ...child, x: child.absX - fit.x, y: child.absY - fit.y }))
        : children
    }
    seen.delete(id)
    return item
  }

  return graph.rootIds.flatMap((id) => {
    const item = build(id, 0, 0)
    return item ? [item] : []
  })
}

/**
 * 视口裁剪：只留下看得到的节点（D2.10）。
 *
 * 一个节点**自己**跑到屏幕外不代表它的子孙也在外面（子节点可以摆到父节点框外），
 * 所以只要子孙里有可见的，这一层就得留着。返回的是新的树，输入不动。
 */
export function cullScene(items: SceneItem[], view: { x: number; y: number; w: number; h: number }): SceneItem[] {
  const intersects = (item: SceneItem): boolean =>
    !(
      item.absX + item.w < view.x ||
      view.x + view.w < item.absX ||
      item.absY + item.h < view.y ||
      view.y + view.h < item.absY
    )

  const walk = (list: SceneItem[]): SceneItem[] => {
    const kept: SceneItem[] = []
    for (const item of list) {
      const children = walk(item.children)
      if (intersects(item) || children.length > 0) kept.push({ ...item, children })
    }
    return kept
  }
  return walk(items)
}

/** 画布内容的包围盒；空画布返回 null。给"适合内容"按钮用。 */
export function contentBounds(items: SceneItem[]): { x: number; y: number; w: number; h: number } | null {
  const flat: SceneItem[] = []
  const walk = (list: SceneItem[]): void => {
    for (const item of list) {
      flat.push(item)
      walk(item.children)
    }
  }
  walk(items)

  const visible = flat.filter((item) => item.node.visible)
  if (visible.length === 0) return null

  const left = Math.min(...visible.map((item) => item.absX))
  const top = Math.min(...visible.map((item) => item.absY))
  const right = Math.max(...visible.map((item) => item.absX + item.w))
  const bottom = Math.max(...visible.map((item) => item.absY + item.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}
