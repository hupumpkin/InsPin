import type { Node, ProjectGraph } from './node'

/**
 * 命令接口（路线图 §1.2 / §5.5.5）：**一切画布编辑都必须走命令**，
 * 每条命令自带"反向操作"，撤销重做因此永远可用。
 *
 * 两个方法都必须是**纯函数**：接收图、返回新图，绝不就地修改入参。
 * 命令自身携带足够的数据来完成正反两个方向，所以 revert 不需要额外上下文。
 */
export interface Command {
  /** 可读名字，用于日志与调试，如 `add-node:asset` */
  readonly name: string
  /** 执行；重做时也走这里 */
  apply(graph: ProjectGraph): ProjectGraph
  /** 撤销；作用于"已经 apply 过"的图 */
  revert(graph: ProjectGraph): ProjectGraph
}

/** 追加到末尾，已存在则原样返回（保证 apply 可以安全地重复执行） */
function appendUnique(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id]
}

/**
 * 样板命令：把一个节点加进画布（顶层或某个父节点下）。
 * 用节点的 `parentId` 决定挂在哪 —— 模型里已经有这个字段，不另传参数。
 */
export function createAddNodeCommand(node: Node): Command {
  const parentId = node.parentId

  return {
    name: `add-node:${node.type}`,

    apply(graph: ProjectGraph): ProjectGraph {
      // 已经存在就当已加过（重做安全）
      if (graph.nodes[node.id]) return graph

      const nodes = { ...graph.nodes, [node.id]: node }

      if (parentId === null) {
        return { ...graph, nodes, rootIds: appendUnique(graph.rootIds, node.id) }
      }

      const parent = graph.nodes[parentId]
      // 父节点不在（数据异常）时不动，避免造出悬挂节点
      if (!parent) return graph

      nodes[parentId] = { ...parent, childIds: appendUnique(parent.childIds, node.id) }
      return { ...graph, nodes }
    },

    revert(graph: ProjectGraph): ProjectGraph {
      if (!graph.nodes[node.id]) return graph

      const nodes = { ...graph.nodes }
      delete nodes[node.id]

      if (parentId === null) {
        return { ...graph, nodes, rootIds: graph.rootIds.filter((id) => id !== node.id) }
      }

      const parent = graph.nodes[parentId]
      if (parent) {
        nodes[parentId] = { ...parent, childIds: parent.childIds.filter((id) => id !== node.id) }
      }
      return { ...graph, nodes }
    }
  }
}
