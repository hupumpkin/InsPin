/**
 * 截图时可吸附的网页元素框。坐标已经是主窗口 CSS 像素，和 CaptureOverlay 的选框共用一套坐标。
 * `priority` 只决定首次悬停命中谁；切换内外层时按实际包围面积走，不会被分数干扰。
 */
export interface CaptureCandidate {
  id: string
  x: number
  y: number
  width: number
  height: number
  priority: number
  /** 这个外壳内有一张足够覆盖画面的原图，点击时可优先尝试收原图。地址不出主进程。 */
  originalAvailable?: boolean
}

export interface CapturePoint {
  x: number
  y: number
}

export type CaptureCandidateDirection = 'inner' | 'outer'

function area(candidate: CaptureCandidate): number {
  return candidate.width * candidate.height
}

function contains(candidate: CaptureCandidate, point: CapturePoint): boolean {
  return (
    point.x >= candidate.x &&
    point.x <= candidate.x + candidate.width &&
    point.y >= candidate.y &&
    point.y <= candidate.y + candidate.height
  )
}

/** 当前指针下所有候选框；默认先取分最高的"外壳"，同分才偏向更紧凑的框。 */
export function captureCandidatesAt(
  candidates: readonly CaptureCandidate[],
  point: CapturePoint
): CaptureCandidate[] {
  return candidates
    .filter((candidate) => contains(candidate, point))
    .sort((a, b) => b.priority - a.priority || area(a) - area(b) || a.id.localeCompare(b.id))
}

export function preferredCaptureCandidate(
  candidates: readonly CaptureCandidate[],
  point: CapturePoint
): CaptureCandidate | null {
  return captureCandidatesAt(candidates, point)[0] ?? null
}

/**
 * 上/下键在当前指针下的内外层之间移动。只走到边界、不循环，避免用户以为选框"跳走"。
 */
export function stepCaptureCandidate(
  candidates: readonly CaptureCandidate[],
  point: CapturePoint,
  current: CaptureCandidate | null,
  direction: CaptureCandidateDirection
): CaptureCandidate | null {
  const stack = captureCandidatesAt(candidates, point).sort(
    (a, b) => area(a) - area(b) || b.priority - a.priority || a.id.localeCompare(b.id)
  )
  if (stack.length === 0) return null
  if (!current) return direction === 'outer' ? stack.at(-1) ?? null : stack[0] ?? null

  const index = stack.findIndex((candidate) => candidate.id === current.id)
  if (index < 0) return direction === 'outer' ? stack.at(-1) ?? null : stack[0] ?? null
  return direction === 'outer'
    ? stack[Math.min(index + 1, stack.length - 1)] ?? null
    : stack[Math.max(index - 1, 0)] ?? null
}
