import type { AssetInfo, CutoutTarget } from '../../shared/ipc'
import { isCutoutMime } from '../../shared/cutout'
import type { ProjectGraph } from '../../shared/node'
import type { SceneItem } from '../../shared/scene'

/** 首版严格只支持单选一张位图；批量时再补进度、取消与排队。 */
export const MAX_CUTOUT_TARGETS = 1
const PLACEMENT_GAP = 24

export interface CutoutTargetView extends CutoutTarget {
  name: string
}

/**
 * 只认**直接单选**的一张可处理位图。不能先过滤再计数，否则混选 PNG + SVG 时
 * 会错误露出入口，用户以为能对多选执行操作。
 */
export function collectCutoutTargets(
  graph: ProjectGraph | null,
  assets: Record<string, AssetInfo>,
  selectedIds: string[],
  items: SceneItem[]
): CutoutTargetView[] {
  if (!graph || selectedIds.length !== MAX_CUTOUT_TARGETS) return []
  const node = graph.nodes[selectedIds[0] ?? '']
  if (!node || node.type !== 'asset') return []
  const info = assets[node.props.assetId]
  if (!info || info.missing || !isCutoutMime(info.mime)) return []
  const item = findItem(items, node.id)
  return [
    {
      nodeId: node.id,
      assetId: node.props.assetId,
      name: node.name,
      at: item ? { x: item.absX + item.w + PLACEMENT_GAP, y: item.absY } : null
    }
  ]
}

export function canRunCutout(targets: CutoutTargetView[], available: boolean): boolean {
  return available && targets.length === MAX_CUTOUT_TARGETS
}

function findItem(items: SceneItem[], id: string): SceneItem | null {
  for (const item of items) {
    if (item.node.id === id) return item
    const found = findItem(item.children, id)
    if (found) return found
  }
  return null
}
