import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { nativeImage } from 'electron'
import type { AssetCrop } from '../../shared/node'
import { ImageSearchError } from './inject'

const run = promisify(execFile)

/** nativeImage 能可靠解码的格式；其余（WebP / AVIF / GIF）交给系统 sips。 */
const NATIVE_CROP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

interface Size {
  width: number
  height: number
}

/**
 * 按归一化裁切框生成临时 PNG。
 *
 * `naturalSize` 来自素材库（导入时量过），有它就不用再起一次 `sips -g`；
 * PNG / JPG 直接在内存里裁，连子进程都省了。
 */
export async function cropToPng(
  sourcePath: string,
  crop: AssetCrop,
  naturalSize?: Size | null
): Promise<{ path: string; tempDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'inspin-image-search-crop-'))
  const target = join(dir, 'search.png')

  try {
    if (NATIVE_CROP_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
      const image = nativeImage.createFromPath(sourcePath)
      if (!image.isEmpty()) {
        const size = image.getSize()
        const box = pixelBox(crop, size)
        const cropped = image.crop(box)
        if (!cropped.isEmpty()) {
          await writeFile(target, cropped.toPNG())
          return { path: target, tempDir: dir }
        }
      }
    }

    const size = naturalSize ?? (await pixelSize(sourcePath))
    const box = pixelBox(crop, size)
    await run(
      '/usr/bin/sips',
      [
        '-c',
        String(box.height),
        String(box.width),
        '--cropOffset',
        String(box.y),
        String(box.x),
        '-s',
        'format',
        'png',
        sourcePath,
        '--out',
        target
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 }
    )
    return { path: target, tempDir: dir }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    if (error instanceof ImageSearchError) throw error
    throw new ImageSearchError('crop-failed', '这一块截不出来，换一张试试')
  }
}

function pixelBox(crop: AssetCrop, size: Size): { x: number; y: number; width: number; height: number } {
  const left = Math.min(Math.round(crop.x * size.width), size.width - 1)
  const top = Math.min(Math.round(crop.y * size.height), size.height - 1)
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(Math.round(crop.w * size.width), size.width - left)),
    height: Math.max(1, Math.min(Math.round(crop.h * size.height), size.height - top))
  }
}

async function pixelSize(path: string): Promise<Size> {
  let stdout: string
  try {
    const result = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
    stdout = result.stdout
  } catch {
    throw new ImageSearchError('crop-failed', '读不到这张图的尺寸')
  }
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ImageSearchError('crop-failed', '读不到这张图的尺寸')
  }
  return { width, height }
}
