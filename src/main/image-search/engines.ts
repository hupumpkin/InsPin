import type { ImageSearchCatalogItem, ImageSearchEngineId } from '../../shared/image-search'

/**
 * 一个引擎只描述页面操作，不懂业务。
 *
 * 选择器全部来自 2026-10-28 的实测（见开发计划第 13 节）。站点改版时只改这里，
 * 主流程不动。
 */
export interface ImageSearchAdapter {
  id: ImageSearchEngineId
  label: string
  startUrl: string
  /** 需要登录才可用；找不到入口时用它给出更准确的原因 */
  requiresLogin: boolean
  /**
   * 注入前 URL 必须已经落到这个页面。
   *
   * Google 会从 lens.google.com 跳到 google.com/?olud，跳转完成前页面上也有文件框；
   * 过早注入会写进马上被丢弃的旧文档，表现为「注入成功但页面毫无反应」。
   */
  entryUrl?: string
  /** 先点相机/上传按钮；不配就表示文件框已经存在（Google Lens） */
  openUpload?: {
    selectors: string[]
    /** 选择器都失效时，按可见文字兜底 */
    texts?: string[]
  }
  fileInput: {
    selectors: string[]
  }
  /** 结果页判定 */
  result: {
    /** 用 RegExp 源码存，方便单测校验 */
    url?: string
    dom?: string[]
  }
  /** 找不到可注入的文件框时，打开哪个页面让用户自己粘贴 */
  paste: {
    url: string
    focusSelectors: string[]
  }
  /** 站点只收 jpg/png/gif 时，把 webp/avif 先转成 PNG */
  convertNonBitmapToPng?: boolean
  /** 找入口/文件框的时间 */
  findTimeoutMs: number
  /** 等结果页的时间 */
  resultTimeoutMs: number
}

const FIND_TIMEOUT_MS = 12_000
const RESULT_TIMEOUT_MS = 30_000

export const IMAGE_SEARCH_ADAPTERS: ImageSearchAdapter[] = [
  {
    id: 'pinterest',
    label: 'Pinterest',
    startUrl: 'https://www.pinterest.com/',
    requiresLogin: true,
    openUpload: {
      selectors: ['[aria-label="上传图片"]', '[aria-label*="镜头"]', '[data-test-id="visual-search-button"]']
    },
    fileInput: {
      selectors: ['#lens-file-upload', 'input[type=file][accept*="image"]']
    },
    result: {
      url: '^https://(www\\.)?pinterest\\.[a-z.]+/lens-search/'
    },
    paste: {
      url: 'https://www.pinterest.com/',
      focusSelectors: ['[aria-label="搜索"]', 'input[name="searchBoxInput"]']
    },
    findTimeoutMs: FIND_TIMEOUT_MS,
    resultTimeoutMs: RESULT_TIMEOUT_MS
  },
  {
    id: 'huaban',
    label: '花瓣',
    startUrl: 'https://huaban.com/',
    requiresLogin: true,
    openUpload: {
      selectors: ['button[aria-label="以图搜索"]', '[aria-label="以图搜索"]'],
      texts: ['以图搜索']
    },
    fileInput: {
      selectors: ['input[type=file][accept*="image"]', 'input[type=file]']
    },
    result: {
      url: '^https://huaban\\.com/similar\\?'
    },
    paste: {
      url: 'https://huaban.com/',
      focusSelectors: ['#hb_search_input']
    },
    findTimeoutMs: FIND_TIMEOUT_MS,
    resultTimeoutMs: RESULT_TIMEOUT_MS
  },
  {
    id: 'google',
    label: 'Google Lens',
    startUrl: 'https://lens.google.com/',
    requiresLogin: false,
    entryUrl: '^https://(www\\.)?google\\.[a-z.]+/(\\?|search|$)',
    fileInput: {
      selectors: ['input[name=encoded_image]', 'input[type=file][accept*="image"]']
    },
    result: {
      url: '^https://(www\\.)?google\\.[a-z.]+/(search|search/).*vsrid='
    },
    paste: {
      url: 'https://lens.google.com/',
      focusSelectors: ['textarea[name=q]', 'input[name=q]']
    },
    findTimeoutMs: FIND_TIMEOUT_MS,
    resultTimeoutMs: RESULT_TIMEOUT_MS
  },
  {
    id: 'zcool',
    label: '站酷',
    startUrl: 'https://www.zcool.com.cn/',
    requiresLogin: false,
    openUpload: {
      selectors: ['button.zcool-top-nav__search-camera', '[aria-label="图片搜索"]'],
      texts: ['图片搜索']
    },
    fileInput: {
      selectors: [
        'input.zcool-top-nav-search__hidden-file-input',
        'input[type=file][accept*=".PNG"]',
        'input[type=file]'
      ]
    },
    result: {
      url: '^https://(www\\.)?zcool\\.com\\.cn/search/image'
    },
    paste: {
      url: 'https://www.zcool.com.cn/',
      focusSelectors: []
    },
    // 站酷的上传框只声明了 JPG / JPEG / PNG / GIF
    convertNonBitmapToPng: true,
    findTimeoutMs: FIND_TIMEOUT_MS,
    resultTimeoutMs: RESULT_TIMEOUT_MS
  }
]

export function adapterFor(id: ImageSearchEngineId): ImageSearchAdapter | null {
  return IMAGE_SEARCH_ADAPTERS.find((adapter) => adapter.id === id) ?? null
}

export function catalogFor(adapters: ImageSearchAdapter[] = IMAGE_SEARCH_ADAPTERS): ImageSearchCatalogItem[] {
  return adapters.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    availability: 'ready',
    supportsPaste: true,
    hint: adapter.requiresLogin ? '需要先在侧栏登录' : '不需要登录'
  }))
}

/** 适配器配置的合法性检查（单测直接跑这个） */
export function validateAdapters(adapters: ImageSearchAdapter[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const adapter of adapters) {
    if (ids.has(adapter.id)) errors.push(`重复的引擎 id：${adapter.id}`)
    ids.add(adapter.id)
    if (!/^https:\/\//.test(adapter.startUrl)) errors.push(`${adapter.id} 的 startUrl 不是 https`)
    if (adapter.fileInput.selectors.length === 0) errors.push(`${adapter.id} 没有文件框选择器`)
    if (adapter.findTimeoutMs <= 0) errors.push(`${adapter.id} 的 findTimeoutMs 必须为正数`)
    if (adapter.resultTimeoutMs <= 0) errors.push(`${adapter.id} 的 resultTimeoutMs 必须为正数`)
    for (const pattern of [adapter.result.url, adapter.entryUrl]) {
      if (!pattern) continue
      try {
        new RegExp(pattern)
      } catch {
        errors.push(`${adapter.id} 的正则不合法：${pattern}`)
      }
    }
  }
  return errors
}
