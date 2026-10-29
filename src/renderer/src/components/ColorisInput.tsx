import { useEffect, useRef, type CSSProperties } from 'react'

const HEX = /^#[0-9a-f]{6}$/i

interface Props {
  value: string
  onChange: (value: string) => void
  label: string
  className?: string
  style?: CSSProperties
}

/**
 * 绑定 Coloris 的取色输入框。只读，颜色由取色面板写回；
 * 面板每次拖动都会在 input 上派发原生 input 事件，这里直接监听，
 * 避开 React 受控输入对程序化赋值的去重。
 */
export default function ColorisInput({ value, onChange, label, className, style }: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const handle = (): void => {
      if (HEX.test(input.value)) onChangeRef.current(input.value.toLowerCase())
    }
    input.addEventListener('input', handle)
    return () => input.removeEventListener('input', handle)
  }, [])

  return (
    <input
      ref={inputRef}
      data-coloris
      readOnly
      type="text"
      aria-label={label}
      className={className}
      style={style}
      value={value}
    />
  )
}
