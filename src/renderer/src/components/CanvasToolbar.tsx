import { useEffect, useRef, useState } from 'react'
import type { ToolId } from '../state/ui'
import { useUiStore } from '../state/ui'
import MaskIcon from './MaskIcon'
import selectIcon from '../assets/icons/relay-select.svg'
import shapeIcon from '../assets/icons/relay-shape.svg'
import textIcon from '../assets/icons/relay-text.svg'
import menuSelectIcon from '../assets/icons/relay-menu-select.svg'
import handIcon from '../assets/icons/relay-menu-hand.svg'
import rectangleIcon from '../assets/icons/relay-rectangle.svg'
import ellipseIcon from '../assets/icons/relay-ellipse.svg'
import lineIcon from '../assets/icons/relay-line.svg'

type OpenMenu = 'pointer' | 'shape' | null

/** 画布工具条：带分支的工具在上方展开，底栏保持短而清晰。 */
export default function CanvasToolbar(): React.JSX.Element {
  const tool = useUiStore((state) => state.tool)
  const setTool = useUiStore((state) => state.setTool)
  const [menu, setMenu] = useState<OpenMenu>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  const choose = (next: ToolId): void => {
    setTool(next)
    setMenu(null)
  }
  const pointerActive = tool === 'select' || tool === 'hand'
  const shapeActive = tool.startsWith('shape-')

  return (
    <div className="toolbar" ref={rootRef} role="toolbar" aria-label="画布工具">
      <ToolMenu
        label="选择"
        iconSrc={selectIcon}
        active={pointerActive}
        open={menu === 'pointer'}
        onToggle={() => setMenu((value) => (value === 'pointer' ? null : 'pointer'))}
      >
        <MenuAction label="选择" shortcut="V" iconSrc={menuSelectIcon} selected={tool === 'select'} onClick={() => choose('select')} />
        <MenuAction label="移动" shortcut="H" iconSrc={handIcon} selected={tool === 'hand'} onClick={() => choose('hand')} />
      </ToolMenu>

      <ToolMenu
        label="形状"
        iconSrc={shapeIcon}
        active={shapeActive}
        open={menu === 'shape'}
        onToggle={() => setMenu((value) => (value === 'shape' ? null : 'shape'))}
      >
        <MenuAction label="矩形" iconSrc={rectangleIcon} selected={tool === 'shape-rectangle'} onClick={() => choose('shape-rectangle')} />
        <MenuAction label="圆形" iconSrc={ellipseIcon} selected={tool === 'shape-ellipse'} onClick={() => choose('shape-ellipse')} />
        <MenuAction label="线条" iconSrc={lineIcon} selected={tool === 'shape-line'} onClick={() => choose('shape-line')} />
      </ToolMenu>

      <ToolButton label="文本" iconSrc={textIcon} active={tool === 'text'} onClick={() => choose('text')} />
    </div>
  )
}

function ToolButton({ label, iconSrc, active, onClick }: {
  label: string
  iconSrc: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="tool" aria-label={label} aria-pressed={active} title={label} onClick={onClick}>
      <MaskIcon className="tool__icon" src={iconSrc} />
    </button>
  )
}

function ToolMenu({ label, iconSrc, active, open, onToggle, children }: {
  label: string
  iconSrc: string
  active: boolean
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="toolbar__menu-wrap">
      <ToolButton label={label} iconSrc={iconSrc} active={active} onClick={onToggle} />
      {open && <div className="toolbar__menu" role="menu">{children}</div>}
    </div>
  )
}

function MenuAction({ label, shortcut, iconSrc, selected, onClick }: {
  label: string
  shortcut?: string
  iconSrc: string
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} onClick={onClick}>
      <img className="toolbar__menu-icon" src={iconSrc} alt="" />
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  )
}
