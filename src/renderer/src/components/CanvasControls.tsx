import { useEffect, useRef, useState } from 'react'
import { Magnifier, Settings2 } from 'reicon-react'
import ColorisInput from './ColorisInput'
import MaskIcon from './MaskIcon'
import { CANVAS_COLORS, useUiStore } from '../state/ui'
import canvasColorIcon from '../assets/icons/relay-canvas-color.svg'
import canvasLayersIcon from '../assets/icons/relay-canvas-layers.svg'
import canvasMoreIcon from '../assets/icons/relay-more.svg'
import panelCloseIcon from '../assets/icons/relay-panel-close.svg'

type OpenMenu = 'color' | 'zoom' | 'more' | null

interface CanvasControlsProps {
  zoom: number
  canZoom: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onSetZoom: (percent: number) => void
}

/**
 * 画布右下角的上下文控制区。
 *
 * 这里把常驻控制收成一条轻量工具带；实际的图层树和对象检查器仍沿用原组件，
 * 只把它们的弹出位置锚定到这一组控制附近。
 */
export default function CanvasControls({
  zoom,
  canZoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onSetZoom
}: CanvasControlsProps): React.JSX.Element {
  const layersOpen = useUiStore((state) => state.layersOpen)
  const toggleLayers = useUiStore((state) => state.toggleLayers)
  const closeCanvasPanels = useUiStore((state) => state.closeCanvasPanels)
  const canvasColor = useUiStore((state) => state.canvasColor)
  const setCanvasColor = useUiStore((state) => state.setCanvasColor)
  const openSettings = useUiStore((state) => state.openSettings)
  const collapsed = useUiStore((state) => state.canvasControlsCollapsed)
  const [menu, setMenu] = useState<OpenMenu>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const closeOnOutside = (event: PointerEvent): void => {
      const target = event.target
      // 取色面板挂在 body 上，不在弹层 DOM 里；点它不能把弹层收掉。
      if (target instanceof Element && target.closest('.clr-picker')) return
      if (!rootRef.current?.contains(target as Node)) setMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  const toggleMenu = (next: Exclude<OpenMenu, null>): void => {
    closeCanvasPanels()
    setMenu((current) => (current === next ? null : next))
  }

  const selectColor = (color: string): void => {
    setCanvasColor(color)
    setMenu(null)
  }

  const selectZoom = (percent: number): void => {
    onSetZoom(percent)
    setMenu(null)
  }

  return (
    <div className="canvas-controls" ref={rootRef} role="toolbar" aria-label="画布视图控制">
      <button
        type="button"
        className="canvas-control canvas-control--more"
        data-visible={collapsed > 0}
        aria-label="更多画布功能"
        aria-hidden={collapsed === 0}
        tabIndex={collapsed > 0 ? 0 : -1}
        aria-pressed={collapsed >= 1 && layersOpen}
        aria-expanded={menu === 'more'}
        onClick={() => setMenu((current) => (current === 'more' ? null : 'more'))}
      >
        <MaskIcon className="canvas-control__icon" src={canvasMoreIcon} />
        <span className="canvas-control__tip" role="tooltip">更多画布功能</span>
      </button>

      <button
        type="button"
        className="canvas-control"
        data-collapsed={collapsed >= 1}
        aria-label="画布与图层"
        aria-pressed={layersOpen}
        tabIndex={collapsed >= 1 ? -1 : 0}
        aria-hidden={collapsed >= 1}
        onDragStart={(event) => event.preventDefault()}
        onClick={() => {
          setMenu(null)
          toggleLayers()
        }}
      >
        <MaskIcon className="canvas-control__icon" src={canvasLayersIcon} />
        <span className="canvas-control__tip" role="tooltip">画布与图层</span>
      </button>

      <button
        type="button"
        className="canvas-control"
        data-collapsed={collapsed >= 2}
        aria-label="自定义画布"
        aria-expanded={menu === 'color'}
        tabIndex={collapsed >= 2 ? -1 : 0}
        aria-hidden={collapsed >= 2}
        onDragStart={(event) => event.preventDefault()}
        onClick={() => toggleMenu('color')}
      >
        <MaskIcon className="canvas-control__icon" src={canvasColorIcon} />
        <span className="canvas-control__tip" role="tooltip">自定义画布</span>
      </button>

      <button
        type="button"
        className="canvas-control"
        data-collapsed={collapsed >= 3}
        aria-label="更多设置"
        tabIndex={collapsed >= 3 ? -1 : 0}
        aria-hidden={collapsed >= 3}
        onClick={() => {
          setMenu(null)
          openSettings('general')
        }}
      >
        <Settings2 size={24} weight="Outline" />
        <span className="canvas-control__tip" role="tooltip">更多设置</span>
      </button>

      <span className="canvas-controls__separator" data-collapsed={collapsed >= 4} aria-hidden="true" />

      <button
        type="button"
        className="canvas-control canvas-control--zoom"
        data-collapsed={collapsed >= 4}
        aria-label={`视图比例：当前 ${zoom}%`}
        aria-expanded={menu === 'zoom'}
        aria-hidden={collapsed >= 4}
        tabIndex={collapsed >= 4 ? -1 : 0}
        disabled={!canZoom}
        onClick={() => toggleMenu('zoom')}
      >
        {zoom}%
        <span className="canvas-control__tip" role="tooltip">视图比例</span>
      </button>

      {menu === 'color' && (
        <section className="canvas-popover canvas-popover--color" aria-label="画布颜色">
          <div className="canvas-popover__header">
            <p className="canvas-popover__title">画布颜色</p>
            <button type="button" className="canvas-popover__close" aria-label="关闭画布颜色" onClick={() => setMenu(null)}>
              <img src={panelCloseIcon} alt="" />
            </button>
          </div>

          <div className="canvas-color-grid">
            {CANVAS_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                className="canvas-color-swatch"
                aria-label={`使用${color.label}`}
                aria-pressed={canvasColor.toLowerCase() === color.value}
                style={{ background: color.value }}
                onClick={() => selectColor(color.value)}
              >
                <span className="sr-only">{color.label}</span>
              </button>
            ))}
          </div>

          <div className="canvas-popover__divider" aria-hidden="true" />

          <label
            className="canvas-color-custom"
            title="自定义颜色"
            data-active={!CANVAS_COLORS.some((color) => color.value === canvasColor.toLowerCase())}
          >
            <span>自定义颜色</span>
            <span className="canvas-color-custom__control">
              <output>{canvasColor.toUpperCase()}</output>
              <ColorisInput
                className="canvas-color-custom__input"
                label="自定义画布颜色"
                value={canvasColor}
                style={{ backgroundColor: canvasColor }}
                onChange={setCanvasColor}
              />
            </span>
          </label>
        </section>
      )}

      {menu === 'zoom' && (
        <section className="canvas-popover canvas-popover--zoom" aria-label="缩放">
          <div className="canvas-popover__actions">
            <button type="button" onClick={onZoomIn}>放大 <kbd>⌘ +</kbd></button>
            <button type="button" onClick={onZoomOut}>缩小 <kbd>⌘ −</kbd></button>
            <button type="button" onClick={() => { onFit(); setMenu(null) }}>显示画布所有元素 <kbd>⇧ 1</kbd></button>
          </div>
          <div className="canvas-popover__divider" />
          <div className="canvas-zoom-presets" role="group" aria-label="缩放预设">
            {[50, 100, 200].map((percent) => (
              <button
                key={percent}
                type="button"
                aria-pressed={zoom === percent}
                onClick={() => selectZoom(percent)}
              >
                {percent}%
              </button>
            ))}
          </div>
        </section>
      )}

      {collapsed > 0 && menu === 'more' && (
        <section className="canvas-popover canvas-popover--more" aria-label="更多画布功能">
          <div className="canvas-popover__actions">
            {collapsed >= 1 && (
              <button
                type="button"
                onClick={() => {
                  setMenu(null)
                  toggleLayers()
                }}
              >
                <MaskIcon className="canvas-more__icon" src={canvasLayersIcon} />
                图层
              </button>
            )}
            {collapsed >= 2 && (
              <button type="button" onClick={() => setMenu('color')}>
                <MaskIcon className="canvas-more__icon" src={canvasColorIcon} />
                画布颜色
              </button>
            )}
            {collapsed >= 3 && (
              <button
                type="button"
                onClick={() => {
                  setMenu(null)
                  openSettings('general')
                }}
              >
                <Settings2 size={18} weight="Outline" />
                设置
              </button>
            )}
            {collapsed >= 4 && (
              <>
                <div className="canvas-popover__divider" />
                <button type="button" onClick={() => setMenu('zoom')}>
                  <Magnifier size={18} />
                  缩放 {zoom}%
                </button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
