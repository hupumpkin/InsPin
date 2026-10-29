import type { Command } from './command'
import type { AutoLayoutProps, ChildLayoutProps, Node, ProjectGraph } from './node'
import { createFrameNode } from './node'
import { autoLayoutPresetFor } from './auto-layout'
import { layout } from './layout'
import { absoluteOriginOf, createUngroupCommand } from './tree-commands'

/**
 * 自动布局相关的命令（路线图 D4b.5 / D4b.6 / D4b.9）。
 *
 * 求解本身在 `layout.ts` 里跑；这里只负责**改模型**——套上/解除布局、改参数。
 * 全是纯函数命令、自带反向操作，因此每一次调整都进操作历史，⌘Z 能逐步回退（D4b.9）。
 */

function childIdsOf(graph: ProjectGraph, parentId: string | null): string[] {
  if (parentId === null) return graph.rootIds
  return graph.nodes[parentId]?.childIds ?? []
}

function withChildIds(graph: ProjectGraph, parentId: string | null, childIds: string[]): ProjectGraph {
  if (parentId === null) return { ...graph, rootIds: childIds }
  const parent = graph.nodes[parentId]
  if (!parent) return graph
  return { ...graph, nodes: { ...graph.nodes, [parentId]: { ...parent, childIds } } }
}

function detach(graph: ProjectGraph, nodeId: string): ProjectGraph {
  const node = graph.nodes[nodeId]
  if (!node) return graph
  return withChildIds(
    graph,
    node.parentId,
    childIdsOf(graph, node.parentId).filter((id) => id !== nodeId)
  )
}

function insertAt(ids: string[], id: string, index: number): string[] {
  const next = ids.filter((existing) => existing !== id)
  const at = Math.max(0, Math.min(index, next.length))
  return [...next.slice(0, at), id, ...next.slice(at)]
}

export interface WrapOptions {
  frameId: string
  /** 要套上布局的模式；默认横向 */
  mode?: AutoLayoutProps['layoutMode']
  name?: string
}

/**
 * 把选中的若干节点装进一个**自动布局容器**（⇧A / "一键整理成网格"）。
 *
 * 和编组类似，但产出的是带布局参数的 frame；容器的包围盒取选中节点的并集，
 * 子节点坐标换算成相对容器。选中节点可以来自不同父级（坐标基准不同），
 * 所以先换算成画布绝对坐标再算并集。
 */
export function createWrapInAutoLayoutCommand(
  graph: ProjectGraph,
  nodeIds: string[],
  options: WrapOptions
): Command {
  const selected = nodeIds.filter((id, index) => nodeIds.indexOf(id) === index)
  const before: { nodes: ProjectGraph['nodes']; rootIds: string[] } = {
    nodes: graph.nodes,
    rootIds: graph.rootIds
  }

  const wrap = (current: ProjectGraph): ProjectGraph => {
    const present = selected.filter((id) => current.nodes[id])
    if (present.length === 0) return current
    if (current.nodes[options.frameId]) return current

    const anchor = current.nodes[present[0]!]
    if (!anchor) return current
    const parentId = anchor.parentId
    const parentOrder = childIdsOf(current, parentId)
    const insertionIndex = Math.max(
      0,
      ...present.map((id) => {
        const at = parentOrder.indexOf(id)
        return at === -1 ? 0 : at
      })
    )

    // 先按原顺序取出选中节点，再统一换算绝对坐标
    const inOrder = parentOrder.filter((id) => present.includes(id))
    const ordered = [...inOrder, ...present.filter((id) => !inOrder.includes(id))]
    const boxes = ordered.map((id) => {
      const node = current.nodes[id]!
      const origin = absoluteOriginOf(current, node.parentId)
      return { id, node, x: origin.x + node.x, y: origin.y + node.y }
    })

    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.node.w))
    const bottom = Math.max(...boxes.map((box) => box.y + box.node.h))

    let next = current
    for (const id of ordered) next = detach(next, id)

    const preset = autoLayoutPresetFor(options.mode ?? 'horizontal', ordered.length)
    // 框**落在被套住的那些对象的左上角**：不给 x/y 的话默认 0，整片内容会被搬到画布原点去
    const parentOrigin = absoluteOriginOf(current, parentId)
    const frame = createFrameNode({
      id: options.frameId,
      projectId: current.projectId,
      name: options.name ?? '自动布局',
      x: left - parentOrigin.x,
      y: top - parentOrigin.y,
      w: Math.max(1, right - left),
      h: Math.max(1, bottom - top),
      props: preset
    })

    const nodes: ProjectGraph['nodes'] = { ...next.nodes }
    nodes[options.frameId] = { ...frame, parentId, childIds: ordered }
    for (const box of boxes) {
      const child = nodes[box.id]
      if (!child) continue
      // 展开一个联合类型的 Node 后 TS 会丢掉可辨识联合，这里显式收回来
      nodes[box.id] = {
        ...child,
        parentId: options.frameId,
        x: box.x - left,
        y: box.y - top
      } as Node
    }

    next = { ...next, nodes }
    next = withChildIds(next, parentId, insertAt(childIdsOf(next, parentId), options.frameId, insertionIndex))
    return next
  }

  return {
    name: 'wrap-in-auto-layout',
    apply: wrap,
    revert(current) {
      return { ...current, nodes: before.nodes, rootIds: before.rootIds }
    }
  }
}

/** 改某个容器的自动布局参数（方向/间距/内边距/对齐/列数/尺寸/换行）。 */
export function createSetAutoLayoutCommand(
  nodeId: string,
  patch: Partial<AutoLayoutProps>
): Command {
  const write = (current: ProjectGraph, value: Partial<AutoLayoutProps>): ProjectGraph => {
    const node = current.nodes[nodeId]
    if (!node || node.type !== 'frame') return current
    return {
      ...current,
      nodes: { ...current.nodes, [nodeId]: { ...node, props: { ...node.props, ...value } } }
    }
  }

  let previous: Partial<AutoLayoutProps> | null = null

  return {
    name: 'set-auto-layout',
    apply(current) {
      const node = current.nodes[nodeId]
      if (!node || node.type !== 'frame') return current
      previous = {}
      for (const key of Object.keys(patch) as (keyof AutoLayoutProps)[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(previous as any)[key] = (node.props as any)[key]
      }
      return write(current, patch)
    },
    revert(current) {
      return previous === null ? current : write(current, previous)
    }
  }
}

/** 改**子节点侧**的布局参数（撑满 / 占份数 / 绝对定位）。 */
export function createSetChildLayoutCommand(
  nodeId: string,
  patch: Partial<ChildLayoutProps>
): Command {
  const write = (current: ProjectGraph, value: Partial<ChildLayoutProps>): ProjectGraph => {
    const node = current.nodes[nodeId]
    if (!node) return current
    return {
      ...current,
      nodes: { ...current.nodes, [nodeId]: { ...node, props: { ...node.props, ...value } } as Node }
    }
  }

  let previous: Partial<ChildLayoutProps> | null = null

  return {
    name: 'set-child-layout',
    apply(current) {
      const node = current.nodes[nodeId]
      if (!node) return current
      previous = {
        layoutAlign: node.props.layoutAlign,
        layoutGrow: node.props.layoutGrow,
        layoutPositioning: node.props.layoutPositioning
      }
      return write(current, patch)
    },
    revert(current) {
      return previous === null ? current : write(current, previous)
    }
  }
}

/**
 * 解除自动布局：**连同套出来的那个框一起解散**，每个孩子停在它**当前看得见的位置**。
 *
 * 两件事都得做：
 *   1. **先冻住位置**——框里的排布是求解器算出来的（内边距、间距），不是节点存的 x/y。
 *      不先写回去就解散，东西会弹回它们原来的坐标、整片跳。
 *   2. **再解散框**——自动布局本来就是 ⇧A 临时套上去的一层，解除就该回到套之前的样子；
 *      只把 layoutMode 抹成 none 会留下一个没人要的空框，还得再解一次组。
 *
 * 合成一条命令，⌘Z 一下退回原样。
 */
export function createRemoveAutoLayoutCommand(nodeId: string): Command {
  const dissolve = createUngroupCommand(nodeId)
  let before: { nodes: ProjectGraph['nodes']; rootIds: string[] } | null = null

  /** 把求解出来的绝对位置写回子节点（换算成相对框的坐标）。 */
  const freeze = (graph: ProjectGraph): ProjectGraph => {
    const frame = graph.nodes[nodeId]
    if (!frame) return graph

    const solved = layout(graph)
    const origin = absoluteOriginOf(graph, frame.parentId)
    const frameAbsX = origin.x + frame.x
    const frameAbsY = origin.y + frame.y

    const nodes = { ...graph.nodes }
    for (const id of frame.childIds) {
      const child = nodes[id]
      const box = solved[id]
      if (!child || !box) continue
      nodes[id] = { ...child, x: box.x - frameAbsX, y: box.y - frameAbsY }
    }
    return { ...graph, nodes }
  }

  return {
    name: 'remove-auto-layout',
    apply(graph) {
      before = { nodes: graph.nodes, rootIds: graph.rootIds }
      return dissolve.apply(freeze(graph))
    },
    revert(graph) {
      if (!before) return graph
      return { ...graph, nodes: before.nodes, rootIds: before.rootIds }
    }
  }
}
