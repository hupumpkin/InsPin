import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { MagicStar } from 'reicon-react'
import { MIN_CAPTURE_EDGE } from '../../../shared/capture'
import {
  preferredCaptureCandidate,
  stepCaptureCandidate,
  type CaptureCandidate,
  type CapturePoint
} from '../../../shared/capture-candidates'
import type { WindowRect } from '../../../shared/ipc'
import { viewCenter } from '../canvas/view-center'
import { useGraphStore, type CaptureScreen } from '../state/graph'
import CollectModeToggle from './CollectModeToggle'

interface DragSession {
  start: CapturePoint
  candidate: CaptureCandidate | null
  moved: boolean
}

const DRAG_THRESHOLD = 4

/**
 * 区域截图的框选层。网页原生视图在这一刻已经被藏起，因此这里显示的是同一时刻的截图；
 * 可吸附的 DOM 外壳也已在截图前采样完，之后的悬停完全发生在本地静态图层。
 */
export default function CaptureOverlay({ screen }: { screen: CaptureScreen }): React.JSX.Element {
  const commitCapture = useGraphStore((state) => state.commitCapture)
  const cancelCapture = useGraphStore((state) => state.cancelCapture)
  const importing = useGraphStore((state) => state.importing)
  const { box } = screen
  const collecting = screen.mode === 'collect'
  const candidates = collecting ? screen.candidates : []

  const [selection, setSelection] = useState<WindowRect | null>(null)
  const [snap, setSnap] = useState<CaptureCandidate | null>(null)
  /** 冻结采集时，开关和退出要压在"采集入口按钮"原来的位置上。 */
  const [controlsAnchor, setControlsAnchor] = useState<{ right: number; top: number } | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const selectionRef = useRef<WindowRect | null>(null)
  const pointerRef = useRef<CapturePoint | null>(null)
  const snapRef = useRef<CaptureCandidate | null>(null)

  // 直接量浏览器栏里的采集入口按钮，保证冻结态的退出按钮和它完全重合，
  // 开关在左侧；不同停靠方式、不同面板宽度都不用各算一套坐标。
  useLayoutEffect(() => {
    if (!collecting) {
      setControlsAnchor(null)
      return
    }
    const measure = (): void => {
      const entry = document.querySelector('.browser__collect[aria-label="智能采集"]')
      const rect = entry instanceof HTMLElement ? entry.getBoundingClientRect() : null
      setControlsAnchor(
        rect
          ? { right: Math.max(0, window.innerWidth - rect.right), top: rect.top }
          : { right: Math.max(24, window.innerWidth - (box.x + box.width - 24)), top: 24 }
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [collecting, screen, box.x, box.y, box.width, box.height])

  const clampToBox = (from: CapturePoint, to: CapturePoint): WindowRect => {
    const left = Math.max(box.x, Math.min(from.x, to.x))
    const top = Math.max(box.y, Math.min(from.y, to.y))
    const right = Math.min(box.x + box.width, Math.max(from.x, to.x))
    const bottom = Math.min(box.y + box.height, Math.max(from.y, to.y))
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
  }

  const setSnapAt = (point: CapturePoint): CaptureCandidate | null => {
    pointerRef.current = point
    const next = preferredCaptureCandidate(candidates, point)
    snapRef.current = next
    setSnap(next)
    return next
  }

  const clearManualSelection = (): void => {
    selectionRef.current = null
    setSelection(null)
  }

  const commit = (rect: WindowRect, candidateId: string | null = null): void => {
    if (importing) return
    if (rect.width < MIN_CAPTURE_EDGE || rect.height < MIN_CAPTURE_EDGE) return
    // 智能命中外壳是连续采集；用户主动拉出自由框则明确只截这一次并回到网页。
    void commitCapture(rect, viewCenter(), { candidateId, continuous: collecting && candidateId !== null })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const start = { x: event.clientX, y: event.clientY }
    const candidate = collecting ? setSnapAt(start) : null
    dragRef.current = { start, candidate, moved: !collecting }
    clearManualSelection()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 合成事件没有真实 pointer capture；仍可正常框选。 */
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = { x: event.clientX, y: event.clientY }
    const drag = dragRef.current
    if (!drag) {
      setSnapAt(point)
      return
    }

    if (!drag.moved) {
      const distance = Math.hypot(point.x - drag.start.x, point.y - drag.start.y)
      if (distance < DRAG_THRESHOLD) return
      drag.moved = true
      snapRef.current = null
      setSnap(null)
    }
    const next = clampToBox(drag.start, point)
    selectionRef.current = next
    setSelection(next)
  }

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* 同上。 */
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    releasePointer(event)

    // 没拖动就是点选当前吸附外壳；没有候选时则留在截图模式，提示用户拖出自由框。
    if (collecting && !drag.moved && drag.candidate) {
      commit(drag.candidate, drag.candidate.id)
      return
    }

    const rect = selectionRef.current
    if (rect) commit(rect)
    else setSnapAt({ x: event.clientX, y: event.clientY })
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    clearManualSelection()
    releasePointer(event)
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelCapture()
        return
      }
      if (event.key === 'Enter') {
        const rect = selectionRef.current ?? snapRef.current
        if (rect) {
          event.preventDefault()
          event.stopPropagation()
          commit(rect)
        }
        return
      }
      if (!collecting || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      const point = pointerRef.current
      if (!point || selectionRef.current) return
      event.preventDefault()
      event.stopPropagation()
      const next = stepCaptureCandidate(candidates, point, snapRef.current, event.key === 'ArrowUp' ? 'outer' : 'inner')
      snapRef.current = next
      setSnap(next)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cancelCapture, candidates, collecting])

  const usable = selection !== null && selection.width >= MIN_CAPTURE_EDGE && selection.height >= MIN_CAPTURE_EDGE
  const activeRect = selection ?? snap
  const tip = importing
    ? '正在收集，请稍候…'
    : usable
    ? `${Math.round(selection.width)} × ${Math.round(selection.height)} 像素 · 松手即${collecting ? '采集' : '截下'}`
    : snap
      ? `${snap.originalAvailable ? '优先收集原图' : '将保存视觉截图'} · 单击采集 · ↑↓ 切换`
      : candidates.length > 0
        ? '单击图片智能采集 拖动光标手动采集'
        : '拖动框选要截取的区域 · Esc 取消'

  return (
    <div
      className="capture"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <img
        className="capture__page"
        src={screen.dataUrl}
        alt=""
        draggable={false}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      />

      {activeRect ? (
        <div
          className={selection ? 'capture__frame' : 'capture__snap'}
          style={{ left: activeRect.x, top: activeRect.y, width: activeRect.width, height: activeRect.height }}
        >
          {!selection && <span className="capture__snap-label">{collecting ? '智能采集' : '智能选区'}</span>}
        </div>
      ) : (
        <div className="capture__dim" />
      )}

      <p
        className={collecting ? 'capture__tip capture__tip--collect' : 'capture__tip'}
        // 采集指引落在网页内容区顶部，和不冻结模式里注入的提示在同一位置；
        // 也避开右上角新加的开关与退出按钮。
        style={collecting ? { left: box.x + box.width / 2, top: box.y + 24 } : undefined}
        aria-live="polite"
      >
        {tip}
      </p>

      {collecting && snap && !selection && (
        <p
          className="capture__depth-tip"
          style={{ left: snap.x + snap.width / 2, top: Math.max(box.y + 12, snap.y - 44) }}
        >
          ↑↓ 方向键切换内外层
        </p>
      )}

      {collecting ? (
        controlsAnchor && (
          <div
            className="capture__collect-group"
            style={{ right: controlsAnchor.right, top: controlsAnchor.top }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <CollectModeToggle />
            <button
              type="button"
              className="corner capture__exit"
              aria-label="退出智能采集"
              title="退出智能采集"
              aria-pressed="true"
              onClick={cancelCapture}
            >
              <MagicStar size={24} weight="Outline" />
            </button>
          </div>
        )
      ) : (
        <div className="capture__actions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="capture__btn" onClick={cancelCapture}>
            取消
          </button>
        </div>
      )}
    </div>
  )
}
