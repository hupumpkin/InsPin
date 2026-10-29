import type { Command } from './command'
import type { AssetCrop, CanvasElement, Node, NodeMap, ProjectGraph } from './node'
import { cropOf, isFullCrop, normalizeCrop } from './crop'

/**
 * 画布编辑命令（路线图 D2.6–D2.8）。
 *
 * 按 §1.2 的硬性约定，移动/缩放/删除**全部走命令**，每条命令自带反向操作。
 * 命令都是纯函数：收图、返新图，绝不就地改。
 *
 * 为了让命令**无状态**（不需要在 apply 里偷偷记状态），**"之前的样子"由调用方在构造时
 * 一起传进来**——拖动开始时节点坐标本来就在手上，顺手传过来即可。删除是唯一例外：
 * 它要知道被删子树的完整结构与在原顺序里的位置，所以构造时直接读一次当前图。
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface NodeMove {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
}

/** 一个节点的盒子从哪来、到哪去。 */
export interface BoxChange {
  id: string
  from: Box
  to: Box
}

export interface AssetCropChange {
  box: Box
  crop: AssetCrop
}

/** 平移若干节点（相对父节点的坐标，所以父子会一起动是渲染层的事，模型只管自己）。 */
export function createMoveNodesCommand(moves: NodeMove[]): Command {
  const write = (graph: ProjectGraph, pick: 'from' | 'to'): ProjectGraph => {
    const nodes: NodeMap = { ...graph.nodes }
    for (const move of moves) {
      const node = nodes[move.id]
      if (!node) continue
      const target = move[pick]
      nodes[move.id] = { ...node, x: target.x, y: target.y }
    }
    return { ...graph, nodes }
  }

  return {
    name: 'move-nodes',
    apply: (graph) => write(graph, 'to'),
    revert: (graph) => write(graph, 'from')
  }
}

/** 改一个节点的位置与尺寸（缩放手柄用；比例锁定在调用方算好再传进来）。 */
export function createResizeNodeCommand(id: string, from: Box, to: Box): Command {
  const write = (graph: ProjectGraph, box: Box): ProjectGraph => {
    const node = graph.nodes[id]
    if (!node) return graph
    return { ...graph, nodes: { ...graph.nodes, [id]: { ...node, ...box } } }
  }

  return {
    name: 'resize-node',
    apply: (graph) => write(graph, to),
    revert: (graph) => write(graph, from)
  }
}

/**
 * 一次改一批节点的位置与尺寸（拖组的角等比缩放整棵子树用）。
 *
 * 与 `createResizeNodeCommand` 的区别只是"一条命令里带几个节点"——拖组的时候，
 * 组和它的每个子孙都要按比例改，**必须落在同一步历史里**，⌘Z 一下整个退回去。
 */
export function createResizeNodesCommand(changes: BoxChange[]): Command {
  const write = (graph: ProjectGraph, pick: 'from' | 'to'): ProjectGraph => {
    const nodes: NodeMap = { ...graph.nodes }
    for (const change of changes) {
      const node = nodes[change.id]
      if (!node) continue
      const target = change[pick]
      nodes[change.id] = { ...node, x: target.x, y: target.y, w: target.w, h: target.h }
    }
    return { ...graph, nodes }
  }

  return {
    name: 'resize-nodes',
    apply: (graph) => write(graph, 'to'),
    revert: (graph) => write(graph, 'from')
  }
}

/** 一次非破坏式裁切：同时记录可见框与原图裁切区域，撤销会完全还原。 */
export function createSetAssetCropCommand(
  id: string,
  from: AssetCropChange,
  to: AssetCropChange
): Command {
  const write = (graph: ProjectGraph, value: AssetCropChange): ProjectGraph => {
    const node = graph.nodes[id]
    if (!node || node.type !== 'asset') return graph
    const crop = normalizeCrop(value.crop)
    const props = { ...node.props }
    if (isFullCrop(crop)) delete props.crop
    else props.crop = crop
    return {
      ...graph,
      nodes: { ...graph.nodes, [id]: { ...node, ...value.box, props } }
    }
  }

  return {
    name: 'set-asset-crop',
    apply: (graph) => write(graph, to),
    revert: (graph) => write(graph, from)
  }
}

/** 读取节点裁切状态的统一兜底，给工具条和画布交互共用。 */
export function assetCropOf(node: Node): AssetCrop {
  return node.type === 'asset' ? cropOf(node.props.crop) : cropOf(undefined)
}

/** 更新原生画布元素的外观；与移动、缩放一样是一条可撤销命令。 */
export function createSetCanvasElementCommand(id: string, from: CanvasElement, to: CanvasElement): Command {
  const write = (graph: ProjectGraph, element: CanvasElement): ProjectGraph => {
    const node = graph.nodes[id]
    if (!node || node.type !== 'frame' || !node.props.element) return graph
    return {
      ...graph,
      nodes: { ...graph.nodes, [id]: { ...node, props: { ...node.props, element } } }
    }
  }
  return {
    name: 'set-canvas-element',
    apply: (graph) => write(graph, to),
    revert: (graph) => write(graph, from)
  }
}

/**
 * 自动宽度文本落定：文字内容与盒子尺寸一起更新。
 * 拆成两条命令会出现“撤销一次只改回文字、盒子还留着”的半截状态，所以合在一步里。
 */
export function createFitTextNodeCommand(
  id: string,
  from: { element: CanvasElement; box: Box },
  to: { element: CanvasElement; box: Box }
): Command {
  const write = (
    graph: ProjectGraph,
    next: { element: CanvasElement; box: Box }
  ): ProjectGraph => {
    const node = graph.nodes[id]
    if (!node || node.type !== 'frame') return graph
    return {
      ...graph,
      nodes: {
        ...graph.nodes,
        [id]: {
          ...node,
          x: next.box.x,
          y: next.box.y,
          w: next.box.w,
          h: next.box.h,
          props: { ...node.props, element: next.element }
        }
      }
    }
  }

  return {
    name: 'fit-text-node',
    apply: (graph) => write(graph, to),
    revert: (graph) => write(graph, from)
  }
}

/** 旋转一个节点（角度制）。角度归一化到 (-180, 180]，撤销重做都靠它。 */
export function createRotateNodeCommand(id: string, from: number, to: number): Command {
  const write = (graph: ProjectGraph, angle: number): ProjectGraph => {
    const node = graph.nodes[id]
    if (!node) return graph
    return { ...graph, nodes: { ...graph.nodes, [id]: { ...node, rotation: normalizeAngle(angle) } } }
  }
  return {
    name: 'rotate-node',
    apply: (graph) => write(graph, to),
    revert: (graph) => write(graph, from)
  }
}

export function normalizeAngle(angle: number): number {
  const wrapped = angle % 360
  if (wrapped > 180) return wrapped - 360
  if (wrapped <= -180) return wrapped + 360
  return wrapped
}

interface Place {
  id: string
  parentId: string | null
  /** 原来在同级里的第几个；撤销时按原位放回，图层顺序才不会乱 */
  index: number
}

function insertAt(list: string[], id: string, index: number): string[] {
  const next = [...list]
  const at = index < 0 || index > next.length ? next.length : index
  next.splice(at, 0, id)
  return next
}

/**
 * 删除若干节点（连同它们的子孙）。
 * 构造时读一次图，把"被删了什么、原本排在哪"记下来——撤销就是把它们放回原位。
 */
export function createDeleteNodesCommand(graph: ProjectGraph, ids: string[]): Command {
  const roots = ids.filter((id) => graph.nodes[id])

  const removed: Node[] = []
  const places: Place[] = []
  const collect = (id: string): void => {
    const node = graph.nodes[id]
    if (!node) return
    removed.push(node)
    node.childIds.forEach(collect)
  }

  for (const id of roots) {
    const node = graph.nodes[id]
    if (!node) continue
    const siblings =
      node.parentId === null ? graph.rootIds : (graph.nodes[node.parentId]?.childIds ?? [])
    places.push({ id, parentId: node.parentId, index: siblings.indexOf(id) })
    collect(id)
  }
  // 按原顺序放回，同级多个被删时才不会前后颠倒
  places.sort((a, b) => a.index - b.index)

  const removedIds = new Set(removed.map((node) => node.id))

  return {
    name: 'delete-nodes',

    apply(current: ProjectGraph): ProjectGraph {
      if (removedIds.size === 0) return current

      const nodes: NodeMap = {}
      for (const [id, node] of Object.entries(current.nodes)) {
        if (!removedIds.has(id)) nodes[id] = node
      }
      for (const place of places) {
        if (place.parentId === null) continue
        const parent = nodes[place.parentId]
        if (parent) {
          nodes[place.parentId] = {
            ...parent,
            childIds: parent.childIds.filter((childId) => !removedIds.has(childId))
          }
        }
      }
      return {
        ...current,
        nodes,
        rootIds: current.rootIds.filter((id) => !removedIds.has(id))
      }
    },

    revert(current: ProjectGraph): ProjectGraph {
      if (removedIds.size === 0) return current

      const nodes: NodeMap = { ...current.nodes }
      for (const node of removed) nodes[node.id] = node

      let rootIds = [...current.rootIds]
      for (const place of places) {
        if (place.parentId === null) {
          rootIds = insertAt(rootIds, place.id, place.index)
          continue
        }
        const parent = nodes[place.parentId]
        if (parent) {
          nodes[place.parentId] = {
            ...parent,
            childIds: insertAt(parent.childIds, place.id, place.index)
          }
        }
      }
      return { ...current, nodes, rootIds }
    }
  }
}
