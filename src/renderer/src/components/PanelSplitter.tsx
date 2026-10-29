import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clampPanelWidth, PANEL_CARD_GUTTER } from '../../../shared/panel'
import { useUiStore } from '../state/ui'

/**
 * 浏览器 / 画布之间的分栏线（路线图 D3.5）。
 *
 * - **默认什么都不画**，鼠标移到边上才浮出 1px 细线；热区 6px；
 * - 拖动时**实时跟手**：面板宽度当帧就变，chrome 与原生网页视图一起走；
 * - 宽度夹在"浏览器 ≥420、画布 ≥640"之间（约束来自路线图 D3.5）。
 *
 * 热区整个偏向**画布那一侧**：网页是原生视图，永远盖在界面之上，
 * 压在它下面的半条热区根本点不到。
 */
export default function PanelSplitter(): React.JSX.Element | null {
  const panel = useUiStore((state) => state.panel)
  const folderPanelOpen = useUiStore((state) => state.folderPanelOpen)
  const previewPanelWidth = useUiStore((state) => state.previewPanelWidth)
  const commitPanelWidth = useUiStore((state) => state.commitPanelWidth)
  const setPanelResizing = useUiStore((state) => state.setPanelResizing)
  const [dragging, setDragging] = useState(false)
  /** 最新一次的目标宽度；松手提交它（state 里那份可能还没更新到这一帧） */
  const latest = useRef(0)

  // 浏览器或文件夹侧栏任一展开时都有同一根分栏线；两者共享宽度与拖拽手感。
  if (!panel.open && !folderPanelOpen) return null

  const { windowWidth } = panel
  const dock = folderPanelOpen ? 'left' : panel.dock
  const activeWidth = folderPanelOpen ? panel.openWidth : panel.width
  // 左侧揭开模式里，浏览器与画布无缝相接；右侧仍沿用卡片外侧的留白。
  const edge = dock === 'right' ? windowWidth - activeWidth - PANEL_CARD_GUTTER : activeWidth
  const hotZone = dock === 'right' ? { left: edge - 6 } : { left: edge }

  /** 指针位置 → 该夹在哪个宽度。右停靠时指针在面板左边，宽度是反过来的。 */
  const widthAt = (clientX: number): number => {
    // 左侧揭开模式没有卡片 gutter；右侧仍要先扣掉外侧 gutter。
    const raw = dock === 'right' ? windowWidth - clientX - PANEL_CARD_GUTTER : clientX
    return clampPanelWidth(raw, windowWidth)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    latest.current = widthAt(event.clientX)
    setPanelResizing(true)
    previewPanelWidth(latest.current)
    setDragging(true)
    // 合成事件（自检用）没有真实指针，capture 会抛；真实拖动不会
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 拿不到 capture 也不影响这一拖 */
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    latest.current = widthAt(event.clientX)
    previewPanelWidth(latest.current)
  }

  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    // 与 pointerdown 一样：合成事件没有真实 capture，但收尾状态仍必须落下。
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* 没有 capture 时无需释放 */
    }
    setDragging(false)
    commitPanelWidth(latest.current)
    setPanelResizing(false)
  }

  return (
    <div
      className="splitter"
      style={hotZone}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整浏览器与画布的比例"
      data-dragging={dragging}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <span className="splitter__line" />
    </div>
  )
}
