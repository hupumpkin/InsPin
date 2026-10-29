import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { ASSET_SCHEME, parseAssetUrl } from '../shared/asset-url'
import type { ThumbnailService } from './thumbnails-service'

/**
 * 用自定义协议把素材喂给界面（路线图 D1.4 / D1.7）。
 *
 * 为什么不能直接给 `file://` 地址：画布页面的来源是 http（开发）或 file（打包后），
 * Chromium 默认禁止跨来源加载 `file://` 子资源。所以注册一个受信任的专用协议，
 * 只暴露 assets / thumbnails 目录下的**单个文件名**，绝不透露绝对路径。
 *
 * 两种"桶"：
 *   - 原图 `ins-pin-asset:///abc.png`
 *   - 缩略图 `ins-pin-asset://thumb/abc.png`（首次请求时若没生成，就地生成一份）
 */

export interface AssetProtocolDeps {
  assetsDir: string
  thumbnails: ThumbnailService
  resolveLinkedAsset?: (
    folderId: string,
    relativePath: string
  ) => string | null | Promise<string | null>
}

/** 我们认识的图片扩展名 → Content-Type。给 `<img>` 与 Pixi 解码用。 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  // SVG 通过 <img>/Pixi 加载时脚本不会执行，只作为静态图渲染
  svg: 'image/svg+xml'
}

function mimeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** HEIC/TIFF 只用于生成缩略图，不能把原文件直接喂给 `<img>`（浏览器解不了）。 */
function browserCanDisplay(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return !['heic', 'heif', 'tif', 'tiff'].includes(ext)
}

/**
 * 每个响应都带上 CORS 头。**这不是可选项**：
 *   - PixiJS 用 `fetch` + `createImageBitmap` 取纹理，跨来源没有 ACAO 就直接 Failed to fetch；
 *   - 它退而求其次用 `new Image()` 时也会设 `crossOrigin='anonymous'`，同样要 CORS。
 * 少了这个头，画布会**静默空白**（只在控制台留一条 CORS 报错），非常难查。
 */
function withHeaders(response: Response, fileName?: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  if (fileName) headers.set('Content-Type', mimeFor(fileName))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

/**
 * 必须在 `app.whenReady()` **之前**调用：声明这是标准、安全、支持 CORS 的协议，
 * `<img>` 与 Pixi 纹理才会愿意从它加载资源。
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** 在 `app.whenReady()` 之后调用：把协议请求映射到磁盘上的文件。 */
export function serveAssets(deps: AssetProtocolDeps): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const parsed = parseAssetUrl(request.url)
    if (!parsed) {
      return withHeaders(new Response('invalid asset path', { status: 400 }))
    }

    const linkedPath = async (): Promise<string | null> => {
      if (!parsed.folderId || !parsed.relativePath) return null
      return (await deps.resolveLinkedAsset?.(parsed.folderId, parsed.relativePath)) ?? null
    }

    let filePath: string | null = null
    if (parsed.bucket === 'thumb' && parsed.fileName) {
      // 缩略图做不出来时退回原图：nativeImage 只解 PNG/JPEG，GIF/WebP/AVIF/SVG
      // 拿不到缩略图，但浏览器能正常显示，不能因此给网格一个 404。
      const original = join(deps.assetsDir, parsed.fileName)
      filePath = (await deps.thumbnails.ensure(parsed.fileName)) ?? (existsSync(original) ? original : null)
    } else if (parsed.bucket === 'linked-thumb') {
      const source = await linkedPath()
      const thumbnail = source
        ? await deps.thumbnails.ensureLinked(parsed.folderId!, parsed.relativePath!, source)
        : null
      filePath =
        thumbnail ?? (source && browserCanDisplay(source) ? source : null)
    } else if (parsed.bucket === 'linked') {
      filePath = await linkedPath()
    } else if (parsed.fileName) {
      filePath = join(deps.assetsDir, parsed.fileName)
    }

    if (!filePath || !existsSync(filePath)) {
      return withHeaders(new Response('asset not found', { status: 404 }))
    }
    return withHeaders(await net.fetch(pathToFileURL(filePath).toString()), filePath)
  })
}
