import type { Node, NodeType, ProjectGraph } from '../../shared/node'

/**
 * 图层面板的显示模型（D4a.2 / D4a.4）。
 *
 * 面板交给 **react-arborist**（MIT）渲染：拖拽排序、落点指示线、行内重命名、多选
 * 都由它提供，行为对齐 Figma。这里只做"我们的对象模型 ↔ 它要的树"的翻译，纯函数、可单测。
 *
 * **唯一容易搞反的地方**：Figma 面板里**最上层排最上**，而模型里 `rootIds` / `childIds`
 * 是绘制顺序（越靠后越在前）。所以面板顺序是模型顺序的**倒序**——进出两边都要转。
 */

/** react-arborist 认的节点形状：`id` 与 `name` 是它的默认访问器字段。 */
export interface LayerTreeNode {
  id: string
  /** 落库名保持可编辑；displayName 是面板里更有信息量的默认名。 */
  name: string
  displayName: string
  type: NodeType
  kind: 'image' | 'group' | 'frame' | 'text' | 'rectangle' | 'ellipse' | 'line'
  kindLabel: string
  visible: boolean
  locked: boolean
  children?: LayerTreeNode[]
}

/**
 * 图层名遵循“用户命名优先，系统默认名让位给内容”的规则：
 * 文本层若还叫默认的“文本”，直接展示第一行正文；图片去掉常见扩展名。
 * 这里只改变面板呈现，不静默改用户数据，双击重命名后仍完整尊重用户输入。
 */
export function layerDisplayName(node: Node): string {
  const name = node.name.trim()
  if (node.type === 'frame' && node.props.element?.kind === 'text' && (name === '' || name === '文本')) {
    const firstLine = node.props.element.text.split(/\r?\n/, 1)[0]?.trim()
    if (firstLine) return firstLine
  }
  if (node.type === 'asset') {
    const withoutExtension = name.replace(/\.(avif|gif|jpe?g|png|svg|webp)$/i, '')
    if (withoutExtension) return withoutExtension
  }
  return name || layerKindLabel(node)
}

export function layerKind(node: Node): LayerTreeNode['kind'] {
  if (node.type === 'asset') return 'image'
  if (node.type === 'group') return 'group'
  const element = node.props.element
  if (!element) return 'frame'
  return element.kind === 'text' ? 'text' : element.shape
}

export function layerKindLabel(node: Node): string {
  const labels: Record<LayerTreeNode['kind'], string> = {
    image: '图片',
    group: '编组',
    frame: '容器',
    text: '文本',
    rectangle: '矩形',
    ellipse: '圆形',
    line: '线条'
  }
  return labels[layerKind(node)]
}

/** 某一层在**面板显示顺序**下的 id 列表（模型的倒序）。 */
export function displayChildIds(graph: ProjectGraph, parentId: string | null): string[] {
  const ids = parentId === null ? graph.rootIds : (graph.nodes[parentId]?.childIds ?? [])
  return [...ids].reverse()
}

export function toArboristTree(graph: ProjectGraph): LayerTreeNode[] {
  const seen = new Set<string>()
  let imageIndex = 0

  const build = (id: string): LayerTreeNode | null => {
    if (seen.has(id)) return null
    const node = graph.nodes[id]
    if (!node) return null
    seen.add(id)

    const children = displayChildIds(graph, id)
      .map(build)
      .filter((child): child is LayerTreeNode => child !== null)
    seen.delete(id)

    const displayName = node.type === 'asset' && /^[a-f0-9]{24,}$/i.test(layerDisplayName(node))
      ? `图片 ${++imageIndex}`
      : layerDisplayName(node)
    const base = {
      id,
      name: node.name,
      displayName,
      type: node.type,
      kind: layerKind(node),
      kindLabel: layerKindLabel(node),
      visible: node.visible,
      locked: node.locked
    }
    // 叶子节点不给 children，react-arborist 才不会画展开箭头
    return children.length > 0 ? { ...base, children } : base
  }

  return displayChildIds(graph, null)
    .map(build)
    .filter((node): node is LayerTreeNode => node !== null)
}

/**
 * 把"面板显示顺序里的插入位置"换算成"模型里的插入下标"。
 *
 * 两个列表互为倒序、长度相同（`count` 都是**扣掉被拖动节点之后**的个数）：
 * 显示顺序里插到第 `displayIndex` 位，等价于模型里插到第 `count - displayIndex` 位。
 */
export function displayToModelIndex(displayIndex: number, count: number): number {
  return count - displayIndex
}
