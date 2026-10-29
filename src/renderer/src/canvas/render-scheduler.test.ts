import { describe, expect, it, vi } from 'vitest'
import { createFrameScheduler, type FrameClock } from './render-scheduler'

/** 手动推进的帧时钟：测试不必等真的 requestAnimationFrame。 */
function fakeClock(): FrameClock & { flush(): void; cancel: ReturnType<typeof vi.fn> } {
  const callbacks = new Map<number, () => void>()
  let next = 1
  const cancel = vi.fn((handle: number) => {
    callbacks.delete(handle)
  })
  return {
    request(callback) {
      const handle = next++
      callbacks.set(handle, callback)
      return handle
    },
    cancel,
    flush() {
      const queued = [...callbacks.values()]
      callbacks.clear()
      for (const callback of queued) callback()
    }
  }
}

describe('createFrameScheduler', () => {
  it('同一帧内的多次请求只画一次', () => {
    const clock = fakeClock()
    const render = vi.fn()
    const scheduler = createFrameScheduler(render, clock)

    scheduler.invalidate()
    scheduler.invalidate()
    scheduler.invalidate()
    expect(render).not.toHaveBeenCalled()

    clock.flush()
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('画完一帧之后可以再请求', () => {
    const clock = fakeClock()
    const render = vi.fn()
    const scheduler = createFrameScheduler(render, clock)

    scheduler.invalidate()
    clock.flush()
    scheduler.invalidate()
    clock.flush()
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('dispose 会取消还没执行的帧', () => {
    const clock = fakeClock()
    const render = vi.fn()
    const scheduler = createFrameScheduler(render, clock)

    scheduler.invalidate()
    scheduler.dispose()
    clock.flush()
    expect(clock.cancel).toHaveBeenCalledTimes(1)
    expect(render).not.toHaveBeenCalled()
  })

  it('没有待画帧时 dispose 不碰时钟', () => {
    const clock = fakeClock()
    const scheduler = createFrameScheduler(vi.fn(), clock)
    scheduler.dispose()
    expect(clock.cancel).not.toHaveBeenCalled()
  })
})
