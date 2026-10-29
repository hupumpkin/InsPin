import type { SceneItem } from '../../../shared/scene'

export interface WorldPosition {
  x: number
  y: number
}

/**
 * 把一个世界坐标换成 Pixi 节点容器需要的父级局部坐标。
 *
 * 组会在渲染树里收紧到子项并集，所以不能使用模型中的父级 x/y：两者常常不同。
 * 必须用 Pixi 同样使用的可见父级原点，图片预览和 DOM 选中框才能从同一点起步。
 */
export function previewPositionFromWorld(
  items: SceneItem[],
  id: string,
  world: WorldPosition
): WorldPosition {
  const item = findItem(items, id)
  const parent = item?.node.parentId ? findItem(items, item.node.parentId) : null
  const origin = parent ? { x: parent.absX, y: parent.absY } : { x: 0, y: 0 }
  return { x: world.x - origin.x, y: world.y - origin.y }
}

function findItem(items: SceneItem[], id: string): SceneItem | null {
  for (const item of items) {
    if (item.node.id === id) return item
    const child = findItem(item.children, id)
    if (child) return child
  }
  return null
}
