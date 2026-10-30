import { useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Earth, Heart, MagicStar, Menu, Refresh } from 'reicon-react'
import { displayUrl, MAX_START_SOURCES, START_PAGE_URL, type BrowserTab } from '../../../shared/browser'
import { formatAccelerator } from '../../../shared/shortcuts'
import { browserBridge } from '../bridge'
import { useBrowserStore } from '../state/browser'
import { useGraphStore } from '../state/graph'
import { useUiStore } from '../state/ui'
import { NewTabIcon, TabCloseIcon } from './BrowserChromeIcons'
import CollectModeToggle from './CollectModeToggle'

/** 收藏状态比对：忽略末尾斜杠；站点根地址也匹配它的子页面。 */
const favoriteKey = (url: string): string => url.replace(/\/+$/, '')
const favoriteMatches = (saved: string, current: string): boolean => {
  const a = favoriteKey(saved)
  const b = favoriteKey(current)
  return b === a || b.startsWith(`${a}/`)
}

/**
 * 浏览器 chrome（路线图 D3.1–D3.6）。
 *
 * 两行结构（设计稿 §7.3）：
 *   - 上排：应用标识（36×36 深色圆角）+ 标签条
 *   - 下排：导航栏（后退/前进/刷新 + 地址栏 + 更多）
 * 网页本身是**主进程的原生视图**，盖在 chrome 下面那块，这里画不到它。
 *
 * 左停靠时，它与原生网页视图按宽度一起从画布下方揭开；画布右侧边缘保持固定。
 * 右停靠/浮动仍使用卡片式行为。宽度与停靠侧由主进程算好推来（D3.5–D3.7）。
 */

export default function BrowserPanel(): React.JSX.Element {
  const state = useBrowserStore((store) => store.state)
  const load = useBrowserStore((store) => store.load)
  const apply = useBrowserStore((store) => store.apply)
  const activateTab = useBrowserStore((store) => store.activateTab)
  const closeTab = useBrowserStore((store) => store.closeTab)
  const newTab = useBrowserStore((store) => store.newTab)
  const moveTab = useBrowserStore((store) => store.moveTab)

  const panel = useUiStore((store) => store.panel)
  const folderPanelOpen = useUiStore((store) => store.folderPanelOpen)
  const closeBrowser = useUiStore((store) => store.closeBrowser)
  const startCapture = useGraphStore((store) => store.startCapture)
  const cancelCapture = useGraphStore((store) => store.cancelCapture)
  const capture = useGraphStore((store) => store.capture)
  const setNotice = useGraphStore((store) => store.setNotice)
  const shortcuts = useUiStore((store) => store.shortcuts)

  const [dragId, setDragId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  // 首次挂载拉一次状态，并订阅主进程推来的变更
  useEffect(() => {
    void load()
    const unsubscribe = browserBridge()?.onStateChanged(apply)
    return () => unsubscribe?.()
  }, [load, apply])

  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? null
  const canFavorite = Boolean(active && /^https?:\/\//i.test(active.url) && active.url !== START_PAGE_URL)
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(() => new Set())
  const isFavorited = Boolean(
    active && [...favoriteUrls].some((saved) => favoriteMatches(saved, active.url))
  )

  /** 起始页里已有的站点（含默认推荐）也算已收藏，心形直接显示反色。 */
  useEffect(() => {
    const bridge = browserBridge()
    if (!bridge) return
    void bridge.getFavoriteUrls().then((urls) => {
      setFavoriteUrls(new Set(urls.map(favoriteKey)))
    })
  }, [active?.url])

  /** 收藏当前网页：主进程把它写进起始页的推荐站点，缩略图用当前 favicon。 */
  const addFavorite = async (tab: BrowserTab): Promise<void> => {
    const bridge = browserBridge()
    if (!bridge) {
      setNotice('收藏功能没能加载，请重启 InsPin', 'error')
      return
    }
    const saved = await bridge.getFavoriteUrls().catch(() => [])
    if (saved.length >= MAX_START_SOURCES) {
      setNotice(`起始页最多收藏 ${MAX_START_SOURCES} 个站点，先删掉一个再收藏`, 'error')
      return
    }
    setNotice('正在收藏到起始页…', 'loading')
    const ok = await bridge.addFavorite({
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon ?? null
    })
    if (ok) setFavoriteUrls((prev) => new Set(prev).add(favoriteKey(tab.url)))
    setNotice(ok ? '已收藏到起始页' : '这个网址不能收藏', ok ? 'success' : 'error')
  }

  /** 取消收藏：按当前网址找到匹配的已收藏站点，从起始页里移除。 */
  const removeFavorite = async (tab: BrowserTab): Promise<void> => {
    const bridge = browserBridge()
    if (!bridge) {
      setNotice('收藏功能没能加载，请重启 InsPin', 'error')
      return
    }
    const saved = [...favoriteUrls].find((url) => favoriteMatches(url, tab.url))
    if (!saved) {
      setNotice('没有找到已收藏的站点', 'error')
      return
    }
    const ok = await bridge.removeFavorite(saved)
    if (ok) {
      setFavoriteUrls((prev) => {
        const next = new Set(prev)
        next.delete(saved)
        return next
      })
    }
    setNotice(ok ? '已取消收藏' : '取消收藏失败', ok ? 'success' : 'error')
  }

  /** 关掉最后一个标签就顺手把浏览器收起来（再打开时会自动开一个新标签页）。 */
  const closeTabAndMaybePanel = async (id: string): Promise<void> => {
    await closeTab(id)
    if (useBrowserStore.getState().state.tabs.length === 0) closeBrowser()
  }

  return (
    <div
      className="browser"
      aria-label="浏览器"
      data-dock={panel.dock}
      data-open={panel.open && !folderPanelOpen}
      style={{ '--panel-w': `${panel.openWidth}px` } as CSSProperties}
    >
      <div className="browser__top">
        {/* 左上角那颗标识由画布的"浏览器开关"按钮占了（开/收都是同一颗、开时变深色），
            这里不再重复画一个 —— 面板靠左时给标签条让出那颗按钮的位置。 */}

        <div className="browser__tabs" role="tablist">
          {state.tabs.map((tab, index) => (
            <Tab
              key={tab.id}
              tab={tab}
              active={tab.id === state.activeId}
              dragging={dragId === tab.id}
              onActivate={() => void activateTab(tab.id)}
              onClose={() => void closeTabAndMaybePanel(tab.id)}
              onDragStart={() => setDragId(tab.id)}
              onDragOver={(event) => {
                if (!dragId || dragId === tab.id) return
                event.preventDefault()
                void moveTab(dragId, index)
              }}
              onDragEnd={() => setDragId(null)}
            />
          ))}

          <button
            type="button"
            className="browser__newtab"
            aria-label="新建标签"
            title={`新建标签 (${formatAccelerator(shortcuts.newTab)})`}
            onClick={() => void newTab()}
          >
            <NewTabIcon className="browser__newtab-icon" />
          </button>
        </div>
        <div className="browser__collect-group">
          {/* 冻结采集时整窗被截图覆盖层盖住，开关和退出放在覆盖层里；
              这里只画不冻结态，避免同一组控件出现两份。 */}
          {capture?.mode === 'collect' && capture.live && <CollectModeToggle />}
          {capture?.mode === 'collect' && capture.live ? (
            <button
              type="button"
              className="corner browser__collect"
              aria-label="退出智能采集"
              title="退出智能采集"
              aria-pressed="true"
              onClick={cancelCapture}
            >
              <MagicStar size={24} weight="Outline" />
            </button>
          ) : (
            <button
              type="button"
              className="corner browser__collect"
              aria-label="智能采集"
              title="智能采集"
              disabled={!active}
              onClick={() => void startCapture('collect')}
            >
              <MagicStar size={24} weight="Outline" />
            </button>
          )}
        </div>
      </div>

      <div className="browser__nav">
        <NavButton
          label="后退"
          disabled={!active?.canGoBack}
          onClick={() => active && void useBrowserStore.getState().command(active.id, 'back')}
        >
          <ArrowLeft size={17} weight="Outline" />
        </NavButton>

        <NavButton
          label="前进"
          disabled={!active?.canGoForward}
          onClick={() => active && void useBrowserStore.getState().command(active.id, 'forward')}
        >
          <ArrowRight size={17} weight="Outline" />
        </NavButton>

        <NavButton
          label={active?.loading ? '停止' : '刷新'}
          onClick={() =>
            active && void useBrowserStore.getState().command(active.id, active.loading ? 'stop' : 'reload')
          }
        >
          {active?.loading ? <span className="browser__spinner" /> : <Refresh size={17} weight="Outline" />}
        </NavButton>

        <AddressBar tab={active} />

        <NavButton
          label={isFavorited ? '取消收藏' : '收藏到起始页'}
          disabled={!canFavorite}
          className={isFavorited ? 'browser__navbtn--favorited' : undefined}
          onClick={() => active && void (isFavorited ? removeFavorite(active) : addFavorite(active))}
        >
          <Heart size={17} weight={isFavorited ? 'Filled' : 'Outline'} />
        </NavButton>

        <div className="browser__menu-wrap">
          <NavButton label="更多" onClick={() => setMenuOpen((open) => !open)}>
            <Menu size={17} weight="Outline" />
          </NavButton>
          {menuOpen && (
            <>
              <div className="browser__menu-catch" onClick={() => setMenuOpen(false)} />
              <div className="browser__menu" role="menu">
                <button
                  type="button"
                  className="browser__menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    void newTab()
                  }}
                >
                  新建标签
                </button>
                <button
                  type="button"
                  className="browser__menu-item"
                  disabled={!active || displayUrl(active).length === 0}
                  onClick={() => {
                    setMenuOpen(false)
                    if (active) void navigator.clipboard.writeText(displayUrl(active))
                  }}
                >
                  复制当前地址
                </button>
                {/* 区域截图（D3.16）：菜单只能待在 96px 的 chrome 里，
                    再加一项刚好卡满上限，别往这儿塞第四项 */}
                <button
                  type="button"
                  className="browser__menu-item"
                  disabled={!active}
                  onClick={() => {
                    setMenuOpen(false)
                    void startCapture('capture')
                  }}
                >
                  截取浏览区…
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface NavButtonProps {
  label: string
  disabled?: boolean
  className?: string
  onClick: () => void
  children: ReactNode
}

function NavButton({ label, disabled = false, className, onClick, children }: NavButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`browser__navbtn${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function AddressBar({ tab }: { tab: BrowserTab | null }): React.JSX.Element {
  const navigate = useBrowserStore((store) => store.navigate)
  const shown = displayUrl(tab)
  const [draft, setDraft] = useState(shown)
  const [editing, setEditing] = useState(false)

  // 不在输入时跟着标签地址走（前进/后退也会更新）
  useEffect(() => {
    if (!editing) setDraft(shown)
  }, [shown, editing])

  return (
    <input
      className="browser__address"
      aria-label="地址"
      spellCheck={false}
      placeholder="开始或输入网址"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        setEditing(true)
        event.target.select()
      }}
      onBlur={() => {
        setEditing(false)
        setDraft(shown)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          if (tab && draft.trim().length > 0) void navigate(tab.id, draft)
          ;(event.target as HTMLInputElement).blur()
        }
        if (event.key === 'Escape') {
          setDraft(shown)
          ;(event.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

interface TabProps {
  tab: BrowserTab
  active: boolean
  dragging: boolean
  onActivate: () => void
  onClose: () => void
  onDragStart: () => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

function Tab({ tab, active, dragging, onActivate, onClose, onDragStart, onDragOver, onDragEnd }: TabProps): React.JSX.Element {
  // 起始页在标签上叫「起始页」，不显示它的本地地址
  const isHome = tab.url === START_PAGE_URL
  const title = isHome
    ? '起始页'
    : tab.title.trim().length > 0
      ? tab.title
      : displayUrl(tab) || '新标签页'
  const [faviconFailed, setFaviconFailed] = useState(false)

  // 每次导航得到新图标时重新允许加载；坏图标只影响当前标签，Earth 立即兜底。
  useEffect(() => setFaviconFailed(false), [tab.favicon])

  return (
    <div
      className="browser__tab"
      role="tab"
      aria-selected={active}
      data-active={active}
      data-dragging={dragging}
      title={title}
      draggable
      onClick={onActivate}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <span className="browser__tab-content">
        {tab.loading ? (
          <span className="browser__spinner browser__spinner--tab" />
        ) : tab.favicon && !faviconFailed ? (
          <img
            className="browser__tab-favicon"
            src={tab.favicon}
            alt=""
            onError={() => setFaviconFailed(true)}
          />
        ) : (
          <span className="browser__tab-glyph">
            <Earth className="browser__tab-earth" size={16} aria-hidden="true" />
          </span>
        )}
        <span className="browser__tab-title">{title}</span>
        <button
          type="button"
          className="browser__tab-close"
          aria-label="关闭标签"
          title="关闭标签"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <TabCloseIcon className="browser__tab-close-icon" />
        </button>
      </span>
    </div>
  )
}
