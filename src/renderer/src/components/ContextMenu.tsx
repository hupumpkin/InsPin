import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

/**
 * 通用右键菜单（设计规范 2.4.1）。
 *
 * 所有右键类菜单默认都用这一个组件：172 宽、pad 8、项高 36、r10、14px，
 * 危险项用 --danger，快捷键用弱化色。只有确实需要特殊结构的面板才另做。
 */

export type ContextMenuItem =
  | {
      label: string
      shortcut?: string
      disabled?: boolean
      danger?: boolean
      onSelect: () => void
    }
  | { divider: true }

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  ariaLabel?: string
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  ariaLabel = '菜单'
}: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const margin = 8
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin))
    })
  }, [x, y, items.length])

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('.context-menu__item:not(:disabled)')?.focus()
    const onPointerDown = (): void => onClose()
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>, step: number): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.context-menu__item:not(:disabled)')]
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = (current + step + buttons.length) % buttons.length
    buttons[next]?.focus()
    event.preventDefault()
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={ariaLabel}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') moveFocus(event, 1)
        if (event.key === 'ArrowUp') moveFocus(event, -1)
      }}
    >
      {items.map((item, index) =>
        'divider' in item ? (
          <div key={`divider-${index}`} className="context-menu__divider" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            className="context-menu__item"
            role="menuitem"
            data-danger={item.danger}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
          >
            <span className="context-menu__label">{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        )
      )}
    </div>
  )
}
