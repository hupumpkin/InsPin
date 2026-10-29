import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 缩略图生成队列（路线图 D1.7 / D6b）。
 *
 * 为什么要有队列而不是"导入时顺手生成"：
 * 一张大图解码+缩放要几百毫秒，几十张一起导入会把主进程卡住。这里限制并发、
 * 失败不影响其他任务，导入交互因此不会被拖慢。
 *
 * **排队时只拿任务描述，不拿原图字节**：真正的读文件和解码在拿到名额之后才发生，
 * 否则大文件夹一打开，几十张原图会先被读进内存、静静等在队列里。
 *
 * 真正的缩放（Electron 的 `nativeImage`）在任务的 `run` 里注入进来，
 * 所以队列逻辑本身可以在普通 Node 环境下单测。
 */

export interface ResizeResult {
  bytes: Uint8Array
  width: number
  height: number
}

/** 缩放到最长边不超过 maxEdge；无法解码时返回 null。 */
export type Resizer = (bytes: Uint8Array, maxEdge: number) => Promise<ResizeResult | null>

export interface ThumbnailJob {
  /** 用来去重和记日志的键（素材文件名 / 文件夹+相对路径） */
  key: string
  /** 缩略图写到哪；同一个目标路径只做一次 */
  outputPath: string
  /** 拿到并发名额之后才执行：在这里读原图、解码、缩放 */
  run: () => Promise<ResizeResult | null>
  /** 预热这类"没那么急"的任务排到按需请求后面 */
  priority?: 'high' | 'low'
}

export interface ThumbnailQueueOptions {
  concurrency?: number
  onDone?: (job: ThumbnailJob, result: ResizeResult) => void
  onError?: (job: ThumbnailJob, error: unknown) => void
}

export interface ThumbnailQueue {
  /**
   * 排队生成。同一个 `outputPath` 只做一次：重复请求拿到同一个 Promise。
   * 解析为 true = 缩略图已就绪；false = 读取/解码/写盘失败。
   */
  schedule(job: ThumbnailJob): Promise<boolean>
  /** 当前等待 + 正在跑的任务数 */
  readonly size: number
  /** 等全部跑完（测试用） */
  drain(): Promise<void>
}

interface QueuedJob {
  job: ThumbnailJob
  resolve: (ready: boolean) => void
}

export function createThumbnailQueue(options: ThumbnailQueueOptions = {}): ThumbnailQueue {
  const { concurrency = 2, onDone, onError } = options

  /** 按需请求先跑，预热垫后：一次导入几十张时，打开素材库不用排在它们后面 */
  const waiting: { high: QueuedJob[]; low: QueuedJob[] } = { high: [], low: [] }
  /** outputPath → 本次任务；重复请求直接复用，避免同一张图解码两遍 */
  const pending = new Map<string, Promise<boolean>>()
  let running = 0
  let idleResolvers: (() => void)[] = []

  const notifyIdle = (): void => {
    if (running === 0 && waiting.high.length === 0 && waiting.low.length === 0) {
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  const runOne = async (queued: QueuedJob): Promise<void> => {
    const { job, resolve } = queued
    let ready = false
    try {
      const result = await job.run()
      if (!result) throw new Error('无法解码这张图片')
      await mkdir(dirname(job.outputPath), { recursive: true })
      // 先写临时文件再改名：中途被杀也不会留下半张图被当成"已有缓存"用下去
      const tempPath = `${job.outputPath}.tmp`
      await writeFile(tempPath, result.bytes)
      await rename(tempPath, job.outputPath)
      onDone?.(job, result)
      ready = true
    } catch (error) {
      await unlink(`${job.outputPath}.tmp`).catch(() => undefined)
      // 单张缩略图失败不能影响其他任务，也不该让导入失败（原图还在）
      onError?.(job, error)
    } finally {
      pending.delete(job.outputPath)
      running--
      resolve(ready)
      pump()
    }
  }

  const pump = (): void => {
    while (running < concurrency) {
      const queued = waiting.high.shift() ?? waiting.low.shift()
      if (!queued) break
      running++
      void runOne(queued)
    }
    notifyIdle()
  }

  return {
    schedule(job: ThumbnailJob): Promise<boolean> {
      const already = pending.get(job.outputPath)
      if (already) return already

      const task = new Promise<boolean>((resolve) => {
        const queued = { job, resolve }
        if (job.priority === 'low') waiting.low.push(queued)
        else waiting.high.push(queued)
      })
      pending.set(job.outputPath, task)
      pump()
      return task
    },

    get size(): number {
      return waiting.high.length + waiting.low.length + running
    },

    drain(): Promise<void> {
      if (running === 0 && waiting.high.length === 0 && waiting.low.length === 0) {
        return Promise.resolve()
      }
      return new Promise((resolve) => idleResolvers.push(resolve))
    }
  }
}
