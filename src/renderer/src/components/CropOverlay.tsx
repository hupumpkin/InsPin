import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Camera, Refresh, TickCircle } from 'reicon-react'
import type { ImageSearchEngineId } from '../../../shared/image-search'
import type { Viewport } from '../../../shared/ipc'
import type { AssetCrop } from '../../../shared/node'
import type { Rect } from '../canvas/hit-test'
import { cursorForHandle } from '../canvas/handles'
import {
  CROP_CORNERS,
  CROP_HANDLES,
  commitCropBox,
  cropHandleAt,
  cropOfPlane,
  cropPixelSize,
  fitSelectionAspect,
  initialCropPlane,
  moveImage,
  moveSelection,
  pointInRect,
  resizeSelection,
  screenAabb,
  screenPointToLocal,
  zoomImage,
  type CropHandle,
  type CropPlane
} from '../canvas/crop-plane'
import { toScreen } from '../canvas/viewport'

export interface CropResult {
  box: Rect
  crop: AssetCrop
}

interface CropOverlayProps {
  /** 进入裁切时的节点盒子（世界坐标） */
  box: Rect
  rotation: number
  /** 进入裁切前的裁切区域；取消和“还原”都以它为基准 */
  crop: AssetCrop
  naturalWidth: number
  naturalHeight: number
  url: string
  viewport: Viewport
  stage: { w: number; h: number }
  /** 左侧浏览器面板盖住的宽度，工具条不许钻到它下面 */
  insetLeft: number
  /** crop = 改画布上的裁切框；search = 只框一块去搜图，不改画布 */
  purpose?: 'crop' | 'search'
  searchEngines?: { id: ImageSearchEngineId; label: string }[]
  onDraft: (result: CropResult) => void
  onApply: (result: CropResult) => void
  onSearch?: (result: CropResult, engineId: ImageSearchEngineId) => void
  onCancel: () => void
}

const PRESETS = [
  { label: '自由', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '16:9', ratio: 16 / 9 }
] as const

/** 手柄命中区（屏幕像素）：放大画布后仍然好点。 */
const HANDLE_HIT = 12
/** 裁切框最小边（屏幕像素） */
const MIN_SELECTION = 24
/** 图片最多放大到进入时的 8 倍，再大就只是糊了 */
const MAX_ZOOM = 8
const TOOLBAR_HEIGHT = 44
/** 工具条估算半宽，用来夹在画布内（真实宽度由 CSS 决定） */
const TOOLBAR_HALF = 250

type DragMode = 'image' | 'selection' | 'resize'

interface DragState {
  mode: DragMode
  handle: CropHandle | null
  start: { x: number; y: number }
  plane: CropPlane
}

/**
 * 可视化裁切（对齐 Cropper.js / Lovart 的交互）：
 *   - 拖框内：移动裁切窗口；
 *   - 拖框外：平移图片；
 *   - 拖八个手柄：缩放裁切窗口（比例预设生效时等比，自由模式按住 ⇧ 临时锁比例）；
 *   - 滚轮：以光标为锚点缩放图片。
 *
 * 预览完全用 DOM 画（图片 + 遮罩 + 手柄），不经过 Pixi，所以拖起来不会等 GPU 重建。
 * 松手前不动模型；“完成”时才把裁切框同时写回节点盒子和裁切区域，所见即所得。
 */
export default function CropOverlay({
  box,
  rotation,
  crop,
  naturalWidth,
  naturalHeight,
  url,
  viewport,
  stage,
  insetLeft,
  purpose = 'crop',
  searchEngines = [],
  onDraft,
  onApply,
  onSearch,
  onCancel
}: CropOverlayProps): React.JSX.Element {
  const [plane, setPlane] = useState<CropPlane>(() => initialCropPlane(box, crop))
  const [aspect, setAspect] = useState<number | null>(null)
  const [engineMenuOpen, setEngineMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const planeRef = useRef(plane)
  planeRef.current = plane

  const zoom = viewport.zoom > 0 ? viewport.zoom : 1
  const minSelection = MIN_SELECTION / zoom
  const initialImage = initialCropPlane(box, crop).image
  const center = toScreen(viewport, { x: box.x + box.w / 2, y: box.y + box.h / 2 })

  const resultOf = (next: CropPlane): CropResult => ({
    box: commitCropBox(box, rotation, next.selection),
    crop: cropOfPlane(next)
  })

  const commit = (next: CropPlane): void => {
    // 连续滚轮事件可能在 React 重渲染之前连发，先同步 ref，缩放才不会被吞掉。
    planeRef.current = next
    setPlane(next)
    onDraft(resultOf(next))
  }

  const toLocal = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const root = rootRef.current
    if (!root) return { x: 0, y: 0 }
    const rect = root.getBoundingClientRect()
    return screenPointToLocal(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      center,
      box,
      rotation,
      zoom
    )
  }

  // 滚轮必须用非被动监听：React 的合成 onWheel 是 passive 的，拦不住页面滚动。
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const rect = root.getBoundingClientRect()
      const current = planeRef.current
      const point = screenPointToLocal(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        center,
        box,
        rotation,
        zoom
      )
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * stage.h
            : event.deltaY
      if (delta === 0) return
      commit({
        ...current,
        image: zoomImage(current.image, current.selection, point, Math.exp(-delta * 0.0015), initialImage.w * MAX_ZOOM)
      })
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [box, center.x, center.y, initialImage.w, rotation, stage.h, zoom])

  const updateCursor = (point: { x: number; y: number }): void => {
    const root = rootRef.current
    if (!root) return
    const handle = cropHandleAt(plane.selection, point, HANDLE_HIT / zoom)
    root.style.cursor = handle
      ? cursorForHandle(handle)
      : pointInRect(point, plane.selection)
        ? 'move'
        : pointInRect(point, plane.image)
          ? 'grab'
          : 'default'
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    setEngineMenuOpen(false)
    const point = toLocal(event)
    const handle = cropHandleAt(plane.selection, point, HANDLE_HIT / zoom)
    const mode: DragMode | null = handle
      ? 'resize'
      : pointInRect(point, plane.selection)
        ? 'selection'
        : pointInRect(point, plane.image)
          ? 'image'
          : null
    if (!mode) return
    dragRef.current = { mode, handle, start: point, plane }
    rootRef.current?.setPointerCapture(event.pointerId)
    if (rootRef.current) rootRef.current.style.cursor = handle ? cursorForHandle(handle) : 'grabbing'
    event.preventDefault()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = toLocal(event)
    const drag = dragRef.current
    if (!drag) {
      updateCursor(point)
      return
    }
    const dx = point.x - drag.start.x
    const dy = point.y - drag.start.y
    if (drag.mode === 'selection') {
      commit({ ...drag.plane, selection: moveSelection(drag.plane.selection, dx, dy, drag.plane.image) })
      return
    }
    if (drag.mode === 'image') {
      commit({ ...drag.plane, image: moveImage(drag.plane.image, dx, dy, drag.plane.selection) })
      return
    }
    if (!drag.handle) return
    const locked = aspect ?? (event.shiftKey ? drag.plane.selection.w / drag.plane.selection.h : null)
    commit({
      ...drag.plane,
      selection: resizeSelection(drag.plane.selection, drag.handle, dx, dy, drag.plane.image, minSelection, locked)
    })
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId)
    }
  }

  const choosePreset = (ratio: number | null): void => {
    setAspect(ratio)
    if (ratio === null) return
    commit({ ...plane, selection: fitSelectionAspect(plane.selection, ratio) })
  }

  const reset = (): void => {
    setAspect(null)
    // “还原”= 去掉裁切：整张原图按进入时的像素密度铺开，裁切框直接等于整张图。
    commit({ image: initialImage, selection: { ...initialImage } })
  }

  const localBox = (rect: Rect): CSSProperties => ({
    left: (rect.x - box.w / 2) * zoom,
    top: (rect.y - box.h / 2) * zoom,
    width: rect.w * zoom,
    height: rect.h * zoom
  })

  const pixels = cropPixelSize(plane, naturalWidth, naturalHeight)
  const aabb = screenAabb(plane.selection, box, rotation, viewport)
  // 与选中工具条一致：贴对象 8px，并让出左侧面板。
  const minLeft = insetLeft + 8
  const maxCenter = Math.max(minLeft + TOOLBAR_HALF, stage.w - 8 - TOOLBAR_HALF)
  const toolbarLeft = Math.min(Math.max((aabb.left + aabb.right) / 2, minLeft + TOOLBAR_HALF), maxCenter)
  const above = aabb.top - TOOLBAR_HEIGHT - 8
  const below = aabb.bottom + 8
  const toolbarTop = above >= 8
    ? above
    : Math.min(below, Math.max(8, stage.h - TOOLBAR_HEIGHT - 8))

  return (
    <div
      className="crop-overlay"
      ref={rootRef}
      role="dialog"
      aria-label={purpose === 'search' ? '框选局部搜索' : '裁切图片'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="crop-overlay__anchor"
        style={{ left: center.x, top: center.y, transform: `rotate(${rotation}deg)` }}
      >
        <img className="crop-overlay__image" src={url} alt="" draggable={false} style={localBox(plane.image)} />
        {/* 一块透明的框 + 巨大的外阴影 = 裁切框外全部压暗，框内保持原亮度 */}
        <div className="crop-overlay__mask" style={localBox(plane.selection)} />
        <div className="crop-overlay__frame" style={localBox(plane.selection)}>
          <div className="crop-overlay__grid">
            <i style={{ left: '33.333%' }} />
            <i style={{ left: '66.666%' }} />
            <i data-axis="h" style={{ top: '33.333%' }} />
            <i data-axis="h" style={{ top: '66.666%' }} />
          </div>
          {CROP_HANDLES.map((handle) => (
            <span
              key={handle}
              className="crop-overlay__handle"
              data-handle={handle}
              data-corner={CROP_CORNERS.includes(handle) ? 'true' : undefined}
            />
          ))}
        </div>
      </div>

      <div
        className="crop-toolbar"
        style={{ left: toolbarLeft, top: toolbarTop }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="crop-toolbar__presets" role="group" aria-label="裁切比例">
          {PRESETS.map(({ label, ratio }) => (
            <button
              key={label}
              type="button"
              className="crop-toolbar__preset"
              data-active={aspect === ratio ? 'true' : undefined}
              onClick={() => choosePreset(ratio)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="crop-toolbar__divider" />
        <span className="crop-toolbar__size">{pixels.w} × {pixels.h}</span>
        <span className="crop-toolbar__divider" />
        <div className="crop-toolbar__actions">
          {purpose === 'crop' && (
            <button type="button" className="crop-toolbar__ghost" onClick={reset} title="还原完整图片">
              <Refresh size={18} /> 还原
            </button>
          )}
          <button type="button" className="crop-toolbar__ghost" onClick={onCancel}>取消</button>
          {purpose === 'search' ? (
            <div className="crop-toolbar__menu-wrap">
              <button
                type="button"
                className="crop-toolbar__apply"
                aria-expanded={engineMenuOpen}
                onClick={() => setEngineMenuOpen((open) => !open)}
              >
                <Camera size={18} /> 搜图
              </button>
              {engineMenuOpen && (
                <div className="crop-toolbar__engines" role="menu" aria-label="选择搜图站点">
                  {searchEngines.map((engine) => (
                    <button
                      key={engine.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEngineMenuOpen(false)
                        onSearch?.(resultOf(plane), engine.id)
                      }}
                    >
                      {engine.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button type="button" className="crop-toolbar__apply" onClick={() => onApply(resultOf(plane))}>
              <TickCircle size={18} /> 完成
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
