import type { CSSProperties } from 'react'

/** 用 SVG 的透明通道做遮罩，让图标继承按钮 / 文字的颜色。
 *  `<img>` 不能继承 currentColor，mask 可以；设计稿导出的单色图标统一走这里。 */
export default function MaskIcon({ src, className, style }: {
  src: string
  className?: string
  style?: CSSProperties
}): React.JSX.Element {
  return (
    <span
      className={className ? `icon-mask ${className}` : 'icon-mask'}
      style={{
        ...style,
        WebkitMaskImage: `url("${src}")`,
        maskImage: `url("${src}")`
      }}
      aria-hidden="true"
    />
  )
}
