import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createThumbnailService } from './thumbnails-service'

let root: string
let assetsDir: string
let thumbnailsDir: string
let sourcePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inspin-thumbs-'))
  assetsDir = join(root, 'assets')
  thumbnailsDir = join(root, 'thumbnails')
  const sourceDir = join(root, '外部')
  mkdirSync(assetsDir)
  mkdirSync(thumbnailsDir)
  mkdirSync(sourceDir)
  sourcePath = join(sourceDir, '照片.jpg')
  writeFileSync(sourcePath, Buffer.alloc(16, 1))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('外部文件夹缩略图', () => {
  it('按文件夹 id + 相对路径生成，第二次直接复用缓存', async () => {
    const resize = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })

    const first = await service.ensureLinked('folder-1', '照片.jpg', sourcePath)
    expect(first).toBeTruthy()
    expect(resize).toHaveBeenCalledTimes(1)

    const second = await service.ensureLinked('folder-1', '照片.jpg', sourcePath)
    expect(second).toBe(first)
    expect(resize).toHaveBeenCalledTimes(1)
  })

  it('同一张图并发请求只解码一次', async () => {
    const resize = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.ensureLinked('folder-1', '照片.jpg', sourcePath))
    )
    expect(new Set(results).size).toBe(1)
    expect(resize).toHaveBeenCalledTimes(1)
  })

  it('源文件更新后重新生成', async () => {
    const resize = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })

    await service.ensureLinked('folder-1', '照片.jpg', sourcePath)
    const future = new Date(Date.now() + 10_000)
    utimesSync(sourcePath, future, future)

    await service.ensureLinked('folder-1', '照片.jpg', sourcePath)
    expect(resize).toHaveBeenCalledTimes(2)
  })

  it('解码失败时不留下缓存', async () => {
    const resize = vi.fn(async () => null)
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })

    expect(await service.ensureLinked('folder-1', '照片.jpg', sourcePath)).toBeNull()
  })

  it('HEIC/TIFF 改走系统解码器，不把字节喂给 nativeImage', async () => {
    const heicPath = join(root, '外部', '照片.heic')
    writeFileSync(heicPath, Buffer.alloc(16, 1))
    const resize = vi.fn(async () => null)
    const resizePath = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize, resizePath })

    const output = await service.ensureLinked('folder-1', '照片.heic', heicPath)
    expect(output).toBeTruthy()
    expect(resizePath).toHaveBeenCalledTimes(1)
    expect(resize).not.toHaveBeenCalled()
  })
})

describe('系统缩略图兜底', () => {
  it('nativeImage 解不了的托管格式改走系统解码器，并带上原图尺寸', async () => {
    writeFileSync(join(assetsDir, '动图.webp'), Buffer.alloc(16, 1))
    const resize = vi.fn(async () => null)
    const resizePath = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const sourceSize = vi.fn(() => ({ width: 200, height: 100 }))
    const service = createThumbnailService({
      assetsDir,
      thumbnailsDir,
      resize,
      resizePath,
      sourceSize
    })

    const output = await service.ensure('动图.webp')

    expect(output).toBeTruthy()
    expect(resizePath).toHaveBeenCalledWith(join(assetsDir, '动图.webp'), 512, {
      width: 200,
      height: 100
    })
  })

  it('外部文件夹里的 GIF/WebP 也走系统解码器，不退回原图', async () => {
    const webpPath = join(root, '外部', '照片.webp')
    writeFileSync(webpPath, Buffer.alloc(16, 1))
    const resize = vi.fn(async () => null)
    const resizePath = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize, resizePath })

    const output = await service.ensureLinked('folder-1', '照片.webp', webpPath)

    expect(output).toBeTruthy()
    expect(resizePath).toHaveBeenCalledWith(webpPath, 512)
  })

  it('字节解不了、也没有系统解码器时返回 null（由协议退回原图）', async () => {
    writeFileSync(join(assetsDir, '动图.gif'), Buffer.alloc(16, 1))
    const resize = vi.fn(async () => null)
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })

    await expect(service.ensure('动图.gif')).resolves.toBeNull()
  })
})

describe('统一调度', () => {
  it('不同文件的按需请求共用同一个并发上限', async () => {
    let running = 0
    let peak = 0
    const resize = vi.fn(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running--
      return { bytes: new Uint8Array(128), width: 40, height: 30 }
    })
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(assetsDir, `图${i}.jpg`), Buffer.alloc(16, 1))
    }

    const paths = await Promise.all(
      Array.from({ length: 12 }, (_, i) => service.ensure(`图${i}.jpg`))
    )

    expect(paths.every(Boolean)).toBe(true)
    expect(resize).toHaveBeenCalledTimes(12)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('预热和按需请求共用队列，同一文件只解码一次', async () => {
    const resize = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { bytes: new Uint8Array(128), width: 40, height: 30 }
    })
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })
    writeFileSync(join(assetsDir, '照片.jpg'), Buffer.alloc(16, 1))

    service.prewarm('照片.jpg')
    const output = await service.ensure('照片.jpg')

    expect(output).toBeTruthy()
    expect(resize).toHaveBeenCalledTimes(1)
  })

  it('已有缩略图时预热不再解码', async () => {
    const resize = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })
    writeFileSync(join(assetsDir, '照片.jpg'), Buffer.alloc(16, 1))

    await service.ensure('照片.jpg')
    service.prewarm('照片.jpg')
    await service.drain()

    expect(resize).toHaveBeenCalledTimes(1)
  })

  it('原图读不到时按需返回 null', async () => {
    const resize = vi.fn(async () => ({ bytes: new Uint8Array(128), width: 40, height: 30 }))
    const service = createThumbnailService({ assetsDir, thumbnailsDir, resize })

    await expect(service.ensure('不存在.jpg')).resolves.toBeNull()
    expect(resize).not.toHaveBeenCalled()
  })
})
