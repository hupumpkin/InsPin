import { largestFromSrcset } from './srcset'

/**
 * 拖放数据解析（路线图 D3.9）。
 *
 * **顺序是这个模块的全部重点**，来自实验阶段的实测教训：
 * 花瓣的 `text/uri-list` 是**图钉页链接**（`huaban.com/pins/xxxx`），
 * 真正的图片地址只在 `text/html` 的 `<img src>` 里。当初先取 uri-list，
 * 结果下载回来一个 HTML 网页被当成素材存下，画布上只留一个永远加载不出的占位框。
 *
 * 所以顺序是：`text/html` 里的图（先 srcset 最大档、再 src）→ uri-list → text/plain。
 * 返回的只是一串**候选地址**，是不是真图片由下载之后的校验说了算。
 *
 * 纯函数，可直接单测。
 */

export interface DropPayload {
  textHtml?: string | null
  textUriList?: string | null
  textPlain?: string | null
}

/** 从 `text/html` 里抠出来的地址是 HTML 转义的（`&amp;`），要还原。 */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
}

/** 只接受能直接下载的 http(s) 地址；其余（data:、blob:、相对路径）一律丢弃。 */
export function isDownloadableUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function extractCandidateUrls(payload: DropPayload): string[] {
  const candidates: string[] = []
  const push = (value: string | null | undefined): void => {
    const url = decodeHtmlEntities((value ?? '').trim())
    if (!isDownloadableUrl(url)) return
    if (!candidates.includes(url)) candidates.push(url)
  }

  for (const tag of (payload.textHtml ?? '').match(/<img\b[^>]*>/gi) ?? []) {
    push(largestFromSrcset(tag.match(/srcset\s*=\s*["']([^"']+)["']/i)?.[1]))
    push(tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1])
  }

  for (const line of (payload.textUriList ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    // uri-list 里以 # 开头的是注释
    if (trimmed && !trimmed.startsWith('#')) push(trimmed)
  }

  push(payload.textPlain)

  return candidates
}
