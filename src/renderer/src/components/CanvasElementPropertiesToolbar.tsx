import { useEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import type { CanvasElement } from '../../../shared/node'
import ColorisInput from './ColorisInput'
import MaskIcon from './MaskIcon'
import cornerRadiusIcon from '../assets/icons/relay-corner-radius.svg'
import textPropertyIcon from '../assets/icons/relay-text-property.svg'

interface Props {
  elementId: string
  element: CanvasElement
  style: CSSProperties
  size: { w: number; h: number }
  containerRef: Ref<HTMLDivElement>
  onChange: (elementId: string, next: CanvasElement) => void
  onResize: (elementId: string, next: { w: number; h: number }) => void
}

/** 贴近对象的轻量属性条，规格与画布上的图文工具条保持一致。 */
export default function CanvasElementPropertiesToolbar({ elementId, element, style, size, containerRef, onChange, onResize }: Props): React.JSX.Element {
  /**
   * 数值编辑期间画布选择随时可能变（点空白提交、点别的对象）。焦点落下时把
   * “这次编辑属于哪个节点”记下来，回车/失焦时仍写回原来那个节点。
   */
  const targetRef = useRef<{ id: string; element: CanvasElement; size: { w: number; h: number } } | null>(null)
  const begin = (): void => {
    targetRef.current = { id: elementId, element, size }
  }
  const commitElement = (next: CanvasElement): void => {
    const target = targetRef.current
    if (!target) return
    onChange(target.id, next)
    targetRef.current = null
  }
  const commitSize = (next: { w: number; h: number }): void => {
    const target = targetRef.current
    if (!target) return
    onResize(target.id, next)
    targetRef.current = null
  }

  if (element.kind === 'text') {
    return (
      <div className="element-props" style={style} aria-label="文本样式" ref={containerRef}>
        <div className="element-props__group">
          <ColorField label="文字颜色" value={element.color} onChange={(color) => onChange(elementId, { ...element, color })} />
          <CommittedNumberField
            label="字号"
            iconSrc={textPropertyIcon}
            className="element-props__number--fixed"
            value={element.fontSize}
            min={10}
            max={160}
            onBegin={begin}
            onCommit={(fontSize) => {
              const target = targetRef.current?.element
              const base = target?.kind === 'text' ? target : element
              commitElement({ ...base, fontSize })
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="element-props" style={style} aria-label="形状样式" ref={containerRef}>
      <div className="element-props__group">
        <ColorField label="填充颜色" value={element.fill} onChange={(fill) => onChange(elementId, { ...element, fill })} />
        {element.shape === 'rectangle' && (
          <CommittedNumberField
            label="圆角"
            iconSrc={cornerRadiusIcon}
            value={element.cornerRadius}
            min={0}
            max={160}
            onBegin={begin}
            onCommit={(cornerRadius) => {
              const target = targetRef.current?.element
              const base = target?.kind === 'shape' ? target : element
              commitElement({ ...base, cornerRadius })
            }}
          />
        )}
      </div>
      <span className="element-props__divider" />
      <div className="element-props__group">
        <CommittedNumberField
          label="宽度"
          bold="W"
          className="element-props__dimension"
          value={size.w}
          min={1}
          max={10000}
          onBegin={begin}
          onCommit={(w) => commitSize({ w, h: targetRef.current?.size.h ?? size.h })}
        />
        <CommittedNumberField
          label="高度"
          bold="H"
          className="element-props__dimension"
          value={size.h}
          min={1}
          max={10000}
          onBegin={begin}
          onCommit={(h) => commitSize({ w: targetRef.current?.size.w ?? size.w, h })}
        />
      </div>
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return (
    <label className="element-props__color" title={label}>
      <span className="element-props__swatch" style={{ backgroundColor: value }} />
      <ColorisInput className="element-props__color-input" label={label} value={value} onChange={onChange} />
    </label>
  )
}

/**
 * 数值输入：输入过程中只改草稿，回车或失焦才写回画布。
 * 清空时用灰字占位记忆旧值——想换新数字可以先删干净，直接离开则保留原值。
 */
function CommittedNumberField({ label, iconSrc, bold, className, value, min, max, onBegin, onCommit }: {
  label: string
  iconSrc?: string
  bold?: string
  className?: string
  value: number
  min: number
  max: number
  onBegin: () => void
  onCommit: (value: number) => void
}): React.JSX.Element {
  const current = String(Math.round(value))
  const [draft, setDraft] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const commitRef = useRef<() => void>(() => {})

  const settle = (apply: boolean): void => {
    const raw = pendingRef.current
    pendingRef.current = null
    setDraft(null)
    if (!apply || raw === null) return
    const trimmed = raw.trim()
    if (trimmed === '') return
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    const next = Math.max(min, Math.min(max, Math.round(parsed)))
    if (next !== Math.round(value)) onCommit(next)
  }
  // 组件被卸载（比如直接点了别的对象）时也别丢掉刚输入的数值。
  commitRef.current = () => settle(true)
  useEffect(() => () => commitRef.current(), [])

  const shown = draft ?? current
  return (
    <label className={`element-props__number${className ? ` ${className}` : ''}`} title={label}>
      {iconSrc ? <MaskIcon className="element-props__icon" src={iconSrc} /> : <b>{bold}</b>}
      <input
        aria-label={label}
        inputMode="numeric"
        type="text"
        size={Math.max(2, current.length, shown.length)}
        value={shown}
        placeholder={current}
        onFocus={(event) => {
          onBegin()
          pendingRef.current = current
          setDraft(current)
          // 等这一下点击的默认行为（落光标）结束后再全选，直接输入就会替换旧值。
          const input = event.currentTarget
          window.requestAnimationFrame(() => {
            if (document.activeElement === input) input.select()
          })
        }}
        onChange={(event) => {
          pendingRef.current = event.target.value
          setDraft(event.target.value)
        }}
        onBlur={() => settle(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            settle(true)
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            settle(false)
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}
