import type { Node, ProjectGraph } from './node'

/**
 * 图层树查询（路线图 D4a.1 的读那一半）。
 *
 * 顺序只认一处：节点自己的 `childIds`（顶层看 `rootIds`）。
 * 这些函数都是**只读**的，不改图。
 */

export function getNode(graph: ProjectGraph, id: string): Node | null {
  return graph.nodes[id] ?? null
}

/** 某一层的节点，按绘制顺序（= 图层顺序） */
export function childrenOf(graph: ProjectGraph, parentId: string | null): Node[] {
  const ids = parentId === null ? graph.rootIds : (graph.nodes[parentId]?.childIds ?? [])
  return ids.map((id) => graph.nodes[id]).filter((node): node is Node => Boolean(node))
}

export function rootNodes(graph: ProjectGraph): Node[] {
  return childrenOf(graph, null)
}

export function parentOf(graph: ProjectGraph, id: string): Node | null {
  const parentId = graph.nodes[id]?.parentId
  return parentId ? (graph.nodes[parentId] ?? null) : null
}

export function siblingIndex(graph: ProjectGraph, id: string): number {
  const node = graph.nodes[id]
  if (!node) return -1
  const ids = node.parentId === null ? graph.rootIds : (graph.nodes[node.parentId]?.childIds ?? [])
  return ids.indexOf(id)
}

/** 从父到根，不含自身 */
export function ancestorsOf(graph: ProjectGraph, id: string): Node[] {
  const chain: Node[] = []
  const seen = new Set<string>([id])
  let current = parentOf(graph, id)

  while (current) {
    if (seen.has(current.id)) break // 数据成环时及时收手
    seen.add(current.id)
    chain.push(current)
    current = parentOf(graph, current.id)
  }
  return chain
}

/** 所有子孙，深度优先，不含自身 */
export function descendantsOf(graph: ProjectGraph, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])

  const walk = (nodeId: string): void => {
    for (const childId of graph.nodes[nodeId]?.childIds ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      out.push(childId)
      walk(childId)
    }
  }

  walk(id)
  return out
}

export function isAncestorOf(graph: ProjectGraph, ancestorId: string, nodeId: string): boolean {
  return ancestorsOf(graph, nodeId).some((node) => node.id === ancestorId)
}

/** 顶层为 0 */
export function depthOf(graph: ProjectGraph, id: string): number {
  return ancestorsOf(graph, id).length
}

/**
 * 点中一个节点时，实际该选中哪一个。
 *
 * 对齐 Figma：点容器里的对象，选中的是**最外面那个容器**（而不是最深的对象），
 * 要编辑里面的东西得先"进组"（双击下潜，见 `childToward`）。这样"拖动父组、子项跟随"
 * 才有入口——否则一按下去抓到的是子项。
 *
 * 顶层节点返回自己；节点不存在返回 null。
 */
export function outermostAncestorId(graph: ProjectGraph, id: string): string | null {
  if (!graph.nodes[id]) return null
  // ancestorsOf 是"从父到根"，取最后一个就是最外层；空则说明自己就是顶层
  const chain = ancestorsOf(graph, id)
  return chain.length === 0 ? id : chain[chain.length - 1]!.id
}

/**
 * 从 `ancestorId` 往下走**一层**，落在通往 `nodeId` 的那条路径上。
 *
 * 双击进容器用：每次下潜一层（Figma 就是这样——双击一次进一层）。
 * 返回 null 的情况：`nodeId` 就是 `ancestorId` 自己（没得再往下），
 * 或者它根本不在 `ancestorId` 的子树里。数据成环时及时收手。
 */
export function childToward(graph: ProjectGraph, ancestorId: string, nodeId: string): string | null {
  if (!graph.nodes[ancestorId] || !graph.nodes[nodeId]) return null

  const seen = new Set<string>([nodeId])
  let current = nodeId
  for (;;) {
    const parentId = graph.nodes[current]?.parentId ?? null
    if (!parentId) return null
    if (parentId === ancestorId) return current
    if (seen.has(parentId)) return null
    seen.add(parentId)
    current = parentId
  }
}

/**
 * 把整棵树摊平成"从上到下"的一维列表（图层面板直接照着渲染）。
 * `depth` 用来做缩进。
 */
export interface TreeRow {
  id: string
  depth: number
  node: Node
}

export function flattenTree(graph: ProjectGraph): TreeRow[] {
  const rows: TreeRow[] = []
  const seen = new Set<string>()

  const walk = (ids: string[], depth: number): void => {
    for (const id of ids) {
      if (seen.has(id)) continue
      const node = graph.nodes[id]
      if (!node) continue
      seen.add(id)
      rows.push({ id, depth, node })
      walk(node.childIds, depth + 1)
    }
  }

  walk(graph.rootIds, 0)
  return rows
}
