/** 画布操作反馈：视觉由 Toast 组件承接，状态在 store 中只保留这一份描述。 */
export type ToastTone = 'success' | 'error' | 'info' | 'loading'

export interface ToastNotice {
  tone: ToastTone
  message: string
  /** 设计稿中的带关闭按钮变体；加载中的反馈不应提供关闭。 */
  dismissible?: boolean
  /** 自动收起的毫秒数；未设时由组件按状态采用默认值。 */
  duration?: number
}

export function toast(
  tone: ToastTone,
  message: string,
  options: Omit<ToastNotice, 'tone' | 'message'> = {}
): ToastNotice {
  return { tone, message, ...options }
}
