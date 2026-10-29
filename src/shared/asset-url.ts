/**
 * 素材地址的拼法。主进程用它注册协议，预加载用它生成 `<img>` / Pixi 纹理要用的地址，
 * 两边共用一份，改一处就够。
 *
 * 地址里只有文件名（内容哈希）与一个"桶"名，**没有本机绝对路径**。
 */
export const ASSET_SCHEME = 'ins-pin-asset'

/** 缩略图桶：主机名位置放 `thumb`，用来和原图区分（见下面 parseAssetUrl 的说明）。 */
export const THUMB_HOST = 'thumb'
export const LINKED_HOST = 'linked'
export const LINKED_THUMB_HOST = 'linked-thumb'

export type AssetBucket = 'original' | 'thumb' | 'linked' | 'linked-thumb'

/** 原图地址，例如 `ins-pin-asset:///ab12cd….png`。 */
export function assetUrlFor(fileName: string): string {
  return `${ASSET_SCHEME}:///${encodeURIComponent(fileName)}`
}

/**
 * 缩略图地址。**路径里放的是原图文件名**，主进程据此推出缩略图文件名再去生成/读取
 * （缩略图名 = 去掉扩展名 + `.thumb.png`）。
 */
export function thumbUrlFor(fileName: string): string {
  return `${ASSET_SCHEME}://${THUMB_HOST}/${encodeURIComponent(fileName)}`
}

/** 外部只读文件夹里的图片地址；只暴露链接 id 与相对路径，不暴露本机绝对路径。 */
export function linkedAssetUrlFor(folderId: string, relativePath: string): string {
  return `${ASSET_SCHEME}://${LINKED_HOST}/${encodeURIComponent(folderId)}/${encodeURIComponent(relativePath)}`
}

/** 外部文件夹图片的缩略图地址。网格里绝不能直接加载原图：几百张 4000px 照片会拖死界面。 */
export function linkedThumbUrlFor(folderId: string, relativePath: string): string {
  return `${ASSET_SCHEME}://${LINKED_THUMB_HOST}/${encodeURIComponent(folderId)}/${encodeURIComponent(relativePath)}`
}

/**
 * 缩略图最长边的上限（像素）。
 *
 * 主进程按它生成缩略图，画布按它决定"屏幕上这张图还需不需要原图"——
 * 两边必须同一个数，改一处就够。
 */
export const THUMBNAIL_MAX_EDGE = 512

/** 缩略图文件名：`abc.png` → `abc.thumb.png`。 */
export function thumbnailNameFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  return `${base}.thumb.png`
}

export interface AssetRequest {
  bucket: AssetBucket
  fileName?: string
  folderId?: string
  relativePath?: string
}

/** 只允许"一个文件名"：出现路径分隔符、空字节、或指向上级目录一律拒绝。 */
function safeFileName(name: string): string | null {
  if (name.length === 0) return null
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  if (name === '.' || name === '..') return null
  return name
}

/**
 * 解析素材请求地址。
 *
 * **坑**：标准协议下 Chromium 会把第一个路径段当成**主机名**——我们写出去的
 * `ins-pin-asset:///a.png` 到处理器手里已变成 `ins-pin-asset://a.png/`；
 * `ins-pin-asset://thumb/a.png` 则变成 host=`thumb`、path=`/a.png`。
 * 所以要先看主机名是不是桶名，再看剩下的部分当文件名。
 */
export function parseAssetUrl(rawUrl: string): AssetRequest | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const decode = (text: string): string | null => {
    try {
      return decodeURIComponent(text)
    } catch {
      return null
    }
  }

  const host = decode(url.host)
  const path = decode(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
  if (host === null || path === null) return null

  if (host === THUMB_HOST) {
    const fileName = safeFileName(path)
    return fileName ? { bucket: 'thumb', fileName } : null
  }

  if (host === LINKED_HOST || host === LINKED_THUMB_HOST) {
    const slash = path.indexOf('/')
    if (slash <= 0) return null
    const folderId = safeFileName(path.slice(0, slash))
    const relativePath = path.slice(slash + 1)
    if (!folderId || !relativePath || relativePath.includes('\0')) return null
    return { bucket: host === LINKED_HOST ? 'linked' : 'linked-thumb', folderId, relativePath }
  }

  // 没写桶名时，第一段路径会落到 host 上；两种情况都要认
  const fileName = safeFileName(host.length > 0 ? (path.length > 0 ? `${host}/${path}` : host) : path)
  return fileName ? { bucket: 'original', fileName } : null
}
