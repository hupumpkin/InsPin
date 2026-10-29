/**
 * 按需渲染的脏帧调度（D6b）。
 *
 * Pixi 的 `Application` 默认把 `render` 挂在 ticker 上，静止画面也会按屏幕刷新率
 * 一直提交——画布是常驻界面，这样太费电。改成"谁改了画面谁请求一帧"：
 * 同一帧内的多次请求合并成一次，没有请求就完全不画。
 */

export interface FrameScheduler {
  /** 请求在下一帧画一次；已经排上了就什么也不做 */
  invalidate(): void
  /** 丢掉还没执行的请求（销毁时用，避免回调打到一个已经销毁的 renderer） */
  dispose(): void
}

export interface FrameClock {
  request(callback: () => void): number
  cancel(handle: number): void
}

const rafClock: FrameClock = {
  request: (callback) => globalThis.requestAnimationFrame(() => callback()),
  cancel: (handle) => globalThis.cancelAnimationFrame(handle)
}

export function createFrameScheduler(render: () => void, clock: FrameClock = rafClock): FrameScheduler {
  let pending: number | null = null

  return {
    invalidate() {
      if (pending !== null) return
      pending = clock.request(() => {
        pending = null
        render()
      })
    },

    dispose() {
      if (pending === null) return
      clock.cancel(pending)
      pending = null
    }
  }
}
