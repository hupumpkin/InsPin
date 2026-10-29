/**
 * 浏览器标签的纯逻辑（路线图 D3.1–D3.4）。
 *
 * 标签列表本身是**纯数据**：谁在前、当前是哪个、标题是什么。真正的网页由主进程的
 * 一个 WebContentsView 负责（界面只画 chrome）。放在 shared 是为了两侧共用一份契约，
 * 也为了这些增删改能单测。
 */

/** 起始页在标签里用一个占位地址表示——真正的端口每次启动都换，不能存死。 */
export const START_PAGE_URL = 'ins-pin://start'

/** 起始页最多收藏 12 个站点：宽屏两排、窄屏四排（每排 6 / 3 个）。 */
export const MAX_START_SOURCES = 12

export interface BrowserTab {
  id: string
  /** 要打开的地址；起始页用 START_PAGE_URL */
  url: string
  title: string
  /** 当前地址栏该显示什么（用户输入过、还没提交时由界面自己管） */
  loading?: boolean
  /** 网页在自身声明的 favicon；主进程取到后转为 data URL，渲染层不直接访问第三方站点。 */
  favicon?: string | null
  /** 正在加载的进度 0–1；未知时为 null */
  progress?: number | null
  /** 上一次导航失败的原因（给错误页用）；成功后清空 */
  error?: string | null
  /** 能不能前进/后退（由主进程填，界面用来灰显按钮） */
  canGoBack?: boolean
  canGoForward?: boolean
  /** 这个标签是以图搜图打开的：引擎 id，界面据此露出「收下结果」 */
  searchEngine?: string
}

export interface BrowserState {
  tabs: BrowserTab[]
  activeId: string | null
}

/** 浏览器收藏到起始页时带过去的信息；favicon 是主进程已经转好的 data URL。 */
export interface BrowserFavorite {
  url: string
  title: string
  favicon?: string | null
}

export function emptyBrowserState(): BrowserState {
  return { tabs: [], activeId: null }
}

export function findTab(state: BrowserState, id: string | null): BrowserTab | null {
  if (!id) return null
  return state.tabs.find((tab) => tab.id === id) ?? null
}

export function activeTab(state: BrowserState): BrowserTab | null {
  return findTab(state, state.activeId)
}

/** 新标签插在当前标签右边（Figma/浏览器都是这个位置），并切过去。 */
export function addTab(state: BrowserState, tab: BrowserTab): BrowserState {
  const at = state.tabs.findIndex((existing) => existing.id === state.activeId)
  const index = at === -1 ? state.tabs.length : at + 1
  const tabs = [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)]
  return { tabs, activeId: tab.id }
}

/**
 * 关掉一个标签。关掉当前标签时，选它右边那个；没有右边就选左边。
 * 关掉最后一个标签后没有当前标签（界面负责再开一个）。
 */
export function closeTab(state: BrowserState, id: string): BrowserState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return state

  const tabs = state.tabs.filter((tab) => tab.id !== id)
  let activeId = state.activeId
  if (state.activeId === id) {
    const neighbour = tabs[index] ?? tabs[index - 1]
    activeId = neighbour?.id ?? null
  }
  return { tabs, activeId }
}

export function activateTab(state: BrowserState, id: string): BrowserState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state
}

/** 拖动排序：把某个标签挪到第 to 位。 */
export function moveTab(state: BrowserState, id: string, to: number): BrowserState {
  const from = state.tabs.findIndex((tab) => tab.id === id)
  if (from === -1) return state
  const tabs = [...state.tabs]
  const [tab] = tabs.splice(from, 1)
  if (!tab) return state
  const at = Math.max(0, Math.min(to, tabs.length))
  tabs.splice(at, 0, tab)
  return { ...state, tabs }
}

export function updateTab(state: BrowserState, id: string, patch: Partial<BrowserTab>): BrowserState {
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab
    changed = true
    return { ...tab, ...patch }
  })
  return changed ? { ...state, tabs } : state
}

/* ---------- 持久化（D3.4 会话恢复） ---------- */

export interface StoredTab {
  url: string
  title: string
}

/** 只存"要恢复的东西"：地址、标题、顺序、当前是哪个。id 每次启动重新生成。 */
export function serializeTabs(state: BrowserState): { tabs: StoredTab[]; activeIndex: number } {
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeId)
  return {
    tabs: state.tabs.map((tab) => ({ url: tab.url, title: tab.title })),
    activeIndex: activeIndex === -1 ? 0 : activeIndex
  }
}

/**
 * 读回存过的标签。**坏数据一律丢掉**（磁盘被手动改过、旧版本格式），
 * 宁可回到一个干净的空状态，也不要让应用打不开。
 */
export function deserializeTabs(
  raw: unknown,
  newId: () => string
): BrowserState {
  if (typeof raw !== 'object' || raw === null) return emptyBrowserState()
  const data = raw as { tabs?: unknown; activeIndex?: unknown }
  if (!Array.isArray(data.tabs)) return emptyBrowserState()

  const tabs: BrowserTab[] = []
  for (const item of data.tabs) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { url?: unknown; title?: unknown }
    if (typeof entry.url !== 'string' || entry.url.length === 0) continue
    tabs.push({
      id: newId(),
      url: entry.url,
      title: typeof entry.title === 'string' ? entry.title : '',
      progress: null,
      error: null
    })
  }
  if (tabs.length === 0) return emptyBrowserState()

  const index = typeof data.activeIndex === 'number' ? data.activeIndex : 0
  const activeId = tabs[Math.max(0, Math.min(index, tabs.length - 1))]?.id ?? null
  return { tabs, activeId }
}

/** 地址栏里输入的东西 → 真正要加载的地址。 */
export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (text.length === 0) return ''
  if (text === START_PAGE_URL) return text
  // 看着像域名就直接补 https，否则当搜索词（本版先不接搜索引擎，按地址处理）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  if (/^[^\s/]+\.[^\s/]+/.test(text)) return `https://${text}`
  return `https://${text}`
}

/** 地址栏里显示这个标签时，用什么文本。 */
export function displayUrl(tab: BrowserTab | null): string {
  if (!tab) return ''
  return tab.url === START_PAGE_URL ? '' : tab.url
}

/**
 * 起始页的"真实"地址是 `http://127.0.0.1:<随机端口>/`，端口每次启动都变。
 * 早期版本会把真实地址存进标签，重启后必然打不开——所以见到这种本地地址，
 * 一律**当作起始页**处理（读旧数据时能自动愈合）。
 */
export function isLocalStartPageUrl(url: string): boolean {
  return /^https?:\/\/127\.0\.0\.1:\d+\/?$/.test(url)
}

/** 存/用标签地址前统一成"规范形式"：起始页一律用占位符。 */
export function canonicalTabUrl(url: string): string {
  return url === START_PAGE_URL || isLocalStartPageUrl(url) ? START_PAGE_URL : url
}
