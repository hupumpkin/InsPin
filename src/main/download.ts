import { sniffImageFormat } from './mime'

/**
 * 二次下载（路线图 D3.10）。
 *
 * 什么时候需要它：从网页拖过来的数据里往往**只有地址、没有图片字节**，
 * 得再用浏览器那套登录态去把图取回来。取回来之前必须校验三件事——
 * 是不是图片、有多大、有没有超时——否则会把一个 HTML 网页当成素材存下来，
 * 画布上就多出一个永远加载不出的占位框（实验阶段真实发生过）。
 *
 * **referrer 必须走 fetch 的 `referrer` 选项**：手动设 `Referer` 请求头会被
 * Chromium 拦成 `ERR_BLOCKED_BY_CLIENT`，请求根本发不出去（实验阶段的第二个坑）。
 */

export type DownloadFailure = 'http' | 'not-image' | 'too-large' | 'timeout' | 'network'

export class DownloadError extends Error {
  readonly reason: DownloadFailure
  readonly status: number | null

  constructor(reason: DownloadFailure, message: string, status: number | null = null) {
    super(message)
    this.name = 'DownloadError'
    this.reason = reason
    this.status = status
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface DownloadOptions {
  url: string
  /** 来源页面地址，很多图床靠它防盗链 */
  referer?: string | null
  fetchImpl?: FetchLike
  timeoutMs?: number
  maxBytes?: number
}

export interface DownloadResult {
  bytes: Uint8Array
  mime: string
  url: string
}

export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/** 一眼就知道不是图片的类型，提前拦掉，省得白下载一个网页。 */
function isClearlyNotImage(contentType: string): boolean {
  if (!contentType) return false
  if (contentType.startsWith('image/')) return false
  return (
    contentType.startsWith('text/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/') ||
    contentType === 'application/json' ||
    contentType === 'application/xhtml+xml' ||
    contentType === 'application/pdf'
  )
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

function readContentType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export async function downloadImage(options: DownloadOptions): Promise<DownloadResult> {
  const {
    url,
    referer = null,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES
  } = options

  const init: RequestInit = {
    redirect: 'follow',
    credentials: 'include',
    signal: AbortSignal.timeout(timeoutMs)
  }
  if (referer) {
    init.referrer = referer
    init.referrerPolicy = 'unsafe-url'
  }

  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    if (isTimeout(error)) {
      throw new DownloadError('timeout', `下载超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)
    }
    throw new DownloadError('network', `网络请求失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    throw new DownloadError('http', `服务器返回 ${response.status}`, response.status)
  }

  const contentType = readContentType(response)
  if (isClearlyNotImage(contentType)) {
    throw new DownloadError(
      'not-image',
      `这个地址返回的是网页而不是图片（${contentType}）`,
      response.status
    )
  }

  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DownloadError(
      'too-large',
      `图片太大（${readableSize(declared)}），上限是 ${readableSize(maxBytes)}`
    )
  }

  const bytes = new Uint8Array(await response.arrayBuffer())

  if (bytes.length === 0) {
    throw new DownloadError('not-image', '这个地址没有返回内容')
  }
  if (bytes.length > maxBytes) {
    throw new DownloadError(
      'too-large',
      `图片太大（${readableSize(bytes.length)}），上限是 ${readableSize(maxBytes)}`
    )
  }

  // 最终以文件头为准：Content-Type 可能是 octet-stream，也可能干脆写错
  const format = sniffImageFormat(bytes)
  if (!format) {
    throw new DownloadError(
      'not-image',
      `这个地址返回的不是图片${contentType ? `（${contentType}）` : ''}`,
      response.status
    )
  }

  return { bytes, mime: format.mime, url }
}
