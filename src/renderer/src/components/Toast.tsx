import { useEffect } from 'react'
import type { ToastNotice } from '../toast'

interface ToastProps {
  notice: ToastNotice
  onDismiss: () => void
}

/** 画布工具条上方唯一的操作反馈出口。 */
export default function Toast({ notice, onDismiss }: ToastProps): React.JSX.Element {
  const defaultDuration =
    notice.tone === 'loading' ? null : notice.tone === 'error' ? null : notice.tone === 'success' ? 2600 : 3200
  const duration = notice.duration ?? defaultDuration

  useEffect(() => {
    if (duration === null) return
    const timer = window.setTimeout(onDismiss, duration)
    return () => window.clearTimeout(timer)
  }, [duration, onDismiss, notice])

  return (
    <div
      className="toast"
      data-tone={notice.tone}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
    >
      <span className="toast__icon" aria-hidden="true" />
      <span className="toast__message">{notice.message}</span>
      {notice.dismissible && (
        <button type="button" className="toast__dismiss" aria-label="关闭提示" onClick={onDismiss}>
          <span aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
