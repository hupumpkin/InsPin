/**
 * 标签、导航、关闭与加号使用 Relay 节点 29:138 导出的原始路径。
 * 角落浏览器标识改用 42:720 导出的组件图标，通过遮罩跟随 currentColor。
 *
 * 这些不是通用 icon 库的近似图标：保留路径能避免笔画、端点与色值在不同图标库中漂移。
 */

import MaskIcon from './MaskIcon'
import browserMarkIcon from '../assets/icons/relay-browser-mark.svg'

interface IconProps {
  className?: string
}

export function BrowserMarkIcon({ className }: IconProps): React.JSX.Element {
  return <MaskIcon className={className} src={browserMarkIcon} />
}

export function TabGlobeIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.343 2.343A7.93 7.93 0 0 0 0 8a7.93 7.93 0 0 0 2.343 5.657A7.928 7.928 0 0 0 8 16a7.928 7.928 0 0 0 5.657-2.343A7.928 7.928 0 0 0 16 8a7.928 7.928 0 0 0-2.343-5.657A7.928 7.928 0 0 0 8 0a7.93 7.93 0 0 0-5.657 2.343ZM1.163 8.571a6.86 6.86 0 0 0 1.804 3.706A6.86 6.86 0 0 0 8 14.286a6.86 6.86 0 0 0 5.033-2.009 6.86 6.86 0 0 0 1.804-3.706H1.163Zm13.674-1.143a6.86 6.86 0 0 0-1.804-3.706A6.86 6.86 0 0 0 8 1.714a6.86 6.86 0 0 0-5.033 2.008 6.86 6.86 0 0 0-1.804 3.706h13.674Z" />
      <path d="M7.429 0C5.456 2.425 4.57 5.286 4.57 8s.886 5.575 2.859 8c.361 0 .714-.02 1.057-.068C10.086 13.63 10.858 10.834 10.858 8S10.086 2.37 8.486.068A7.969 7.969 0 0 0 7.429 0Zm.571 1.616C9.104 3.436 9.715 5.65 9.715 8S9.104 12.564 8 14.384C6.896 12.564 6.285 10.35 6.285 8S6.896 3.436 8 1.616Z" />
    </svg>
  )
}

export function TabCloseIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 8 8" aria-hidden="true" focusable="false">
      <path d="M7.339 7.887a.387.387 0 0 0 .548-.548L4.547 4 7.887.661a.387.387 0 0 0-.548-.548L4 3.453.661.113a.387.387 0 0 0-.548.548L3.453 4 .113 7.339a.387.387 0 0 0 .548.548L4 4.547l3.339 3.34Z" />
    </svg>
  )
}

export function NewTabIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 13.333 13.333" aria-hidden="true" focusable="false">
      <path d="M7.333 6h6v1.333h-6v6H6v-6H0V6h6V0h1.333v6Z" />
    </svg>
  )
}
