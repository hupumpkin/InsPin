import {
  app,
  BrowserWindow,
  WebContentsView,
  net,
  type BaseWindow,
  type Rectangle
} from 'electron'
import {
  activateTab,
  addTab,
  canonicalTabUrl,
  closeTab,
  deserializeTabs,
  emptyBrowserState,
  findTab,
  moveTab,
  normalizeUrl,
  serializeTabs,
  START_PAGE_URL,
  updateTab,
  type BrowserState,
  type BrowserTab
} from '../shared/browser'
import { errorPageDataUrl } from '../shared/browser-error'
import { IpcChannel, type BrowserCommand, type BrowserMouseShortcut } from '../shared/ipc'
import { attachCrashRecovery, type CrashSource } from './crash-recovery'

/**
 * 浏览器标签的主进程一侧（路线图 D3.1–D3.4）。
 *
 * **每个标签一个 `WebContentsView`**，只有当前标签可见——这样每个标签各自保留
 * 历史、滚动位置与页面状态（直接换 URL 是做不到的）。界面那边只画 chrome（标签条、
 * 地址栏），网页本身由这里渲染。
 *
 * 状态是纯数据（`shared/browser.ts`），这里只负责把状态变化落到"视图"上，
 * 并在变化时通知界面 + 落盘。
 */

export interface BrowserLogger {
  info(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface BrowserTabsDeps {
  window: () => BaseWindow | null
  partition: string
  /** 第三方网页专用的极小预加载层，仅接收智能采集点击。 */
  browserPreloadPath: string
  /** 起始页的地址（每次启动端口都不同，所以存的是 START_PAGE_URL 占位） */
  startPageUrl: () => string | null
  /** 标签内容区（chrome 以下的部分）该占的位置 */
  contentBounds: () => Rectangle
  restore: () => Promise<unknown>
  persist: (state: BrowserState) => void
  newId: () => string
  logger: BrowserLogger
  /**
   * 网页本身有焦点时，键盘事件不会到界面层。这里把主进程认得的快捷键
   * （新建标签、非冻结采集下的 Esc）接住；返回 true 表示已处理，页面不再收到这次按键。
   */
  handleShortcut?: (input: Electron.Input, webContents: Electron.WebContents) => boolean
  /**
   * 网页里也要生效的鼠标中键动作（智能采集 / 新建标签）。
   * 网页是原生视图，界面收不到这些事件，只能由预加载层转给主进程。
   */
  mouseShortcuts?: () => BrowserMouseShortcut[]
}

/** 真正要加载的地址：起始页占位换成当前启动的真实地址。 */
function resolveUrl(url: string, startPageUrl: string | null): string {
  if (canonicalTabUrl(url) === START_PAGE_URL) return startPageUrl ?? 'about:blank'
  return url
}

/** 只允许网页侧开到 http(s) / about:blank，其他协议不让弹窗。 */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === 'about:blank'
}

/**
 * 隐藏标签闲置多久后释放渲染进程（再次切回来会重新加载这个页面）。
 *
 * 设得比较长，是因为这会丢掉页面里的滚动位置和未提交的表单；30 分钟没看过的
 * 标签多半已经不是用户此刻的工作现场了。
 */
const TAB_SLEEP_AFTER_MS = 30 * 60 * 1000
const TAB_SLEEP_CHECK_MS = 60 * 1000

/**
 * 所有进程工作集合计超过它时，开始按内存从大到小释放隐藏标签。
 *
 * 只看时间的话，一下午开十几个重网页仍可能堆到几个 GB；内存真的高了也要能回收。
 * 这个预算包含画布和主进程，所以触发时不一定全是标签的锅——只是从最占内存的
 * 隐藏标签先收。
 */
const TAB_MEMORY_BUDGET_BYTES = 4 * 1024 * 1024 * 1024
/** 内存压力下也至少闲置这么久，别把刚切走的标签收掉 */
const TAB_MEMORY_MIN_IDLE_MS = 5 * 60 * 1000

/**
 * 登录弹窗通常会用 `window.open(url, name, 'width=…,height=…')` 指定尺寸。
 * 读出来并夹在可用范围内；没写就按桌面登录页给一个合适的默认值。
 */
function popupSize(features: string): { width: number; height: number } {
  const read = (name: string, fallback: number): number => {
    const raw = new RegExp(`${name}=(\\d+)`, 'i').exec(features)?.[1]
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? Math.min(1600, Math.max(320, value)) : fallback
  }
  return { width: read('width', 1024), height: read('height', 800) }
}

export class BrowserTabs {
  private state: BrowserState = emptyBrowserState()
  private readonly views = new Map<string, WebContentsView>()
  /** 刚被我们换成错误页的标签：下一次 did-navigate 不该改地址栏 */
  private readonly errorPages = new Set<string>()
  /** 面板收起时把所有网页视图藏起来。**几何（宽度/停靠）由 index.ts 算，这里只管显不显** */
  private panelVisible = true
  /** 登录/授权弹窗。持有引用，避免窗口被 GC；关闭时移除。 */
  private readonly popups = new Set<BrowserWindow>()
  /** 每个标签最后一次成为当前标签的时间；休眠判断用 */
  private readonly lastActiveAt = new Map<string, number>()
  private sleepTimer: ReturnType<typeof setInterval> | null = null
  private onChange: (state: BrowserState) => void = () => {}

  constructor(private readonly deps: BrowserTabsDeps) {}

  /** 恢复上次的标签；没有就开一个起始页标签。 */
  async init(): Promise<void> {
    const stored = await this.deps.restore()
    const restored = deserializeTabs(stored, this.deps.newId)
    if (restored.tabs.length > 0) {
      // 顺手把旧数据里的"死端口起始页地址"换成占位符（见 canonicalTabUrl）
      this.state = {
        ...restored,
        tabs: restored.tabs.map((tab) => ({ ...tab, url: canonicalTabUrl(tab.url) }))
      }
      // 只给当前标签建视图：其余等第一次点开再加载，避免启动时同时拉起一堆网页进程
      const active = findTab(this.state, this.state.activeId)
      if (active) {
        this.createView(active)
        this.lastActiveAt.set(active.id, Date.now())
      }
    } else {
      this.state = addTab(emptyBrowserState(), this.makeTab(START_PAGE_URL))
      const tab = findTab(this.state, this.state.activeId)
      if (tab) {
        this.createView(tab)
        this.lastActiveAt.set(tab.id, Date.now())
      }
    }
    this.startSleepTimer()
    this.applyVisibility()
    this.notify()
  }

  private startSleepTimer(): void {
    if (this.sleepTimer !== null) return
    const timer = setInterval(() => this.hibernateIdleTabs(), TAB_SLEEP_CHECK_MS)
    // 纯后台清理，不该因为它把应用留在退出流程里
    timer.unref?.()
    this.sleepTimer = timer
  }

  /**
   * 隐藏太久、又没在出声的标签，把渲染进程整个释放掉（下次点开按保存的地址重建）。
   *
   * 不做的话，一下午开十几个标签，每个都常驻一个渲染进程。跳过正在出声的标签
   * （可能在看视频/开会），也跳过有登录弹窗的时候（避免把 OAuth 的 opener 收掉）。
   */
  private hibernateIdleTabs(): void {
    if (this.popups.size > 0) return
    const now = Date.now()
    for (const [id, view] of [...this.views]) {
      if (id === this.state.activeId) continue
      const last = this.lastActiveAt.get(id) ?? now
      if (now - last < TAB_SLEEP_AFTER_MS) continue
      const wc = view.webContents
      if (!wc || wc.isDestroyed() || wc.isCurrentlyAudible()) continue
      this.hibernate(id, 'idle')
    }
    this.hibernateUnderMemoryPressure(now)
  }

  /**
   * 总内存超过预算时，按占用从大到小释放隐藏标签。
   *
   * 只按时间回收的话，一下午开十几个重网页仍会堆到几个 GB；这里补上"内存真的
   * 高了"的触发条件。至少闲置 5 分钟，正在出声的标签一律跳过。
   */
  private hibernateUnderMemoryPressure(now: number): void {
    const metrics = app.getAppMetrics()
    const total = metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0) * 1024, 0)
    if (total <= TAB_MEMORY_BUDGET_BYTES) return

    const bytesByPid = new Map<number, number>()
    for (const metric of metrics) {
      bytesByPid.set(metric.pid, (metric.memory?.workingSetSize ?? 0) * 1024)
    }

    const candidates = [...this.views.entries()]
      .filter(([id, view]) => {
        if (id === this.state.activeId) return false
        const last = this.lastActiveAt.get(id) ?? now
        if (now - last < TAB_MEMORY_MIN_IDLE_MS) return false
        const wc = view.webContents
        return Boolean(wc && !wc.isDestroyed() && !wc.isCurrentlyAudible())
      })
      .map(([id, view]) => ({
        id,
        bytes: bytesByPid.get(view.webContents.getOSProcessId()) ?? 0
      }))
      .sort((a, b) => b.bytes - a.bytes)

    let current = total
    for (const candidate of candidates) {
      if (current <= TAB_MEMORY_BUDGET_BYTES) break
      this.hibernate(candidate.id, 'memory')
      current -= candidate.bytes
    }
  }

  private hibernate(id: string, reason: 'idle' | 'memory'): void {
    const view = this.views.get(id)
    if (!view) return
    // 先从表里拿掉：webContents 被关掉时会触发 destroyed → removeStaleTab，
    // 那会把标签记录也一起删了——休眠不是"用户关掉了这个标签"。
    this.views.delete(id)
    try {
      this.deps.window()?.contentView.removeChildView(view)
    } catch {
      // 窗口已经没了
    }
    try {
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // 进程刚好已经在关闭途中
    }
    this.deps.logger.info('browser.tab.sleep', { id, reason })
  }

  /** 视图只能在窗口就绪后挂上去。 */
  attach(): void {
    const window = this.deps.window()
    if (!window) return
    for (const view of this.views.values()) window.contentView.addChildView(view)
    this.setBounds(this.deps.contentBounds())
    this.applyVisibility()
  }

  /** 让 index.ts 把"状态变了"接到"推给界面"上。 */
  subscribe(listener: (state: BrowserState) => void): void {
    this.onChange = listener
  }

  getState(): BrowserState {
    return this.state
  }

  private makeTab(url: string): BrowserTab {
    return { id: this.deps.newId(), url, title: '', progress: null, error: null }
  }

  private createView(tab: BrowserTab): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        // 所有标签共用同一个会话分区：登录态是全局共享的（既定决策）
        partition: this.deps.partition,
        preload: this.deps.browserPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    view.setBackgroundColor('#ffffff')
    this.views.set(tab.id, view)
    this.wire(tab.id, view)
    const target = resolveUrl(tab.url, this.deps.startPageUrl())
    void view.webContents.loadURL(target)
    return view
  }

  /**
   * 拿到某个标签的视图；启动时没建、或休眠后第一次切回来，都在这里补建。
   *
   * 懒建视图的前提是"状态在，页面可以按地址重建"——标签的 URL/标题本来就
   * 存在 `this.state` 里，所以重建不丢标签本身。
   */
  private ensureView(id: string): WebContentsView | null {
    const existing = this.views.get(id)
    if (existing && existing.webContents && !existing.webContents.isDestroyed()) return existing
    if (existing) this.views.delete(id)
    const tab = findTab(this.state, id)
    if (!tab) return null
    const view = this.createView(tab)
    this.deps.window()?.contentView.addChildView(view)
    view.setBounds(this.deps.contentBounds())
    // 补建出来的可能是"后台标签"（例如给它导航）：先按当前可见性摆好，别闪一下
    view.setVisible(this.panelVisible && id === this.state.activeId)
    return view
  }

  private wire(id: string, view: WebContentsView): void {
    const wc = view.webContents
    const { logger } = this.deps

    // 标签页的渲染进程崩了（访问某些网页时真的会）就自动拉一次；
    // 连崩超上限会停手，不把应用拖进"崩溃-重载"的死循环（D6a.5）
    attachCrashRecovery(wc as unknown as CrashSource, {
      label: '浏览器标签',
      logger,
      reload: () => {
        if (wc.isDestroyed()) return
        wc.reload()
      }
    })

    // 网页有焦点时按键到不了界面层；把改过键的"新建标签"在这里接住
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && this.deps.handleShortcut?.(input, wc)) {
        event.preventDefault()
      }
    })

    // 页面每次加载完都重新下发一次中键绑定：预加载层是随页面重跑的，
    // 不重发的话刷新之后快捷键就静默失效了。
    wc.on('did-finish-load', () => {
      if (wc.isDestroyed()) return
      wc.send(IpcChannel.browserMouseShortcutConfig, this.deps.mouseShortcuts?.() ?? [])
    })

    wc.on('did-navigate', (_event, url) => {
      // 失败时我们主动把错误页塞进去，这次跳转不算用户导航，地址栏要保有原来的地址
      if (this.errorPages.has(id)) {
        this.errorPages.delete(id)
        return
      }
      this.patch(id, { url: this.storedUrlFor(url), error: null, favicon: null })
    })
    wc.on('did-navigate-in-page', (_event, url) =>
      this.patch(id, { url: this.storedUrlFor(url) })
    )
    wc.on('page-title-updated', (_event, title) => this.patch(id, { title }))
    wc.on('page-favicon-updated', (_event, faviconUrls) => this.captureFavicon(id, faviconUrls))
    wc.on('did-start-loading', () => this.patch(id, { loading: true, progress: 0 }))
    wc.on('did-stop-loading', () => this.patch(id, { loading: false, progress: null }))
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 是"主动取消"（点了停止、或又跳去别处），不是失败
      if (!isMainFrame || code === -3) return
      logger.error('browser.load.failed', { code, description, url })
      this.patch(id, { loading: false, progress: null, error: String(code) })
      // 用我们自己的错误页替换 Chromium 那套带 ERR_ 的默认页
      this.errorPages.add(id)
      void wc.loadURL(errorPageDataUrl(code, url))
    })
    this.installWindowOpenHandler(wc)
    wc.on('did-create-window', (popup) => this.adoptPopup(popup))
    // 页面自己调用 window.close()（登录 / 授权页常见）时，网页进程会先没掉。
    // 如果还留着标签记录，关闭按钮会对着 undefined 的 webContents 抛错，标签就"卡死"了。
    // 带上 wc：休眠后重建又立刻切回时，旧进程的 destroyed 不能误删新视图。
    wc.on('destroyed', () => this.removeStaleTab(id, wc))
  }

  /** 网页进程已经消失：连同标签记录一起收掉，别让它继续占着标签栏。 */
  private removeStaleTab(id: string, wc: Electron.WebContents): void {
    const current = this.views.get(id)
    if (!current || current.webContents !== wc) return
    this.views.delete(id)
    this.state = closeTab(this.state, id)
    this.applyVisibility()
    this.notify()
  }

  /**
   * 网页里的新窗口分两种，不能一律塞回当前标签：
   *
   *   - **登录 / 授权弹窗**（`window.open(...)` 带窗口特征）必须是真的子窗口。
   *     OAuth 流程靠 `window.opener` 回传结果；塞回当前标签会丢掉 opener，
   *     花瓣这类站点就会一直停在授权页不动。
   *   - **普通 `target="_blank"` 链接**开成应用内新标签，别顶掉用户正在看的页面。
   */
  private installWindowOpenHandler(wc: Electron.WebContents): void {
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (!isWebUrl(url)) {
        this.deps.logger.info('browser.window-open.blocked', { url })
        return { action: 'deny' }
      }

      // JS 的 window.open() 会给 new-window；<a target="_blank"> 则是 *-tab。
      if (disposition === 'new-window' || disposition === 'other') {
        this.deps.logger.info('browser.window-open.popup', { url })
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            ...popupSize(features),
            show: true,
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: {
              partition: this.deps.partition,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          }
        }
      }

      this.deps.logger.info('browser.window-open.tab', { url })
      this.newTab(url)
      return { action: 'deny' }
    })
  }

  /** 把新开的弹窗挂到主窗口下，并给弹窗里的链接套用同一套打开规则。 */
  private adoptPopup(popup: BrowserWindow): void {
    this.popups.add(popup)
    const parent = this.deps.window()
    // 主窗口是 BaseWindow（自绘 chrome）；Electron 运行时接受它，只是类型写得偏窄
    if (parent) popup.setParentWindow(parent as unknown as BrowserWindow)
    this.installWindowOpenHandler(popup.webContents)
    popup.webContents.on('did-create-window', (child) => this.adoptPopup(child))
    popup.on('closed', () => this.popups.delete(popup))
  }

  /**
   * 原生网页已经解析到了站点自己的图标，但 React chrome 无权直接读第三方网址。
   * 在主进程取回一个受大小限制的 data URL 再推给 UI，失败时留空让 UI 画 Earth 兜底。
   */
  private captureFavicon(id: string, urls: string[]): void {
    const pageUrl = findTab(this.state, id)?.url ?? null
    const url = urls.find((candidate) => /^https?:\/\//i.test(candidate))
    if (!url) {
      this.patch(id, { favicon: null })
      return
    }

    void net
      .fetch(url)
      .then(async (response) => {
        const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (!response.ok || !type?.startsWith('image/')) throw new Error('favicon response is not an image')
        const bytes = Buffer.from(await response.arrayBuffer())
        // favicon 正常只有几 KB；拒绝异常大响应，避免把网页资源误塞进浏览器状态。
        if (bytes.length === 0 || bytes.length > 256 * 1024) throw new Error('favicon size is invalid')
        return `data:${type};base64,${bytes.toString('base64')}`
      })
      .then((favicon) => {
        // 标签可能已关闭、或已跳去另一个网址；过期请求绝不能把旧站图标盖回来。
        if (findTab(this.state, id)?.url !== pageUrl) return
        this.patch(id, { favicon })
      })
      .catch(() => {
        if (findTab(this.state, id)?.url === pageUrl) this.patch(id, { favicon: null })
      })
  }

  /**
   * 存进标签的地址。**起始页要存占位符**：它的真实地址是
   * `http://127.0.0.1:<随机端口>/`，端口每次启动都变，存真的重启后必然打不开。
   */
  private storedUrlFor(url: string): string {
    return url === this.deps.startPageUrl() ? START_PAGE_URL : canonicalTabUrl(url)
  }

  private patch(id: string, fields: Partial<BrowserTab>): void {
    this.state = updateTab(this.state, id, fields)
    this.notify()
  }

  private notify(): void {
    // 顺手把"能不能前进/后退"填进去，界面据此灰显按钮
    this.state = {
      ...this.state,
      tabs: this.state.tabs.map((tab) => ({ ...tab, ...this.canGo(tab.id) }))
    }
    this.deps.persist(this.state)
    this.onChange(this.state)
  }

  /**
   * 只有当前标签是"露着"的；其余一律藏起来（D6b.3）。
   *
   * 藏起来之后 Chromium 会按"后台页面"自行节流，不需要再调 `setBackgroundThrottling`。
   * **不能对活动标签传 `false`**：可见的视图本来就不受后台节流影响，而关掉一个
   * webContents 的节流还可能连带影响同一窗口里的其他 webContents，等于把后台标签
   * 的保护也一起关掉。
   *
   * 隐藏超过 30 分钟的标签由 `hibernateIdleTabs` 释放渲染进程；再次激活会按保存的
   * 地址重建。滚动位置和未提交的表单会丢——这是为长会话内存做的有意取舍。
   */
  private applyVisibility(): void {
    let removed = false
    for (const [id, view] of [...this.views]) {
      // 网页进程可能已经被页面自己关掉；对着 undefined 调方法会让后续所有
      // 标签操作（关标签、切标签、拖分栏线）一起抛错。
      if (!view.webContents || view.webContents.isDestroyed()) {
        this.views.delete(id)
        this.state = closeTab(this.state, id)
        removed = true
        continue
      }
      view.setVisible(this.panelVisible && id === this.state.activeId)
    }
    if (removed) this.notify()
  }

  /** 改键之后把新的中键绑定推给所有已打开的网页。 */
  syncMouseShortcuts(): void {
    const config = this.deps.mouseShortcuts?.() ?? []
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send(IpcChannel.browserMouseShortcutConfig, config)
      }
    }
  }

  /** 这条 webContents 是不是我们开的标签页（网页侧 IPC 只接受这些发送者）。 */
  owns(webContents: Electron.WebContents): boolean {
    for (const view of this.views.values()) {
      if (view.webContents === webContents) return true
    }
    return false
  }

  /**
   * 面板展开/收起时，网页视图整块显/藏（画布就能占满）。
   *
   * 收起滑出动画期间面板仍是"露着"的，所以调用方传的是**有效可见性**
   * （展开中或动画未结束都算可见）。这里只落 flag，不管几何、不发通知。
   */
  setPanelVisible(visible: boolean): void {
    if (this.panelVisible === visible) return
    this.panelVisible = visible
    this.applyVisibility()
  }

  /** 把网页视图挪到给定位置（合上/滑出动画的每一帧都会调）。 */
  setBounds(rect: Rectangle): void {
    for (const view of this.views.values()) view.setBounds(rect)
  }

  /** 面板开着但没有标签时补一个起始页（用户重新打开面板时用）。 */
  ensureTab(): BrowserState {
    return this.state.tabs.length === 0 ? this.newTab() : this.state
  }

  /**
   * 关掉全部标签、只留一张起始页（「清除浏览数据」之后用）。
   *
   * 清完 Cookie 之后，已经打开的页面还留着登录后的界面，看着像没清干净；
   * 干脆退回起始页，用户看到的就是"确实清零了"。
   */
  resetToStartPage(): BrowserState {
    for (const view of this.views.values()) {
      try {
        if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
      } catch {
        // 已经没掉的进程不用再关
      }
    }
    this.views.clear()
    this.lastActiveAt.clear()
    this.state = { tabs: [], activeId: null }
    this.newTab()
    return this.state
  }

  /* ---------- 界面来的操作 ---------- */

  newTab(url?: string): BrowserState {
    const tab = this.makeTab(url && url.length > 0 ? normalizeUrl(url) : START_PAGE_URL)
    this.state = addTab(this.state, tab)
    const view = this.createView(tab)
    this.lastActiveAt.set(tab.id, Date.now())
    this.deps.window()?.contentView.addChildView(view)
    view.setBounds(this.deps.contentBounds())
    this.applyVisibility()
    this.notify()
    return this.state
  }

  closeTab(id: string): BrowserState {
    const view = this.views.get(id)
    // 先把标签从状态里拿掉：即使网页进程已经没了，用户点关闭也必须能关掉。
    this.views.delete(id)
    this.lastActiveAt.delete(id)
    this.state = closeTab(this.state, id)
    try {
      if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // 进程刚好在关闭途中消失，不影响标签已经被移除
    }
    this.applyVisibility()
    this.notify()
    return this.state
  }

  activateTab(id: string): BrowserState {
    this.state = activateTab(this.state, id)
    if (this.state.activeId === id) {
      // 懒恢复 / 休眠后第一次点开：这时才真正创建网页进程
      this.ensureView(id)
      this.lastActiveAt.set(id, Date.now())
    }
    this.applyVisibility()
    this.notify()
    return this.state
  }

  moveTab(id: string, to: number): BrowserState {
    this.state = moveTab(this.state, id, to)
    this.notify()
    return this.state
  }

  navigate(id: string, url: string): BrowserState {
    const normalized = normalizeUrl(url)
    if (normalized.length === 0) return this.state
    const view = this.views.get(id)
    if (!view?.webContents || view.webContents.isDestroyed()) {
      // 休眠/懒恢复过的标签还没有视图：先把地址写进状态，补建时会按它加载
      this.patch(id, { url: normalized, error: null })
      this.ensureView(id)
      return this.state
    }
    this.patch(id, { url: normalized, error: null })
    void view.webContents.loadURL(resolveUrl(normalized, this.deps.startPageUrl()))
    return this.state
  }

  command(id: string, command: BrowserCommand): BrowserState {
    const wc = this.views.get(id)?.webContents
    if (!wc || wc.isDestroyed()) return this.state
    if (command === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (command === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (command === 'reload') wc.reload()
    else if (command === 'stop') wc.stop()
    return this.state
  }

  /** 每个标签能不能前进/后退。 */
  private canGo(id: string): { canGoBack: boolean; canGoForward: boolean } {
    const wc = this.views.get(id)?.webContents
    if (!wc) return { canGoBack: false, canGoForward: false }
    return {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  getStored(): { tabs: { url: string; title: string }[]; activeIndex: number } {
    return serializeTabs(this.state)
  }

  /** 当前标签的视图（自检要用）。 */
  activeView(): WebContentsView | null {
    if (!this.state.activeId) return null
    return this.views.get(this.state.activeId) ?? null
  }

  activeWebContents(): Electron.WebContents | null {
    const wc = this.activeView()?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** 按标签 id 取 webContents；只给主进程内部用，不通过 IPC 暴露。 */
  webContentsOf(id: string): Electron.WebContents | null {
    const view = this.views.get(id)
    const wc = view?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** 标记这是以图搜图的结果标签；界面据此露出「收下结果」。 */
  markSearchTab(id: string, engineId: string): void {
    if (!findTab(this.state, id)) return
    this.patch(id, { searchEngine: engineId })
  }

  /**
   * 以图搜图用：开一个标签并切成当前标签。
   *
   * 当前标签本来就是搜索结果页时直接复用它：省掉一次网页进程启动（约 200–400ms），
   * 也不会越搜标签越多。普通浏览标签不动，仍然新开一个。
   */
  openSearchTab(url: string): { tabId: string; webContents: Electron.WebContents } | null {
    const active = findTab(this.state, this.state.activeId)
    if (active?.searchEngine) {
      // 先改状态再补视图：休眠后没视图时，ensureView 会直接按新地址建，省一次跳转
      this.patch(active.id, { url, title: '', progress: 0, error: null })
      const existing = this.views.get(active.id)
      const alive = existing && !existing.webContents.isDestroyed() ? existing : null
      const view = alive ?? this.ensureView(active.id)
      if (!view) return null
      if (alive) void view.webContents.loadURL(resolveUrl(url, this.deps.startPageUrl()))
      return { tabId: active.id, webContents: view.webContents }
    }

    const state = this.newTab(url)
    const tabId = state.activeId
    if (!tabId) return null
    const webContents = this.webContentsOf(tabId)
    return webContents ? { tabId, webContents } : null
  }

  dispose(): void {
    if (this.sleepTimer !== null) {
      clearInterval(this.sleepTimer)
      this.sleepTimer = null
    }
    this.lastActiveAt.clear()
    for (const popup of this.popups) {
      if (!popup.isDestroyed()) popup.close()
    }
    this.popups.clear()
    for (const view of this.views.values()) {
      try {
        if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
      } catch {
        // 已经没掉的进程不用再关
      }
    }
    this.views.clear()
  }
}
