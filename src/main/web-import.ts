import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportMethod, WebDropRequest } from '../shared/ipc'
import { extractCandidateUrls } from '../shared/drop'
import { isLowResCopy, upgradeImageUrl } from '../shared/sites'
import { DownloadError, downloadImage, type FetchLike } from './download'
import {
  countRootNodes,
  importOneImage,
  messageFor,
  type ImageMeasurer,
  type ImportFailure,
  type ImportOutcome
} from './import-files'
import { LogEvent } from './logger'
import { sniffImageFormat } from './mime'
import type { ProjectLogSink } from './projects-ipc'

/**
 * 从网页把图收进画布（路线图 D3.9 / D3.10 / D3.11，D3.8 的落点由调用方给）。
 *
 * 三条事实决定了这里怎么写：
 *
 * 1. **拖放数据里通常只有地址、没有字节**，所以要"二次下载"（D3.10）。下载走浏览器那套
 *    登录态与 referrer——花瓣这类图床会按 referrer 防盗链。
 * 2. **候选地址有先后之分**（`shared/drop.ts` 的注释写了那个坑：花瓣的 uri-list 给的是
 *    图钉页链接，先取它会存回一个 HTML 网页）。这里**严格按顺序试**，第一个能下成图片的算数。
 * 3. **拿回来的常常是缩略图**，所以每个地址先经 `upgradeImageUrl` 试着还原高清（D3.11），
 *    高清取不回来再退回原地址。
 *
 * 纯流程：下载器、时钟、id 都从外面注入，所以能在普通 Node 下单测。
 */

export interface WebImportDeps {
  db: DatabaseSync
  assetsDir: string
  measure: ImageMeasurer
  /** 用浏览器会话的 `fetch`，这样登录态与 referrer 都在 */
  fetchImpl: FetchLike
  logger: ProjectLogSink
  now?: () => Date
  newId?: () => string
}

/** 一次最多试几个地址；再多也会拖慢用户等待，且多半前几个就成或都成不了。 */
export const MAX_CANDIDATES = 3

/** 这个位置实在没读出可用地址。 */
export const NO_USABLE_ADDRESS = '这里没有可用的图片地址'

export interface Candidate {
  url: string
  /** 这条地址是不是"把缩略图还原成高清"换来的（D3.11 的验收就看它） */
  upgraded: boolean
}

/**
 * 候选地址排序：**每个地址先试高清版、再退回原地址**。
 *
 * 顺序不能反——先原地址的话，一定拿到缩略图，D3.11 就没意义了。
 * "是不是高清"这个事实**必须在这里记下来**：等下载完再回头看地址已经晚了，
 * 那时手里的就是高清地址本身，再判断一次只会得到"没升级"。
 */
export function expandCandidates(raw: string[]): Candidate[] {
  const out: Candidate[] = []
  const push = (url: string, upgraded: boolean): void => {
    if (!out.some((item) => item.url === url)) out.push({ url, upgraded })
  }
  for (const url of raw) {
    const restored = upgradeImageUrl(url)
    if (restored.changed) push(restored.url, true)
    push(url, false)
  }
  return out
}

/** 用地址最后一段做文件名；抠不出来就用兜底名（扩展名以实际字节为准）。 */
export function fileNameFor(url: string, ext: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    const base = decodeURIComponent(last)
      .replace(/\.[a-z0-9]+$/i, '')
      .trim()
    if (base.length > 0) return `${base.slice(0, 60)}.${ext}`
  } catch {
    // 地址不合法，走兜底名
  }
  return `网页图片.${ext}`
}

/**
 * 收不进来时给用户的两句话（路线图 D3.14：**发生了什么 → 为什么 → 可以怎么做**）。
 *
 * **不把 `ERR_*` 或底层报错甩出去**——用户看不懂，也不该看到。
 * `message` 说清为什么；`hint` 说下一步能做什么。顶部提示条只放 `message`，
 * 画布上那块失败小卡片两句都显示。
 */
export interface ImportFailureText {
  message: string
  hint: string
}

const NETWORK_HINT = '检查一下网络；有些站点就是不给外部取图，可以试试直接拖进来'
const RETRY_HINT = '稍等一下再拖一次'

export function describeImportFailure(error: unknown): ImportFailureText {
  if (error instanceof DownloadError) {
    switch (error.reason) {
      case 'not-image':
        return { message: '这个地址给的不是图片（拿到的是网页）', hint: '这张图可能拖不出来，换一张试试' }
      case 'http':
        if (error.status === 403 || error.status === 401) {
          return { message: '这个站点不让外部取图', hint: '试试在网页上直接拖这张图，或换个来源' }
        }
        if (error.status === 404) {
          return { message: '这张图已经不在了（服务器说找不到）', hint: '回网页刷新一下，或换一张' }
        }
        return { message: `对方服务器返回 ${error.status ?? '错误'}`, hint: RETRY_HINT }
      case 'too-large':
        return { message: error.message, hint: '挑一张小一点的图' }
      case 'timeout':
        return { message: error.message, hint: RETRY_HINT }
      case 'network':
        return { message: '没能连上这个站点', hint: NETWORK_HINT }
    }
  }
  return { message: messageFor(error), hint: RETRY_HINT }
}

export interface WebImportResult extends ImportOutcome {
  /** 这次是不是靠"还原高清"拿到的（D3.11 的验收证据） */
  upgraded: boolean
  /** 定下来的图片实际地址（没成功就为 null） */
  resourceUrl: string | null
}

/** 智能采集复用下载链路，只改变来源标记与最终落点。 */
export interface WebImportOptions {
  importMethod?: ImportMethod
  center?: { x: number; y: number } | null
  at?: { x: number; y: number } | null
}

/** 下载好、但还没落库的一张网页图。批量收图的并发下载只做到这一步。 */
export interface ResolvedWebImage {
  bytes: Uint8Array
  /** 最终取到的图片地址（可能是还原后的高清地址） */
  url: string
  /** 开始尝试的那条候选地址，日志里用 */
  requested: string
  ext: string
  upgraded: boolean
  lowRes: boolean
  pageUrl: string | null
  candidates: number
}

export interface WebResolveResult {
  image: ResolvedWebImage | null
  errors: ImportFailure[]
}

/** 只做「解析地址 + 下载」，不碰数据库和文件，方便批量并发。 */
export async function resolveWebImage(
  deps: WebImportDeps,
  projectId: string,
  request: WebDropRequest
): Promise<WebResolveResult> {
  const pageUrl = request.pageUrl && request.pageUrl.length > 0 ? request.pageUrl : null
  const candidates = expandCandidates(extractCandidateUrls(request.payload)).slice(0, MAX_CANDIDATES)

  if (candidates.length === 0) {
    return { image: null, errors: [{ path: '', name: '', message: NO_USABLE_ADDRESS }] }
  }

  let lastText: ImportFailureText = { message: NO_USABLE_ADDRESS, hint: '换一张图，或换个站点试试' }

  for (const candidate of candidates) {
    try {
      const downloaded = await downloadImage({
        url: candidate.url,
        referer: pageUrl,
        fetchImpl: deps.fetchImpl
      })
      const format = sniffImageFormat(downloaded.bytes)
      // 高清升级没成、地址上还留着降级标记 → 老老实实标「低清副本」（D3.13）。
      // 拿不准一律不标：宁可漏标，也不能给用户一张好图却贴个"低清"。
      const lowRes = !candidate.upgraded && isLowResCopy(downloaded.url)
      return {
        image: {
          bytes: downloaded.bytes,
          url: downloaded.url,
          requested: candidate.url,
          ext: format?.ext ?? 'png',
          upgraded: candidate.upgraded,
          lowRes,
          pageUrl,
          candidates: candidates.length
        },
        errors: []
      }
    } catch (error) {
      lastText = describeImportFailure(error)
      deps.logger.error(LogEvent.webFetchFailed, {
        projectId,
        url: candidate.url,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // 全都没成：只把最后一条原因给用户，别堆一串技术细节
  return {
    image: null,
    errors: [{ path: '', name: '', message: lastText.message, hint: lastText.hint }]
  }
}

/** 把已经下载好的图片落库、摆到画布上。 */
export async function importResolvedImage(
  deps: WebImportDeps,
  projectId: string,
  image: ResolvedWebImage,
  options: WebImportOptions = {}
): Promise<WebImportResult> {
  const imported = await importOneImage(deps, projectId, {
    name: fileNameFor(image.url, image.ext),
    bytes: image.bytes,
    importMethod: options.importMethod ?? 'drag',
    index: countRootNodes(deps.db, projectId),
    at: options.at ?? null,
    center: options.center ?? null,
    sourceUrl: image.pageUrl,
    resourceUrl: image.url,
    pageUrl: image.pageUrl,
    ...(image.lowRes ? { badge: 'low-res' as const } : {})
  })

  deps.logger.info(LogEvent.webImportResolved, {
    projectId,
    requested: image.requested,
    resolved: image.url,
    upgraded: image.upgraded,
    lowRes: image.lowRes,
    bytes: image.bytes.length,
    width: imported.asset.width,
    height: imported.asset.height,
    candidates: image.candidates
  })

  return { imported: [imported], errors: [], upgraded: image.upgraded, resourceUrl: image.url }
}

export async function importFromWeb(
  deps: WebImportDeps,
  projectId: string,
  request: WebDropRequest,
  options: WebImportOptions = {}
): Promise<WebImportResult> {
  const resolved = await resolveWebImage(deps, projectId, request)
  if (!resolved.image) {
    return { imported: [], errors: resolved.errors, upgraded: false, resourceUrl: null }
  }
  return importResolvedImage(deps, projectId, resolved.image, {
    importMethod: options.importMethod,
    center: options.center,
    at: options.at ?? request.position ?? null
  })
}
