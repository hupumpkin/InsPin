import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createThumbnailQueue, type ResizeResult, type Resizer } from './thumbnails'

const BYTES = Uint8Array.from([1, 2, 3, 4])
const OK: ResizeResult = { bytes: Uint8Array.from([9, 9]), width: 10, height: 10 }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ins-pin-thumb-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const job = (
  key: string,
  run: () => Promise<ResizeResult | null> = async () => OK
): { key: string; outputPath: string; run: () => Promise<ResizeResult | null> } => ({
  key,
  outputPath: join(dir, `${key}.jpg`),
  run
})

/** 可控的假缩放器：记录并发峰值，可指定耗时或失败 */
function fakeResizer(options: { delayMs?: number; failOn?: string } = {}): {
  resize: Resizer
  peak: () => number
  calls: () => number
} {
  const { delayMs = 0, failOn } = options
  let running = 0
  let peak = 0
  let calls = 0

  const resize: Resizer = async (bytes) => {
    calls++
    running++
    peak = Math.max(peak, running)
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (failOn && calls === Number(failOn)) {
        throw new Error('模拟解码失败')
      }
      return OK
    } finally {
      running--
    }
  }

  return { resize, peak: () => peak, calls: () => calls }
}

describe('createThumbnailQueue', () => {
  it('生成缩略图并写盘', async () => {
    const { resize } = fakeResizer()
    const done: string[] = []
    const queue = createThumbnailQueue({
      onDone: (j) => done.push(j.key)
    })

    await expect(queue.schedule(job('a', () => resize(BYTES, 512)))).resolves.toBe(true)

    expect(done).toEqual(['a'])
    expect(existsSync(join(dir, 'a.jpg'))).toBe(true)
    expect(readFileSync(join(dir, 'a.jpg'))).toEqual(Buffer.from([9, 9]))
    expect(queue.size).toBe(0)
  })

  it('同一个目标路径复用同一个任务', async () => {
    const { resize, calls } = fakeResizer()
    const queue = createThumbnailQueue()

    const first = queue.schedule(job('a', () => resize(BYTES, 512)))
    const second = queue.schedule(job('a', () => resize(BYTES, 512)))
    expect(second).toBe(first)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(calls()).toBe(1)
  })

  it('并发不超过上限', async () => {
    const { resize, peak } = fakeResizer({ delayMs: 15 })
    const queue = createThumbnailQueue({ concurrency: 2 })

    for (let i = 0; i < 6; i++) void queue.schedule(job(`k${i}`, () => resize(BYTES, 512)))
    await queue.drain()

    expect(peak()).toBeLessThanOrEqual(2)
    expect(peak()).toBeGreaterThan(1)
  })

  it('拿到并发名额之后才执行（排队时不读原图）', async () => {
    const started: string[] = []
    let release: () => void = () => {}
    const queue = createThumbnailQueue({ concurrency: 1 })

    const first = queue.schedule(
      job('a', async () => {
        started.push('a')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return OK
      })
    )
    const second = queue.schedule(
      job('b', async () => {
        started.push('b')
        return OK
      })
    )

    expect(started).toEqual(['a'])
    release()
    await Promise.all([first, second])
    expect(started).toEqual(['a', 'b'])
  })

  it('预热这类低优先级任务排在按需请求后面', async () => {
    const order: string[] = []
    const queue = createThumbnailQueue({ concurrency: 1 })
    const make = (key: string, priority?: 'high' | 'low') =>
      queue.schedule({
        ...job(key, async () => {
          order.push(key)
          return OK
        }),
        priority
      })
    // 先手动占住唯一的名额
    let release: () => void = () => {}
    const running = queue.schedule({
      ...job('running'),
      run: async () => {
        order.push('running')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return OK
      }
    })
    const low = make('low', 'low')
    const high = make('high')
    release()

    await Promise.all([running, low, high])
    expect(order).toEqual(['running', 'high', 'low'])
  })

  it('单张失败不影响其他张，错误被交出来', async () => {
    const { resize } = fakeResizer({ failOn: '2' })
    const done: string[] = []
    const failed: string[] = []
    const queue = createThumbnailQueue({
      concurrency: 1,
      onDone: (j) => done.push(j.key),
      onError: (j) => failed.push(j.key)
    })

    // 故意不 await：模拟两个请求同时在队列里
    void queue.schedule(job('first', () => resize(BYTES, 512)))
    void queue.schedule(job('bad', () => resize(BYTES, 512)))
    void queue.schedule(job('good', () => resize(BYTES, 512)))
    await queue.drain()

    expect(failed).toEqual(['bad'])
    expect(done).toEqual(['first', 'good'])
    expect(existsSync(join(dir, 'good.jpg'))).toBe(true)
    expect(existsSync(join(dir, 'bad.jpg'))).toBe(false)
  })

  it('解码不了时算失败', async () => {
    const failed: string[] = []
    const queue = createThumbnailQueue({
      onError: (j) => failed.push(j.key)
    })

    await expect(queue.schedule(job('a', async () => null))).resolves.toBe(false)
    expect(failed).toEqual(['a'])
  })

  it('没有任务时 drain 立即返回', async () => {
    const queue = createThumbnailQueue()
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})
