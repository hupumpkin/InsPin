import type { ReactNode } from 'react'

interface CornerButtonProps {
  corner: 'top-left' | 'mid-left' | 'low-left' | 'bottom-left'
  label: string
  onClick?: () => void
  /** 开关类按钮的"已打开"态：深底白图标，一眼看出它是开着的（浏览器面板就是这样） */
  pressed?: boolean
  children: ReactNode
}

export default function CornerButton({
  corner,
  label,
  onClick,
  pressed = false,
  children
}: CornerButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`corner corner--${corner}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
