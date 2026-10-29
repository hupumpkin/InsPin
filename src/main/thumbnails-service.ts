import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { THUMBNAIL_MAX_EDGE, thumbnailNameFor } from '../shared/asset-url'
import { needsTranscode } from './image-transcode'
import { createThumbnailQueue, type ResizeResult, type Resizer } from './thumbnails'

/**
 * 缩略图的生成与取用（路线图 D1.7 / D6b 的落地部分）。
 *
 * 为什么不是"导入时顺手生成"就完事：老素材（缩略图这套之前导入的）没有缩略图，
 * 而且缩略图目录可能被用户清掉。所以做成"两条腿"：
 *   - **预热**：导入后后台排队生成，赶在用户看之前备好；
 *   - **按需兜底**：真正请求时若还没有，就地生成一份再返回。
 *
 * 三条路径（预热 / 托管素材按需 / 外部文件夹按需）**共用同一个队列**：统一的
 * 并发上限、按目标文件去重、排队时只拿路径不拿原图字节。预热是低优先级，
 * 打开素材库时不会被导入后的大批预热任务堵住。
 *
 * 真正的缩放（Electron 的 `nativeImage`）注入进来，所以这里能在普通 Node 下单测。
 */

export interface ThumbnailService {
  /** 缩略图会落在哪（可能还没生成） */
  pathFor(originalFileName: string): string
  /** 确保有一份缩略图，返回其路径；做不出来返回 null */
  ensure(originalFileName: string): Promise<string | null>
  /**
   * 外部只读文件夹里的图片：在 `thumbnails/linked/<文件夹 id>/` 下生成/复用缩略图。
   * 源文件改动（mtime 变新）会自动重做；移除文件夹链接时可以整目录清掉。
   */
  ensureLinked(folderId: string, relativePath: string, sourcePath: string): Promise<string | null>
  /** 导入后预热：后台生成，不阻塞本次导入 */
  prewarm(originalFileName: string): void
  /** 等后台队列跑完（测试用） */
  drain(): Promise<void>
}

export interface ThumbnailServiceOptions {
  assetsDir: string
  thumbnailsDir: string
  resize: Resizer
  /** 按路径解的文件（走系统解码器）；字节解不了时也用它兜底 */
  resizePath?: (
    sourcePath: string,
    maxEdge: number,
    naturalSize?: { width: number; height: number }
  ) => Promise<ResizeResult | null>
  /** 托管素材的原图像素尺寸：系统缩略图是方的，需要它把比例还原 */
  sourceSize?: (fileName: string) => { width: number; height: number } | undefined
  maxEdge?: number
}

const DEFAULT_MAX_EDGE = THUMBNAIL_MAX_EDGE
/** 解码是主进程里的同步工作，同时跑太多会卡住界面 */
const CONCURRENCY = 2

/** 某个外部文件夹的缩略图缓存目录；移除链接时整目录清掉。 */
export function linkedThumbnailDir(thumbnailsDir: string, folderId: string): string {
  const safe = /^[A-Za-z0-9._-]+$/.test(folderId) && folderId !== '.' && folderId !== '..'
  const key = safe ? folderId : createHash('sha1').update(folderId).digest('hex').slice(0, 24)
  return join(thumbnailsDir, 'linked', key)
}

export function createThumbnailService(options: ThumbnailServiceOptions): ThumbnailService {
  const {
    assetsDir,
    thumbnailsDir,
    resize,
    resizePath,
    sourceSize,
    maxEdge = DEFAULT_MAX_EDGE
  } = options

  const pathFor = (fileName: string): string => join(thumbnailsDir, thumbnailNameFor(fileName))

  const queue = createThumbnailQueue({ concurrency: CONCURRENCY })

  /** 明显不像一张缩略图（空文件/写了一半）时当成没有，重新生成。 */
  const isUsable = async (outputPath: string): Promise<boolean> => {
    try {
      const info = await stat(outputPath)
      return info.size >= 64
    } catch {
      return false
    }
  }

  /**
   * 托管素材：原图在 assetsDir 下，按文件名定位。
   *
   * 字节解码（nativeImage）只认 PNG/JPEG；GIF/WebP/AVIF/HEIC 会返回空图，
   * 这时交给系统缩略图解码器生成真预览，而不是让协议退回原图——否则素材库
   * 和画布会直接加载一张几千万像素的原图。
   */
  const resizeManaged = async (fileName: string): Promise<ResizeResult | null> => {
    const path = join(assetsDir, fileName)
    const bytes = new Uint8Array(await readFile(path))
    const direct = await resize(bytes, maxEdge).catch(() => null)
    if (direct) return direct
    if (!resizePath) return null
    return resizePath(path, maxEdge, sourceSize?.(fileName))
  }

  // 外部文件夹的缩略图：路径在素材目录之外，不能走文件名那套缓存。
  // 按“文件夹 id + 相对路径”缓存，源文件 mtime 变新就重做。
  const linkedOutputFor = (folderId: string, relativePath: string): string => {
    const key = createHash('sha1').update(relativePath).digest('hex').slice(0, 24)
    return join(linkedThumbnailDir(thumbnailsDir, folderId), `${key}.thumb.png`)
  }

  return {
    pathFor,

    ensure(fileName) {
      const outputPath = pathFor(fileName)
      return (async () => {
        // 已有可用的缩略图就不必排队（也顺手修掉空文件/写了一半的坏缓存）
        if (await isUsable(outputPath)) return outputPath
        const ready = await queue.schedule({
          key: fileName,
          outputPath,
          run: () => resizeManaged(fileName)
        })
        return ready ? outputPath : null
      })()
    },

    ensureLinked(folderId, relativePath, sourcePath) {
      const outputPath = linkedOutputFor(folderId, relativePath)
      return (async () => {
        const source = await stat(sourcePath).catch(() => null)
        if (!source?.isFile()) return null
        const cached = await stat(outputPath).catch(() => null)
        if (cached && cached.size >= 64 && cached.mtimeMs >= source.mtimeMs) return outputPath

        const ready = await queue.schedule({
          key: `${folderId}\0${relativePath}`,
          outputPath,
          run: async () => {
            // HEIC/TIFF 的字节喂给 nativeImage 只会得到空图，直接走系统解码器
            if (needsTranscode(sourcePath) && resizePath) return resizePath(sourcePath, maxEdge)
            const direct = await resize(new Uint8Array(await readFile(sourcePath)), maxEdge).catch(
              () => null
            )
            if (direct) return direct
            // GIF/WebP/AVIF 同理：系统解码器能出真预览，别退回原图
            return resizePath ? resizePath(sourcePath, maxEdge) : null
          }
        })
        return ready ? outputPath : null
      })()
    },

    prewarm(fileName) {
      const outputPath = pathFor(fileName)
      if (existsSync(outputPath)) return
      // 只把任务排进去：原图字节等拿到名额之后再读
      void queue.schedule({
        key: fileName,
        outputPath,
        priority: 'low',
        run: () => resizeManaged(fileName)
      })
    },

    drain: () => queue.drain()
  }
}
