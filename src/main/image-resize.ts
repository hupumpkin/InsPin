import { nativeImage } from 'electron'
import type { ResizeResult } from './thumbnails'

/**
 * 用 Electron 的解码器缩放图片（与 `thumbnails.ts` 的队列配合）。
 *
 * 单独放一个文件，是因为这里依赖 Electron，而队列逻辑本身要保持能在普通 Node 下单测。
 *
 * 注意：`nativeImage` 的解码/缩放是**同步**的，大图会短暂占住主进程。缩略图最长边只有
 * 512，代价可接受；真要更顺滑是 D6b 性能阶段的事。
 */
export function resizeWithNativeImage(bytes: Uint8Array, maxEdge: number): ResizeResult | null {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) return null

  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) return null

  const scale = Math.min(1, maxEdge / Math.max(width, height))
  if (scale >= 1) {
    const png = image.toPNG()
    return { bytes: new Uint8Array(png), width, height }
  }

  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))
  const resized = image.resize({ width: targetW, height: targetH, quality: 'good' })
  return { bytes: new Uint8Array(resized.toPNG()), width: targetW, height: targetH }
}

/** 把系统缩略图按原图比例压回去；拿不到原图尺寸时保持系统给的样子。 */
function fitAspect(
  image: Electron.NativeImage,
  natural: { width: number; height: number },
  maxEdge: number
): Electron.NativeImage {
  const longest = Math.max(natural.width, natural.height)
  if (!(longest > 0)) return image
  const scale = Math.min(1, maxEdge / longest)
  const width = Math.max(1, Math.round(natural.width * scale))
  const height = Math.max(1, Math.round(natural.height * scale))
  return image.resize({ width, height, quality: 'good' })
}

/**
 * 按文件路径取缩略图。用于 `createFromBuffer` 解不了的格式：
 * `createThumbnailFromPath` 走系统解码器（macOS 上能读 HEIC/TIFF/GIF/WebP/AVIF/SVG）。
 *
 * **系统返回的是 `maxEdge` 见方的拉伸图**，宽图会被压扁。知道原图尺寸时按比例
 * 压回去——画布/快照本来就会按对象盒子还原，但素材库网格是直接铺图，不修就会变形。
 */
export async function resizePathWithNativeImage(
  sourcePath: string,
  maxEdge: number,
  naturalSize?: { width: number; height: number }
): Promise<ResizeResult | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(sourcePath, {
      width: maxEdge,
      height: maxEdge
    })
    if (!image || image.isEmpty()) return null
    const fitted = naturalSize ? fitAspect(image, naturalSize, maxEdge) : image
    const { width, height } = fitted.getSize()
    if (width <= 0 || height <= 0) return null
    return { bytes: new Uint8Array(fitted.toPNG()), width, height }
  } catch {
    return null
  }
}
