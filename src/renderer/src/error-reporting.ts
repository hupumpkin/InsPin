/**
 * 界面进程的兜底：任何没被代码接住的异常都转交给主进程写日志，
 * 这样"界面白屏"这类问题也能查到原因，而不是只能看到一片空白。
 */
export function installErrorReporting(): void {
  window.addEventListener('error', (event) => {
    const error = event.error instanceof Error ? event.error : undefined
    window.insPin?.reportError({
      message: error?.message ?? String(event.message),
      stack: error?.stack,
      source: `${event.filename}:${event.lineno}:${event.colno}`
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason
    window.insPin?.reportError({
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      source: 'unhandledrejection'
    })
  })
}
