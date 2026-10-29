import type { Command } from './command'
import { createGroupNode, type Node, type ProjectGraph } from './node'
import { descendantsOf } from './tree'

/**
 * 图层树上的编辑命令（路线图 D4a.1 / D4a.5）。
 *
 * 全部是**纯函数**：收图、返新图，不改入参。每条命令自带反向操作，
 * 因此撤销重做对新命令自动生效（§1.2：D4a/D4b 只往里注册新命令，不动通路）。
 */

/* ---------- 小工具 ---------- */

function withoutId(ids: string[], id: string): string[] {
  return ids.filter((existing) => existing !== id)
}

/** 插到指定位置；越界就夹到两端。 */
function insertAt(ids: string[], id: string, index: number): string[] {
  const next = withoutId(ids, id)
  const at = Math.max(0, Math.min(index, next.length))
  return [...next.slice(0, at), id, ...next.slice(at)]
}

function childIdsOf(graph: ProjectGraph, parentId: string | null): string[] {
  if (parentId === null) return graph.rootIds
  return graph.nodes[parentId]?.childIds ?? []
}

function withChildIds(
  graph: ProjectGraph,
  parentId: string | null,
  childIds: string[]
): ProjectGraph {
  if (parentId === null) return { ...graph, rootIds: childIds }
  const parent = graph.nodes[parentId]
  if (!parent) return graph
  return { ...graph, nodes: { ...graph.nodes, [parentId]: { ...parent, childIds } } }
}

/** 把子节点挂到新父节点下；同时同步子节点自己的 parentId。 */
function attach(
  graph: ProjectGraph,
  nodeId: string,
  parentId: string | null,
  index: number
): ProjectGraph {
  const node = graph.nodes[nodeId]
  if (!node) return graph
  const next = withChildIds(graph, parentId, insertAt(childIdsOf(graph, parentId), nodeId, index))
  return {
    ...next,
    nodes: { ...next.nodes, [nodeId]: { ...node, parentId } }
  }
}

function detach(graph: ProjectGraph, nodeId: string): ProjectGraph {
  const node = graph.nodes[nodeId]
  if (!node) return graph
  return withChildIds(graph, node.parentId, withoutId(childIdsOf(graph, node.parentId), nodeId))
}

/* ---------- 单项编辑 ---------- */

export function createRenameNodeCommand(nodeId: string, name: string): Command {
  const set = (graph: ProjectGraph, value: string): ProjectGraph => {
    const node = graph.nodes[nodeId]
    if (!node) return graph
    return { ...graph, nodes: { ...graph.nodes, [nodeId]: { ...node, name: value } } }
  }

  // 旧名字在执行时才知道，记下来供撤销
  let previous: string | null = null

  return {
    name: 'rename-node',
    apply(graph) {
      const node = graph.nodes[nodeId]
      if (!node) return graph
      previous = node.name
      return set(graph, name)
    },
    revert(graph) {
      return previous === null ? graph : set(graph, previous)
    }
  }
}

export function createSetNodeFlagsCommand(
  nodeId: string,
  flags: Partial<Pick<Node, 'visible' | 'locked'>>
): Command {
  const set = (graph: ProjectGraph, value: Partial<Pick<Node, 'visible' | 'locked'>>): ProjectGraph => {
    const node = graph.nodes[nodeId]
    if (!node) return graph
    return { ...graph, nodes: { ...graph.nodes, [nodeId]: { ...node, ...value } } }
  }

  let previous: Partial<Pick<Node, 'visible' | 'locked'>> | null = null

  return {
    name: 'set-node-flags',
    apply(graph) {
      const node = graph.nodes[nodeId]
      if (!node) return graph
      previous = { visible: node.visible, locked: node.locked }
      return set(graph, flags)
    },
    revert(graph) {
      return previous === null ? graph : set(graph, previous)
    }
  }
}

/* ---------- 顺序与层级 ---------- */

/**
 * 同层内拖动排序。`parentId` 为 null 表示顶层。
 * 记住原来的位置就能撤销，不需要额外上下文。
 */
export function createReorderCommand(
  parentId: string | null,
  fromIndex: number,
  toIndex: number
): Command {
  const move = (graph: ProjectGraph, from: number, to: number): ProjectGraph => {
    const ids = childIdsOf(graph, parentId)
    const id = ids[from]
    if (id === undefined) return graph
    return withChildIds(graph, parentId, insertAt(ids, id, to))
  }

  return {
    name: 'reorder-node',
    apply: (graph) => move(graph, fromIndex, toIndex),
    revert: (graph) => move(graph, toIndex, fromIndex)
  }
}

export type ReorderMode = 'forward' | 'backward' | 'front' | 'back'

/**
 * 图层顺序的整体调整（图层面板底部的上移/下移/置顶/置底按钮）。
 *
 * 选中的节点可能来自不同父级，所以**按父级分组**各自调整，互不干扰。
 * 绘制顺序 = 数组顺序，越靠后越在前（Figma 的"上移"就是往后挪一格）。
 * 用快照撤销，一次操作（哪怕跨多个父级）只占历史里一步。
 */
export function createReorderNodesCommand(nodeIds: string[], mode: ReorderMode): Command {
  let before: { nodes: ProjectGraph['nodes']; rootIds: string[] } | null = null

  const reorder = (graph: ProjectGraph): ProjectGraph => {
    const present = nodeIds.filter((id) => graph.nodes[id])
    if (present.length === 0) return graph

    const byParent = new Map<string | null, Set<string>>()
    for (const id of present) {
      const parentId = graph.nodes[id]!.parentId
      const bucket = byParent.get(parentId) ?? new Set<string>()
      bucket.add(id)
      byParent.set(parentId, bucket)
    }

    let next = graph
    for (const [parentId, selected] of byParent) {
      const list = childIdsOf(next, parentId)
      let ordered = [...list]

      if (mode === 'front' || mode === 'back') {
        const picked = ordered.filter((id) => selected.has(id))
        const rest = ordered.filter((id) => !selected.has(id))
        ordered = mode === 'front' ? [...rest, ...picked] : [...picked, ...rest]
      } else if (mode === 'forward') {
        // 从上往下扫，被选中的往后挪一格（后面那个也被选中就不动，整块一起走）
        for (let i = ordered.length - 2; i >= 0; i--) {
          if (selected.has(ordered[i]!) && !selected.has(ordered[i + 1]!)) {
            ;[ordered[i], ordered[i + 1]] = [ordered[i + 1]!, ordered[i]!]
          }
        }
      } else {
        for (let i = 1; i < ordered.length; i++) {
          if (selected.has(ordered[i]!) && !selected.has(ordered[i - 1]!)) {
            ;[ordered[i - 1], ordered[i]] = [ordered[i]!, ordered[i - 1]!]
          }
        }
      }

      next = withChildIds(next, parentId, ordered)
    }
    return next
  }

  return {
    name: `reorder-nodes:${mode}`,
    apply(graph) {
      before = { nodes: graph.nodes, rootIds: graph.rootIds }
      return reorder(graph)
    },
    revert(graph) {
      if (!before) return graph
      return { ...graph, nodes: before.nodes, rootIds: before.rootIds }
    }
  }
}

/**
 * 换父节点（同时决定新位置）。用于把节点拖进/拖出容器。
 * 不允许把节点拖进自己的子孙里——那会把树变成环。
 */
export function createMoveNodeCommand(
  nodeId: string,
  newParentId: string | null,
  index: number
): Command {
  const move = (
    graph: ProjectGraph,
    targetParentId: string | null,
    targetIndex: number
  ): ProjectGraph => {
    const node = graph.nodes[nodeId]
    if (!node) return graph
    if (targetParentId !== null) {
      if (targetParentId === nodeId) return graph
      if (descendantsOf(graph, nodeId).includes(targetParentId)) return graph
    }

    // 换父时**保持画布上的位置不动**（Figma 也是这样）：先记下绝对坐标，
    // 换完再换算成相对新父级的偏移。只在同层排序时两者相等，等于不变。
    const absolute = {
      x: absoluteOriginOf(graph, node.parentId).x + node.x,
      y: absoluteOriginOf(graph, node.parentId).y + node.y
    }
    const targetOrigin = absoluteOriginOf(graph, targetParentId)

    let next = attach(detach(graph, nodeId), nodeId, targetParentId, targetIndex)
    const moved = next.nodes[nodeId]
    if (moved) {
      next = {
        ...next,
        nodes: {
          ...next.nodes,
          [nodeId]: { ...moved, x: absolute.x - targetOrigin.x, y: absolute.y - targetOrigin.y }
        }
      }
    }
    return next
  }

  // 原来的位置在执行时才知道，记下来供撤销用
  let origin: { parentId: string | null; index: number } | null = null

  return {
    name: 'move-node',
    apply(graph) {
      const node = graph.nodes[nodeId]
      if (!node) return graph
      origin = { parentId: node.parentId, index: childIdsOf(graph, node.parentId).indexOf(nodeId) }
      return move(graph, newParentId, index)
    },
    revert(graph) {
      if (!origin) return graph
      return move(graph, origin.parentId, origin.index)
    }
  }
}

/**
 * 一次把多个节点换到同一个父级（多选拖进自动布局容器）。
 *
 * 和单选版一样保持画布上的绝对位置；自动布局容器随后会按自己的规则重排。
 * 用快照撤销，整次多选移动只占历史里一步。
 */
export function createMoveNodesToParentCommand(
  nodeIds: string[],
  newParentId: string | null,
  index: number
): Command {
  const ordered = nodeIds.filter((id, position) => nodeIds.indexOf(id) === position)
  let before: { nodes: ProjectGraph['nodes']; rootIds: string[] } | null = null

  const move = (graph: ProjectGraph): ProjectGraph => {
    const valid = ordered.filter((id) => {
      if (!graph.nodes[id]) return false
      if (newParentId === null) return true
      if (newParentId === id) return false
      return !descendantsOf(graph, id).includes(newParentId)
    })
    if (valid.length === 0) return graph

    const absolutes = new Map<string, { x: number; y: number }>()
    for (const id of valid) {
      const node = graph.nodes[id]!
      const origin = absoluteOriginOf(graph, node.parentId)
      absolutes.set(id, { x: origin.x + node.x, y: origin.y + node.y })
    }

    let next = graph
    for (const id of valid) next = detach(next, id)
    const targetOrigin = absoluteOriginOf(next, newParentId)

    let at = index
    for (const id of valid) {
      next = attach(next, id, newParentId, at)
      at += 1
      const node = next.nodes[id]
      const absolute = absolutes.get(id)
      if (!node || !absolute) continue
      next = {
        ...next,
        nodes: {
          ...next.nodes,
          [id]: { ...node, x: absolute.x - targetOrigin.x, y: absolute.y - targetOrigin.y }
        }
      }
    }
    return next
  }

  return {
    name: 'move-nodes-to-parent',
    apply(graph) {
      before = { nodes: graph.nodes, rootIds: graph.rootIds }
      return move(graph)
    },
    revert(graph) {
      return before ? { ...graph, nodes: before.nodes, rootIds: before.rootIds } : graph
    }
  }
}

/* ---------- 删除 ---------- */

/** 删掉这些节点**连同它们的子孙**，并从父节点的顺序里摘掉。 */
export function createRemoveNodesCommand(nodeIds: string[]): Command {
  const snapshotOf = (graph: ProjectGraph): { nodes: ProjectGraph['nodes']; rootIds: string[] } => ({
    nodes: graph.nodes,
    rootIds: graph.rootIds
  })

  let before: { nodes: ProjectGraph['nodes']; rootIds: string[] } | null = null

  const remove = (graph: ProjectGraph): ProjectGraph => {
    const doomed = new Set<string>()
    for (const id of nodeIds) {
      if (!graph.nodes[id]) continue
      doomed.add(id)
      for (const child of descendantsOf(graph, id)) doomed.add(child)
    }
    if (doomed.size === 0) return graph

    const nodes: ProjectGraph['nodes'] = {}
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (doomed.has(id)) continue
      nodes[id] = node
    }

    const stripFrom = (ids: string[]): string[] => ids.filter((id) => !doomed.has(id))
    const next: ProjectGraph = {
      ...graph,
      nodes,
      rootIds: stripFrom(graph.rootIds)
    }

    // 父节点的 childIds 也要清掉
    for (const [id, node] of Object.entries(nodes)) {
      const cleaned = stripFrom(node.childIds)
      if (cleaned.length !== node.childIds.length) {
        nodes[id] = { ...node, childIds: cleaned }
      }
    }

    return next
  }

  return {
    name: 'remove-nodes',
    apply(graph) {
      before = snapshotOf(graph)
      return remove(graph)
    },
    revert(graph) {
      if (!before) return graph
      return { ...graph, nodes: before.nodes, rootIds: before.rootIds }
    }
  }
}

/* ---------- 编组 / 解组（D4a.5） ---------- */

export interface GroupOptions {
  groupId: string
  nodeIds: string[]
  name?: string
}

/**
 * 把选中的节点打进一个组。
 * 组插在**这些节点原本占据的最靠后那格**（保持它在图层里的大致位置），
 * 节点之间的相对顺序不变。选中节点可以来自不同父级。
 */
export function createGroupCommand({ groupId, nodeIds, name = '编组' }: GroupOptions): Command {
  const selected = nodeIds.filter((id, index) => nodeIds.indexOf(id) === index)
  let before: { nodes: ProjectGraph['nodes']; rootIds: string[] } | null = null

  const group = (graph: ProjectGraph): ProjectGraph => {
    const present = selected.filter((id) => graph.nodes[id])
    if (present.length === 0) return graph
    if (graph.nodes[groupId]) return graph

    // 参照父节点 = 第一个选中节点的父节点；组插在它原来的位置
    const anchor = graph.nodes[present[0]!]
    if (!anchor) return graph
    const parentId = anchor.parentId
    const parentOrder = childIdsOf(graph, parentId)
    const insertionIndex = Math.max(
      0,
      ...present.map((id) => {
        const at = parentOrder.indexOf(id)
        return at === -1 ? 0 : at
      })
    )

    // 先把选中节点按原顺序取出来，再统一挂到组下
    const inOrder = parentOrder.filter((id) => present.includes(id))
    const ordered = [...inOrder, ...present.filter((id) => !inOrder.includes(id))]

    let next = graph
    for (const id of ordered) next = detach(next, id)

    const groupNode = {
      ...createGroupNode({ id: groupId, projectId: graph.projectId, name }),
      parentId
    } as Node

    next = {
      ...next,
      nodes: { ...next.nodes, [groupId]: { ...groupNode, childIds: ordered } }
    }

    for (const id of ordered) {
      const node = next.nodes[id]
      if (node) next.nodes[id] = { ...node, parentId: groupId }
    }

    next = withChildIds(next, parentId, insertAt(childIdsOf(next, parentId), groupId, insertionIndex))

    return recomputeGroupBounds(next, groupId)
  }

  return {
    name: 'group-nodes',
    apply(graph) {
      before = { nodes: graph.nodes, rootIds: graph.rootIds }
      return group(graph)
    },
    revert(graph) {
      if (!before) return graph
      return { ...graph, nodes: before.nodes, rootIds: before.rootIds }
    }
  }
}

/**
 * 解组：子节点上移一层，占据组原来的位置；组本身消失。
 *
 * 子节点原来是**相对这个容器**定位的，改挂到上一层时要补上容器自己的偏移——
 * 否则容器不在画布原点时，一解组里面的东西就整体平移一块（绝对位置必须纹丝不动）。
 */
export function createUngroupCommand(groupId: string): Command {
  let before: { nodes: ProjectGraph['nodes']; rootIds: string[] } | null = null

  const ungroup = (graph: ProjectGraph): ProjectGraph => {
    const groupNode = graph.nodes[groupId]
    if (!groupNode) return graph

    const parentId = groupNode.parentId
    const parentOrder = childIdsOf(graph, parentId)
    const at = parentOrder.indexOf(groupId)
    const children = groupNode.childIds.filter((id) => graph.nodes[id])

    const nodes = { ...graph.nodes }
    delete nodes[groupId]
    for (const id of children) {
      const child = nodes[id]
      if (!child) continue
      nodes[id] = {
        ...child,
        parentId,
        x: child.x + groupNode.x,
        y: child.y + groupNode.y
      }
    }

    const withoutGroup = parentOrder.filter((id) => id !== groupId)
    const insertIndex = at === -1 ? withoutGroup.length : at
    const merged = [
      ...withoutGroup.slice(0, insertIndex),
      ...children,
      ...withoutGroup.slice(insertIndex)
    ]

    return withChildIds({ ...graph, nodes }, parentId, merged)
  }

  return {
    name: 'ungroup-nodes',
    apply(graph) {
      before = { nodes: graph.nodes, rootIds: graph.rootIds }
      return ungroup(graph)
    },
    revert(graph) {
      if (!before) return graph
      return { ...graph, nodes: before.nodes, rootIds: before.rootIds }
    }
  }
}

/** 某一层的原点在画布上的绝对位置（累加所有祖先的偏移）。 */
export function absoluteOriginOf(graph: ProjectGraph, parentId: string | null): { x: number; y: number } {
  let x = 0
  let y = 0
  let current = parentId
  const seen = new Set<string>()

  while (current && !seen.has(current)) {
    seen.add(current)
    const node = graph.nodes[current]
    if (!node) break
    x += node.x
    y += node.y
    current = node.parentId
  }
  return { x, y }
}

/**
 * 编组的包围盒 = 所有子节点包围盒的并集。
 * 选中节点可能来自不同父级（坐标基准不同），所以先换算成画布绝对坐标再取并集，
 * 最后把组的位置换回"相对组的父级"，子节点坐标换回"相对组"。
 */
function recomputeGroupBounds(graph: ProjectGraph, groupId: string): ProjectGraph {
  const groupNode = graph.nodes[groupId]
  if (!groupNode) return graph

  const children = groupNode.childIds
    .map((id) => graph.nodes[id])
    .filter((node): node is Node => Boolean(node))

  const nodes = { ...graph.nodes }

  if (children.length === 0) {
    nodes[groupId] = { ...groupNode, w: 0, h: 0 }
    return { ...graph, nodes }
  }

  const boxes = children.map((child) => {
    const origin = absoluteOriginOf(graph, child.parentId)
    return { child, x: origin.x + child.x, y: origin.y + child.y }
  })

  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.child.w))
  const bottom = Math.max(...boxes.map((box) => box.y + box.child.h))

  const groupOrigin = absoluteOriginOf(graph, groupNode.parentId)
  nodes[groupId] = {
    ...groupNode,
    x: left - groupOrigin.x,
    y: top - groupOrigin.y,
    w: right - left,
    h: bottom - top
  }
  for (const box of boxes) {
    nodes[box.child.id] = { ...box.child, x: box.x - left, y: box.y - top }
  }

  return { ...graph, nodes }
}
