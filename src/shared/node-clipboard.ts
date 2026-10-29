import type { Command } from './command'
import { layout } from './layout'
import type { Node, NodeMap, ProjectGraph } from './node'
import { buildScene } from './scene'
import { descendantsOf, flattenTree } from './tree'

/**
 * 画布节点的复制 / 粘贴（路线图 D4a.7）。
 *
 * **不走系统剪贴板**：系统剪贴板在 D1.5 已经被"粘贴图片进来"占用，这里再往里塞
 * 一段自定义 JSON 会互相打架。复制只是一份**内存里的描述**，进程内用即可。
 *
 * 复制下来的是一棵"森林"：一批互不为祖先的根，加它们各自的子孙。粘贴时整棵深拷贝、
 * 换一批新 id，按原绘制顺序插到目标层级末尾，并在画布上错开一点，免得和原件完全重叠。
 */

export interface NodeClipboard {
  /** 复制到的节点（含子孙），按复制时的绘制顺序 */
  nodes: Node[]
  /** 这批里最外层的节点 id，按原绘制顺序——粘贴时按这个顺序插入 */
  roots: string[]
  /**
   * 复制时每个节点在画布上的绝对位置。
   *
   * 必须先存下来：剪切会把原节点删掉，粘贴时再从当前图算位置就只能得到 0,0，
   * 多张图会全部叠到画布原点、也可能落到镜头外。
   */
  positions: Record<string, { x: number; y: number }>
  /** 复制时根的模型原点与可见位置之差，用来让组 / 自动布局的子树留在原地。 */
  rootShifts: Record<string, { x: number; y: number }>
}

/** 每个节点在画布上的绝对坐标（累加自身与所有祖先的偏移）。 */
function absolutePositionOf(graph: ProjectGraph, id: string): { x: number; y: number } {
  let x = 0
  let y = 0
  let current: string | null = id
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const node: Node | undefined = graph.nodes[current]
    if (!node) break
    x += node.x
    y += node.y
    current = node.parentId
  }
  return { x, y }
}

/**
 * 每个节点**真正画在哪儿**（画布绝对坐标）。
 *
 * 不能用模型里的原始 x/y 累加：
 *   - 自动排列的子节点位置由布局求解器算，模型里往往是 0；
 *   - 组的位置是子内容的并集，也不一定等于组自己的 x/y。
 * 用模型坐标复制，副本会落到画布原点——⌥ 拖动复制“瞬移”的根因。
 */
function renderedPositions(graph: ProjectGraph): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const walk = (items: ReturnType<typeof buildScene>): void => {
    for (const item of items) {
      positions.set(item.node.id, { x: item.absX, y: item.absY })
      walk(item.children)
    }
  }
  walk(buildScene(graph))
  return positions
}

/** 把一批 id 里"已被别的选中项包含"的去掉，只留下最外层的几个。 */
function topMostOnly(graph: ProjectGraph, ids: string[]): string[] {
  const picked = new Set<string>()
  for (const id of ids) {
    if (!graph.nodes[id]) continue
    // 祖先里已经有入选的，说明这个 id 会被那棵子树一起带走，丢弃
    let cursor = graph.nodes[id]?.parentId ?? null
    let nested = false
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      if (picked.has(cursor)) {
        nested = true
        break
      }
      cursor = graph.nodes[cursor]?.parentId ?? null
    }
    if (!nested) picked.add(id)
  }
  return ids.filter((id) => picked.has(id))
}

/**
 * 把选中的节点连同子孙拷成一份可粘贴的描述。
 * 选中集为空、或全是已不存在的节点时返回 null。
 */
export function copyNodes(graph: ProjectGraph, ids: string[]): NodeClipboard | null {
  const roots = topMostOnly(graph, ids)
  if (roots.length === 0) return null

  const wanted = new Set<string>()
  for (const id of roots) {
    wanted.add(id)
    for (const child of descendantsOf(graph, id)) wanted.add(child)
  }

  // 按画布绘制顺序取，粘贴后的层级顺序才和复制前一致
  const order = flattenTree(graph)
    .map((row) => row.id)
    .filter((id) => wanted.has(id))

  const nodes = order.flatMap((id) => {
    const node = graph.nodes[id]
    return node ? [structuredClone(node)] : []
  })

  const rendered = renderedPositions(graph)
  const positions: Record<string, { x: number; y: number }> = {}
  for (const node of nodes) {
    positions[node.id] = rendered.get(node.id) ?? absolutePositionOf(graph, node.id)
  }
  const rootShifts: Record<string, { x: number; y: number }> = {}
  for (const rootId of roots) {
    const raw = absolutePositionOf(graph, rootId)
    const visual = positions[rootId] ?? raw
    rootShifts[rootId] = { x: raw.x - visual.x, y: raw.y - visual.y }
  }

  return { nodes, roots, positions, rootShifts }
}

export interface PasteOptions {
  /** 粘到哪一层；默认顶层 */
  parentId?: string | null
  /**
   * 画布上的目标中心。传入后，整批最外层节点的包围盒会以这个点为中心；
   * 不传才沿用默认的右下错开，方便没有画布视口的调用方。
   */
  center?: { x: number; y: number } | null
  /** 相对原件错开的位移；默认右下各 16 */
  dx?: number
  dy?: number
  /** 新 id 的来源；测试里注入固定值，正式用时是随机 id */
  idFactory?: () => string
  /**
   * 预先算好的"旧 id → 新 id"表。调用方想事后知道粘贴出来的是哪几个节点
   * （比如粘贴后要选中它们），就把表传进来，自己留着用。不传则由内部生成。
   */
  newIds?: Map<string, string>
}

const PASTE_OFFSET = 16

/** 默认 id：优先用 `crypto.randomUUID`，个别不安全上下文里没有时退回随机串。 */
function defaultIdFactory(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return uuid.call(globalThis.crypto)
  return `n-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/** 只在末尾补上还没有的 id，重复执行（重做）不会把同一个 id 记两次。 */
function appendUnique(list: string[], add: string[]): string[] {
  const next = [...list]
  for (const id of add) if (!next.includes(id)) next.push(id)
  return next
}

/**
 * 粘贴一条命令。构造时就整棵算好，`revert` 直接退回粘贴前的图。
 * 命令在"构造时读一次当前图"这件事上和 `createDeleteNodesCommand` 一致。
 */
export function createPasteCommand(
  graph: ProjectGraph,
  clip: NodeClipboard,
  options: PasteOptions = {}
): Command {
  const parentId = options.parentId ?? null
  const rendered = renderedPositions(graph)
  // 剪切后原节点已经不在图里，优先用复制时存下的位置，不能从当前图反推。
  const positionOf = (id: string): { x: number; y: number } =>
    clip.positions[id] ?? rendered.get(id) ?? absolutePositionOf(graph, id)
  /**
   * 根节点被提到顶层时，模型原点与可见位置可能不一致（组是子内容并集、自动排列
   * 会覆盖坐标）。副本放到可见位置后，直接子节点的相对坐标要补上这段差值，
   * 整棵子树才会留在原地。
   */
  const rootShifts = new Map<string, { x: number; y: number }>()
  for (const rootId of clip.roots) {
    const stored = clip.rootShifts[rootId]
    if (stored) {
      rootShifts.set(rootId, stored)
      continue
    }
    const raw = absolutePositionOf(graph, rootId)
    const visual = positionOf(rootId)
    rootShifts.set(rootId, { x: raw.x - visual.x, y: raw.y - visual.y })
  }
  // 组和自动布局容器本身可能没有可见尺寸，必须把复制树里的子孙也算进来，
  // 才能让“光标落在整组选区中心”而不是落在空容器原点。
  const sourceNodes = clip.nodes.map((node) => ({ node, position: positionOf(node.id) }))
  const sourceBounds = sourceNodes.reduce<{ left: number; top: number; right: number; bottom: number } | null>(
    (bounds, { node, position }) => ({
      left: Math.min(bounds?.left ?? position.x, position.x),
      top: Math.min(bounds?.top ?? position.y, position.y),
      right: Math.max(bounds?.right ?? position.x + node.w, position.x + node.w),
      bottom: Math.max(bounds?.bottom ?? position.y + node.h, position.y + node.h)
    }),
    null
  )
  const PASTE_GAP = 16
  const rootOffsets = new Map<string, { dx: number; dy: number }>()
  const assetRoots =
    clip.roots.length > 1 &&
    clip.roots.every((id) => clip.nodes.find((node) => node.id === id)?.type === 'asset')
  if (options.center && assetRoots) {
    // 多张图一起回来：横向排成一行、固定 16px 间距，再以落点为中心。
    const boxes = clip.roots.flatMap((id) => {
      const node = clip.nodes.find((item) => item.id === id)
      return node ? [{ id, node, position: positionOf(id) }] : []
    })
    const totalWidth = boxes.reduce((sum, box) => sum + box.node.w, 0) + PASTE_GAP * (boxes.length - 1)
    const maxHeight = Math.max(...boxes.map((box) => box.node.h))
    let cursor = options.center.x - totalWidth / 2
    for (const box of boxes) {
      rootOffsets.set(box.id, {
        dx: cursor - box.position.x,
        dy: options.center.y - maxHeight / 2 + (maxHeight - box.node.h) / 2 - box.position.y
      })
      cursor += box.node.w + PASTE_GAP
    }
  } else {
    const dx = options.center && sourceBounds
      ? options.center.x - (sourceBounds.left + sourceBounds.right) / 2
      : options.dx ?? PASTE_OFFSET
    const dy = options.center && sourceBounds
      ? options.center.y - (sourceBounds.top + sourceBounds.bottom) / 2
      : options.dy ?? PASTE_OFFSET
    for (const rootId of clip.roots) rootOffsets.set(rootId, { dx, dy })
  }
  const nextId = options.idFactory ?? defaultIdFactory

  const before: { nodes: NodeMap; rootIds: string[] } = {
    nodes: graph.nodes,
    rootIds: graph.rootIds
  }

  const idMap = options.newIds ?? new Map<string, string>()
  for (const node of clip.nodes) {
    if (!idMap.has(node.id)) idMap.set(node.id, nextId())
  }

  // 子节点的坐标原点是父级的**布局原点**：组用自己的 x/y（不是内容并集），
  // 自动排列的父级则是求解器算出来的位置。渲染位置（并集/布局后的绝对坐标）
  // 只适合给"脱离父级、放到顶层"的副本定位。
  const layoutBoxes = parentId === null ? null : layout(graph)
  const parentOrigin =
    parentId === null
      ? { x: 0, y: 0 }
      : layoutBoxes?.[parentId]
        ? { x: layoutBoxes[parentId]!.x, y: layoutBoxes[parentId]!.y }
        : absolutePositionOf(graph, parentId)

  const nodes: NodeMap = { ...graph.nodes }
  for (const node of clip.nodes) {
    const newId = idMap.get(node.id)
    if (!newId) continue
    const isRoot = clip.roots.includes(node.id)
    const clone: Node = {
      ...structuredClone(node),
      id: newId,
      projectId: graph.projectId,
      parentId: node.parentId && idMap.has(node.parentId) ? idMap.get(node.parentId)! : parentId,
      childIds: node.childIds.flatMap((childId) => {
        const mapped = idMap.get(childId)
        return mapped ? [mapped] : []
      })
    }
    if (isRoot) {
      // 根的坐标从**画布上实际显示的位置**算起，再错开一点；这样跨层级复制也不会跳位
      const abs = positionOf(node.id)
      const offset = rootOffsets.get(node.id) ?? { dx: 0, dy: 0 }
      clone.x = abs.x + offset.dx - parentOrigin.x
      clone.y = abs.y + offset.dy - parentOrigin.y
    } else if (node.parentId) {
      // 直接子节点跟着根的"模型原点 → 可见位置"一起换算；再深一层相对父级即可
      const shift = rootShifts.get(node.parentId)
      if (shift) {
        clone.x += shift.x
        clone.y += shift.y
      }
    }
    nodes[newId] = clone
  }

  const rootOrder = clip.roots
    .map((id) => idMap.get(id))
    .filter((id): id is string => Boolean(id))

  const appendToParent = (target: NodeMap, rootIds: string[]): { nodes: NodeMap; rootIds: string[] } => {
    if (parentId === null) return { nodes: target, rootIds: appendUnique(rootIds, rootOrder) }
    const parent = target[parentId]
    if (!parent) return { nodes: target, rootIds }
    return {
      nodes: {
        ...target,
        [parentId]: { ...parent, childIds: appendUnique(parent.childIds, rootOrder) }
      },
      rootIds
    }
  }

  return {
    name: 'paste-nodes',
    apply(current) {
      const merged: NodeMap = { ...current.nodes }
      for (const [id, node] of Object.entries(nodes)) {
        if (!current.nodes[id]) merged[id] = node
      }
      const appended = appendToParent(merged, current.rootIds)
      return { ...current, nodes: appended.nodes, rootIds: appended.rootIds }
    },
    revert(current) {
      return { ...current, nodes: before.nodes, rootIds: before.rootIds }
    }
  }
}
