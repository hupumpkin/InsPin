import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AutoLayoutProps, FrameNode } from '../../../shared/node'
import { gridColumnsFor, gridColumnsForRows, gridRowsFor } from '../../../shared/auto-layout'
import autoLayoutHorizontalIcon from '../assets/icons/relay-auto-layout-horizontal.svg'
import autoLayoutVerticalIcon from '../assets/icons/relay-auto-layout-vertical.svg'
import autoLayoutGridIcon from '../assets/icons/relay-auto-layout-grid.svg'
import MaskIcon from './MaskIcon'

/**
 * 自动布局的"情境工具栏"（路线图 D4b.6 / D4b.10）。
 *
 * 只在选中一个自动布局容器时出现；参数改动走一条命令，求解器立刻重排且可撤销。
 */

interface AutoLayoutToolbarProps {
  node: FrameNode
  childCount: number
  onPatch: (patch: Partial<AutoLayoutProps>) => void
  onRemove: () => void
  style: CSSProperties
  /** 交给外面量宽度用（工具栏要比选中对象宽，需要夹在视口内） */
  containerRef?: (el: HTMLDivElement | null) => void
}

const DIRECTIONS = [
  { mode: 'horizontal' as const, label: '横向排列', iconSrc: autoLayoutGridIcon },
  { mode: 'vertical' as const, label: '纵向排列', iconSrc: autoLayoutVerticalIcon },
  { mode: 'grid' as const, label: '网格排列', iconSrc: autoLayoutHorizontalIcon }
]

export default function AutoLayoutToolbar({
  node,
  childCount,
  onPatch,
  onRemove,
  style,
  containerRef
}: AutoLayoutToolbarProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const props = node.props

  const setDirection = (mode: AutoLayoutProps['layoutMode']): void => {
    if (mode === props.layoutMode) return
    onPatch(mode === 'grid' ? { layoutMode: mode, gridColumns: gridColumnsFor(childCount) } : { layoutMode: mode })
  }

  const setPadding = (value: number): void => {
    onPatch({ padding: { top: value, right: value, bottom: value, left: value } })
  }

  useEffect(() => {
    if (!settingsOpen) return
    const close = (event: PointerEvent): void => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as globalThis.Node)) setSettingsOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [settingsOpen])

  return (
    <div
      className="altoolbar"
      style={style}
      ref={containerRef}
      role="toolbar"
      aria-label="自动布局"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="altoolbar__group" role="group" aria-label="方向">
        {DIRECTIONS.map(({ mode, label, iconSrc }) => (
          <button
            key={mode}
            type="button"
            className="altoolbar__btn"
            aria-label={label}
            title={label}
            aria-pressed={props.layoutMode === mode}
            onClick={() => setDirection(mode)}
          >
            <MaskIcon className="altoolbar__direction-icon" src={iconSrc} />
          </button>
        ))}

        <div className="altoolbar__menu-wrap" ref={settingsRef}>
          <button type="button" className="altoolbar__btn altoolbar__btn--wide" aria-expanded={settingsOpen} aria-pressed={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
            间距
          </button>
          {settingsOpen && (
            <div className="altoolbar__popover altoolbar__popover--settings" role="dialog" aria-label="自动排列设置">
              <NumberField label="内间距" value={props.padding.top} onCommit={setPadding} />
              <NumberField label="外边距" value={props.itemSpacing} onCommit={(v) => onPatch({ itemSpacing: v })} />
              {props.layoutMode === 'grid' && (
                <NumberField
                  label="横排数量"
                  value={gridRowsFor(childCount, props.gridColumns)}
                  min={1}
                  onCommit={(v) =>
                    onPatch({ gridColumns: gridColumnsForRows(childCount, Math.max(1, Math.round(v))) })
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>

      <span className="altoolbar__sep" />

      <button type="button" className="altoolbar__btn altoolbar__btn--wide" title="解除自动布局 (⇧⌘G)" onClick={onRemove}>
        解除
      </button>
    </div>
  )
}

interface NumberFieldProps {
  label: string
  value: number
  min?: number
  onCommit: (value: number) => void
}

/**
 * 数字输入。**改动在回车/失焦时提交**（不是每敲一个字就提交一条命令）——
 * 这样一次编辑在历史里只占一步，⌘Z 一下退回去；提交后求解器立刻重排。
 */
function NumberField({ label, value, min = 0, onCommit }: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  // 外部（撤销/换容器）改了值就同步回来
  useEffect(() => setDraft(String(value)), [value])

  const commit = (raw: string): void => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = Math.max(min, Math.round(parsed))
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <label className="altoolbar__field">
      <span className="altoolbar__field-label">{label}</span>
      <input
        className="altoolbar__input"
        type="number"
        min={min}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit((event.target as HTMLInputElement).value)
        }}
      />
    </label>
  )
}
