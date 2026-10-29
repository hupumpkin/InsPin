import type { Node, ProjectGraph } from './node'
import type { Box, BoxChange } from './node-commands'
import { descendantsOf } from './tree'

/**
 * 拖组的角 = **把整棵子树等比缩放**（对齐 Figma）。
 *
 * 组的边框等于内容的并集（见 `scene.ts`），它自己没有可独立设置的宽高，所以
 * "改组的尺寸"只能是"改里面每个东西的尺寸与位置"。
 *
 * 缩放围绕**对角那个锚点**：目标框 `to` 已经由调用方按锚点算好了，这里只负责
 * 把"组的框从 from 变成 to"翻译成"组和每个子孙的坐标怎么变"。
 *
 * 纯函数，可单测。
 */
export function scaleGroupChanges(
  graph: ProjectGraph,
  groupId: string,
  from: Box,
  to: Box
): BoxChange[] {
  const group = graph.nodes[groupId]
  if (!group || group.childIds.length === 0) return []
  if (from.w === 0 || from.h === 0) return []

  const sx = to.w / from.w
  const sy = to.h / from.h

  const children = group.childIds
    .map((id) => graph.nodes[id])
    .filter((node): node is Node => Boolean(node))
  if (children.length === 0) return []

  // 组的"原点"（子节点相对坐标的参照）不一定落在并集的左上角，差多少要先扣掉
  const minX = Math.min(...children.map((child) => child.x))
  const minY = Math.min(...children.map((child) => child.y))

  const boxOf = (node: Node): Box => ({ x: node.x, y: node.y, w: node.w, h: node.h })
  const direct = new Set(group.childIds)

  const changes: BoxChange[] = [
    // 组自己挪到新框的左上角 —— 子节点的相对坐标接下来就相对它算
    { id: groupId, from: boxOf(group), to: { ...to } }
  ]

  for (const id of descendantsOf(graph, groupId)) {
    const node = graph.nodes[id]
    if (!node) continue
    // 直接子节点：相对坐标是相对**组的原点**的，原点的位移要先扣掉再缩放。
    // 更深的子孙：相对坐标是相对**父节点**的，父节点自己也按同样的比例缩，所以直接乘即可。
    const origin = direct.has(id) ? { x: minX, y: minY } : { x: 0, y: 0 }

    changes.push({
      id,
      from: boxOf(node),
      to: {
        x: (node.x - origin.x) * sx,
        y: (node.y - origin.y) * sy,
        w: node.w * sx,
        h: node.h * sy
      }
    })
  }

  return changes
}
