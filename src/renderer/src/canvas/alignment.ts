import type { Rect } from './hit-test'

export type AlignMode =
  | 'left'
  | 'center-x'
  | 'right'
  | 'top'
  | 'center-y'
  | 'bottom'
  | 'distribute-x'
  | 'distribute-y'

export interface AlignmentMove {
  id: string
  x: number
  y: number
}

/**
 * 多选对齐与等距分布。边缘/中心以选择集的共同包围盒为基准；分布固定首尾，
 * 只移动中间项，这是设计工具中最不意外的规则。
 */
export function alignBoxes(boxes: Map<string, Rect>, mode: AlignMode): AlignmentMove[] {
  const entries = [...boxes.entries()]
  if (entries.length < 2) return []
  const all = entries.map(([, box]) => box)
  const left = Math.min(...all.map((box) => box.x))
  const right = Math.max(...all.map((box) => box.x + box.w))
  const top = Math.min(...all.map((box) => box.y))
  const bottom = Math.max(...all.map((box) => box.y + box.h))
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2

  if (mode === 'distribute-x' || mode === 'distribute-y') {
    if (entries.length < 3) return []
    const horizontal = mode === 'distribute-x'
    const sorted = [...entries].sort(([, a], [, b]) => (horizontal ? a.x - b.x : a.y - b.y))
    const first = sorted[0]![1]
    const last = sorted[sorted.length - 1]![1]
    const used = sorted.reduce((sum, [, box]) => sum + (horizontal ? box.w : box.h), 0)
    const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y
    const gap = (span - used) / (sorted.length - 1)
    let cursor = horizontal ? first.x + first.w + gap : first.y + first.h + gap
    return sorted.map(([id, box], index) => {
      if (index === 0 || index === sorted.length - 1) return { id, x: box.x, y: box.y }
      const move = horizontal ? { id, x: cursor, y: box.y } : { id, x: box.x, y: cursor }
      cursor += (horizontal ? box.w : box.h) + gap
      return move
    })
  }

  return entries.map(([id, box]) => {
    if (mode === 'left') return { id, x: left, y: box.y }
    if (mode === 'center-x') return { id, x: centerX - box.w / 2, y: box.y }
    if (mode === 'right') return { id, x: right - box.w, y: box.y }
    if (mode === 'top') return { id, x: box.x, y: top }
    if (mode === 'center-y') return { id, x: box.x, y: centerY - box.h / 2 }
    return { id, x: box.x, y: bottom - box.h }
  })
}
