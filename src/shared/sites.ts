import { largestFromSrcset } from './srcset'

/**
 * 站点适配（路线图 D3.11 / D3.12 / D3.13）。
 *
 * 网页为了省流量，喂给浏览器的常常是缩略图：地址里带着 `_fw480webp` 这类降级标记。
 * 这里做两件事：
 *   1. **规格还原** —— 把地址改回高清版（去掉降级标记、把尺寸段换成 originals）
 *   2. **页面原图属性** —— 从 HTML 里找 `data-origin-src` 之类的"真图地址"和灯箱大图
 *
 * 「低清副本」标签的判定也在这里：**升级之后地址上仍带降级标记**才算，
 * 拿不准时一律不标——宁可漏标，也不能给用户一张高清图却贴个"低清"的标签。
 *
 * 规则的可信度不一样，见各适配器上的注释。
 */

export interface SiteAdapter {
  id: string
  name: string
  /** 命中的域名（含子域） */
  hosts: readonly string[]
  /** 把降级地址还原成高清地址；认不出来返回 null */
  restoreHighRes?: (url: URL) => string | null
  /** 这个地址是否明显是降级资源 */
  isThumbnail?: (url: URL) => boolean
}

/* ---------- 花瓣 ---------- */

/**
 * 花瓣 CDN 标"这是缩略图"有**两种**写法，两种都实测过：
 *   1. 文件名后缀：`_fw480webp`、`_fw658`、`_sq75`
 *   2. 路径里的尺寸段：`/small/`
 */
const HUABAN_SPEC = /_(?:sq|fw|hw)\d+(?:webp)?$/i
const HUABAN_SIZE_SEGMENT = /(^|\/)(?:small|thumb|thumbnail)\//i

/** 去掉降级标记；没有可去的返回 null。 */
function huabanFullSize(pathname: string): string | null {
  const next = pathname.replace(HUABAN_SPEC, '').replace(HUABAN_SIZE_SEGMENT, '$1')
  return next === pathname ? null : next
}

/**
 * 花瓣。
 *
 * **实测验证过两次**：
 *   - 早期实验：去掉 `_fw480webp` 后缀能取回 image/webp 的原图；
 *   - 2026-10-15 用户手测时日志里冒出一张 480×480 没被识别成低清——查出来是
 *     `gd-hbimg-edge.huaban.com/small/<sha>` 这种**路径段**写法。当场实测：
 *     `/small/` 那份 480×480 / 89KB，**去掉 `small/` 段得到 800×800 / 335KB**；
 *     换成 `/originals/`、`/fw/`、`/huge/` 都是 403，所以正解就是**把这一段删掉**。
 *
 * 另一个坑：`text/uri-list` 在图钉页上给的是**页面链接**，真正的图在 `text/html` 里。
 */
const huaban: SiteAdapter = {
  id: 'huaban',
  name: '花瓣',
  hosts: ['huaban.com', 'huabanimg.com'],
  restoreHighRes: (url) => {
    const next = huabanFullSize(url.pathname)
    if (!next) return null
    const restored = new URL(url.toString())
    restored.pathname = next
    return restored.toString()
  },
  isThumbnail: (url) => huabanFullSize(url.pathname) !== null
}

/* ---------- 小红书 ---------- */

/**
 * 小红书 CDN 在地址后拼 `!nd_dft_wlteh_webp_3` 这类参数。
 * **注意：这条规则没有在实验里实测过**（实验只确认了小红书拖拽数据里只有页面链接）。
 * 去掉 `!` 之后能否取回原图需要真机复测，所以只用来做候选，不作为"已升级"的承诺。
 */
const xiaohongshu: SiteAdapter = {
  id: 'xiaohongshu',
  name: '小红书',
  hosts: ['xhscdn.com', 'xiaohongshu.com'],
  restoreHighRes: (url) => {
    const bang = url.pathname.indexOf('!')
    if (bang <= 0) return null
    const next = new URL(url.toString())
    next.pathname = url.pathname.slice(0, bang)
    return next.toString()
  },
  isThumbnail: (url) => url.pathname.includes('!')
}

/* ---------- Pinterest ---------- */

/** `i.pinimg.com/236x/aa/bb/cc/x.jpg` 的尺寸段 */
const PIN_SIZE_SEGMENT = /\/(?:\d+x\d*|\d+x)\//

/** Pinterest 把原图放在 `/originals/`。**未实测**，同上只作候选。 */
const pinterest: SiteAdapter = {
  id: 'pinterest',
  name: 'Pinterest',
  hosts: ['pinimg.com', 'pinterest.com'],
  restoreHighRes: (url) => {
    if (!PIN_SIZE_SEGMENT.test(url.pathname)) return null
    const next = new URL(url.toString())
    next.pathname = url.pathname.replace(PIN_SIZE_SEGMENT, '/originals/')
    return next.toString()
  },
  isThumbnail: (url) => url.pathname.startsWith('/originals/') === false && PIN_SIZE_SEGMENT.test(url.pathname)
}

export const SITE_ADAPTERS: readonly SiteAdapter[] = [huaban, xiaohongshu, pinterest]

function hostMatches(host: string, candidate: string): boolean {
  return host === candidate || host.endsWith(`.${candidate}`)
}

export function findAdapter(raw: string): SiteAdapter | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return SITE_ADAPTERS.find((adapter) => adapter.hosts.some((h) => hostMatches(url.host, h))) ?? null
}

export interface UpgradeResult {
  /** 可能已经替换成高清地址 */
  url: string
  /** 命中的适配器 id，没命中为 null */
  adapterId: string | null
  changed: boolean
}

/**
 * 尝试把地址升级到高清版。
 * 升级结果**只是候选**——到底能不能下载到、是不是真的更清晰，
 * 要等下载完拿到实际字节和尺寸才知道。
 */
export function upgradeImageUrl(raw: string): UpgradeResult {
  const adapter = findAdapter(raw)
  if (!adapter?.restoreHighRes) return { url: raw, adapterId: adapter?.id ?? null, changed: false }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { url: raw, adapterId: adapter.id, changed: false }
  }

  const restored = adapter.restoreHighRes(url)
  if (!restored || restored === raw) return { url: raw, adapterId: adapter.id, changed: false }
  return { url: restored, adapterId: adapter.id, changed: true }
}

/**
 * 是否是「低清副本」。
 * **只在地址上仍留着降级标记时才为真**——拿不准就返回 false，
 * 避免给用户一张好图却贴上"低清"标签。
 */
export function isLowResCopy(raw: string): boolean {
  const adapter = findAdapter(raw)
  if (!adapter?.isThumbnail) return false
  try {
    return adapter.isThumbnail(new URL(raw))
  } catch {
    return false
  }
}

/* ---------- D3.12：从页面里找"真图" ---------- */

/** 站点用来标注"这才是原图"的属性，按可信度排序 */
const ORIGINAL_ATTRS = [
  'data-origin-src',
  'data-original',
  'data-origin',
  'data-hd-src',
  'data-large',
  'data-large-src',
  'data-zoom-image',
  'data-src-large'
]

const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i

function resolve(raw: string, pageUrl: string): string | null {
  try {
    const url = new URL(raw.trim(), pageUrl)
    return /^https?:$/.test(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * 从页面 HTML 里提取原图候选，按可信度从高到低：
 *   1. `data-origin-src` 之类的原图属性
 *   2. 指向图片文件的链接（灯箱：`<a href="big.jpg"><img src="small.jpg"></a>`）
 *   3. `<img>` 的 `srcset` 最大档
 */
export function extractPageOriginalCandidates(html: string, pageUrl: string): string[] {
  const found: string[] = []
  const push = (value: string | null | undefined): void => {
    if (!value) return
    const url = resolve(value, pageUrl)
    if (url && !found.includes(url)) found.push(url)
  }

  const attrPattern = new RegExp(
    `\\b(?:${ORIGINAL_ATTRS.join('|')})\\s*=\\s*["']([^"']+)["']`,
    'gi'
  )
  for (const match of html.matchAll(attrPattern)) push(match[1])

  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi
  for (const match of html.matchAll(anchorPattern)) {
    if (match[1] && IMAGE_EXTENSION.test(match[1])) push(match[1])
  }

  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    push(largestFromSrcset(tag.match(/srcset\s*=\s*["']([^"']+)["']/i)?.[1]))
  }

  return found
}
