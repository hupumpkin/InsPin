import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Database, InfoCircle, Keyboard, Settings2, X } from 'reicon-react'
import appIcon from '../assets/app-icon.png'
import githubIcon from '../assets/icons/github.svg'
import type { SettingsTab } from '../../../shared/ipc'
import {
  acceleratorFromEvent,
  acceleratorFromMouseEvent,
  defaultShortcut,
  formatAccelerator,
  isDefaultShortcut,
  shortcutConflict,
  supportsMouseBinding,
  SHORTCUT_DEFINITIONS,
  type ShortcutAction
} from '../../../shared/shortcuts'
import { CANVAS_COLORS, useUiStore } from '../state/ui'
import { browserBridge } from '../bridge'
import { closeColorPicker } from '../coloris'
import ColorisInput from './ColorisInput'
import DataSettings from './DataSettings'
import MaskIcon from './MaskIcon'

/**
 * 设置面板（画布右下角设置入口、程序坞右键 / 应用菜单 → 设置）。
 *
 * 设计稿没画设置，所以按既有语言做：白面、r12、同一种投影，整块界面零彩度。
 * 左边是分类，右边是内容；内容区自己滚动，左右两栏不会一起被长页面拉走。
 *
 * **铺满整窗**：网页是原生视图、永远盖在界面之上，所以打开设置时先让原生网页
 * 临时让位（`setCovered`），蒙层和面板才能在窗口正中，而不是缩在画布那半边。
 */

const TABS: { id: SettingsTab; label: string; icon: typeof Settings2 }[] = [
  { id: 'about', label: '产品介绍', icon: InfoCircle },
  { id: 'general', label: '通用', icon: Settings2 },
  { id: 'shortcuts', label: '快捷键设置', icon: Keyboard },
  { id: 'data', label: '数据与备份', icon: Database }
]

export default function SettingsPanel(): React.JSX.Element {
  const tab = useUiStore((state) => state.settings)
  const openSettings = useUiStore((state) => state.openSettings)
  const closeSettings = useUiStore((state) => state.closeSettings)
  const active = TABS.find((item) => item.id === tab) ?? TABS[0]!
  const dismissSettings = (): void => {
    closeColorPicker()
    closeSettings()
  }
  const selectTab = (nextTab: SettingsTab): void => {
    closeColorPicker()
    openSettings(nextTab)
  }
  const dismissColorPickerForOtherControl = (event: ReactPointerEvent<HTMLElement>): void => {
    const target = event.target
    if (target instanceof Element && target.closest('.settings__custom-color')) return
    closeColorPicker()
  }

  // 网页是原生视图，会盖住界面：设置打开期间先让它让位，蒙层才能盖住整个窗口。
  useEffect(() => {
    browserBridge()?.setCovered(true)
    return () => browserBridge()?.setCovered(false)
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Esc 只关设置面板，别让它继续冒泡去关别的东西。
      // 正在录制快捷键时，Esc 属于"取消这次录制"，由录制那一行自己处理。
      if (event.key === 'Escape' && !document.querySelector('[data-recording="true"]')) {
        event.preventDefault()
        event.stopPropagation()
        dismissSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [dismissSettings])

  useEffect(() => () => closeColorPicker(), [])

  /** 分类之间用 ↑ / ↓ 切换，和系统设置的手感一致。 */
  const moveTab = (direction: 1 | -1): void => {
    const index = TABS.findIndex((item) => item.id === active.id)
    const next = TABS[(index + direction + TABS.length) % TABS.length]!
    selectTab(next.id)
  }

  return (
    <div className="settings-backdrop" onMouseDown={dismissSettings}>
      <section
        className="settings"
        role="dialog"
        aria-label="设置"
        onPointerDownCapture={dismissColorPickerForOtherControl}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="settings__side">
          <nav
            className="settings__nav"
            role="tablist"
            aria-label="设置分类"
            aria-orientation="vertical"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveTab(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveTab(-1)
              }
            }}
          >
            {TABS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  className="settings__nav-item"
                  aria-selected={tab === item.id}
                  tabIndex={tab === item.id ? 0 : -1}
                  onClick={() => selectTab(item.id)}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        <div className="settings__main">
          <header className="settings__head">
            <h2 className="settings__heading">{active.label}</h2>
            <button type="button" className="panel__close" aria-label="关闭" onClick={dismissSettings}>
              <X size={15} weight="Outline" />
            </button>
          </header>

          <div className="settings__body">
            {tab === 'general' ? (
              <General />
            ) : tab === 'about' ? (
              <About />
            ) : tab === 'shortcuts' ? (
              <Shortcuts />
            ) : (
              <DataSettings />
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function General(): React.JSX.Element {
  const convert = useUiStore((state) => state.copyConvertToPng)
  const setConvert = useUiStore((state) => state.setCopyConvertToPng)
  const canvasColor = useUiStore((state) => state.canvasColor)
  const setCanvasColor = useUiStore((state) => state.setCanvasColor)
  const libraryView = useUiStore((state) => state.libraryView)
  const setLibraryView = useUiStore((state) => state.setLibraryView)
  const openBrowserOnLaunch = useUiStore((state) => state.openBrowserOnLaunch)
  const setOpenBrowserOnLaunch = useUiStore((state) => state.setOpenBrowserOnLaunch)
  const freezeSmartCollection = useUiStore((state) => state.freezeSmartCollection)
  const setFreezeSmartCollection = useUiStore((state) => state.setFreezeSmartCollection)
  const imageSearchConsent = useUiStore((state) => state.imageSearchConsent)
  const setImageSearchConsent = useUiStore((state) => state.setImageSearchConsent)
  const imageSearchCollectLimit = useUiStore((state) => state.imageSearchCollectLimit)
  const setImageSearchCollectLimit = useUiStore((state) => state.setImageSearchCollectLimit)
  const [limitDraft, setLimitDraft] = useState(String(imageSearchCollectLimit))
  useEffect(() => setLimitDraft(String(imageSearchCollectLimit)), [imageSearchCollectLimit])
  const resetSettings = useUiStore((state) => state.resetSettings)
  const [confirmReset, setConfirmReset] = useState(false)

  return (
    <div className="settings__section">
      <div className="settings__group">
        <h3 className="settings__subtitle">外观</h3>
        <div className="settings__field">
          <span className="settings__field-text">
            <strong className="settings__field-label">画布底色</strong>
            <span className="settings__hint">只换画布背景，不影响画布上的素材。</span>
          </span>
          <div className="settings__swatches" role="group" aria-label="画布底色">
            {CANVAS_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                className="settings__swatch"
                aria-label={color.label}
                aria-pressed={canvasColor.toLowerCase() === color.value}
                style={{ background: color.value }}
                onClick={() => setCanvasColor(color.value)}
              />
            ))}
            <label className="settings__custom-color" title="自定义颜色">
              <ColorisInput
                className="settings__custom-color-input"
                label="自定义画布底色"
                value={canvasColor}
                style={{ backgroundColor: canvasColor }}
                onChange={setCanvasColor}
              />
              自定义
            </label>
          </div>
        </div>
      </div>

      <div className="settings__group">
        <h3 className="settings__subtitle">启动</h3>
        <label className="settings__field settings__field--toggle">
          <span className="settings__field-text">
            <strong className="settings__field-label">进入 InsPin 时自动打开浏览器窗口</strong>
            <span className="settings__hint">
              下次启动生效。关掉后进入应用时先看到完整画布；之后仍可用 Tab 或左上角按钮打开。
            </span>
          </span>
          <input
            type="checkbox"
            checked={openBrowserOnLaunch}
            onChange={(event) => setOpenBrowserOnLaunch(event.target.checked)}
          />
        </label>
      </div>

      <div className="settings__group">
        <h3 className="settings__subtitle">以图搜图</h3>
        <label className="settings__field settings__field--toggle">
          <span className="settings__field-text">
            <strong className="settings__field-label">允许以图搜图（会上传图片到第三方）</strong>
            <span className="settings__hint">
              打开后，选中图片点「搜图」不再逐次确认；关掉后会重新询问。InsPin 不保存上传副本。
            </span>
          </span>
          <input
            type="checkbox"
            checked={imageSearchConsent}
            onChange={(event) => setImageSearchConsent(event.target.checked)}
          />
        </label>
        <div className="settings__field">
          <span className="settings__field-text">
            <strong className="settings__field-label">收下结果的数量上限</strong>
            <span className="settings__hint">最多 50 张；只收当前视野里能看到的大图。</span>
          </span>
          <label className="settings__number-field">
            最多
            <input
              type="number"
              className="settings__number"
              min={1}
              max={50}
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
              onBlur={() => {
                const parsed = Number(limitDraft)
                const limit = Math.min(
                  50,
                  Math.max(1, Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : imageSearchCollectLimit)
                )
                setLimitDraft(String(limit))
                setImageSearchCollectLimit(limit)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            张
          </label>
        </div>
      </div>

      <div className="settings__group">
        <h3 className="settings__subtitle">素材库</h3>
        <div className="settings__field">
          <span className="settings__field-text">
            <strong className="settings__field-label">默认视图</strong>
            <span className="settings__hint">下次打开素材侧栏时用这个排列方式。</span>
          </span>
          <div className="settings__segmented" role="group" aria-label="素材库默认视图">
            <button
              type="button"
              aria-pressed={libraryView === 'grid'}
              onClick={() => setLibraryView('grid')}
            >
              网格
            </button>
            <button
              type="button"
              aria-pressed={libraryView === 'list'}
              onClick={() => setLibraryView('list')}
            >
              列表
            </button>
          </div>
        </div>
      </div>

      <div className="settings__group">
        <h3 className="settings__subtitle">智能采集</h3>
        <label className="settings__field settings__field--toggle">
          <span className="settings__field-text">
            <strong className="settings__field-label">采集时冻结网页</strong>
            <span className="settings__hint">默认开启，采集期间网页保持静止，最稳定。</span>
          </span>
          <input
            type="checkbox"
            checked={freezeSmartCollection}
            onChange={(event) => setFreezeSmartCollection(event.target.checked)}
          />
        </label>
        {!freezeSmartCollection && (
          <p className="settings__warning" role="note">
            <strong>实验功能</strong>：边滚动边采集可能引起程序报错，建议先用冻结模式。
          </p>
        )}
      </div>

      <div className="settings__group">
        <h3 className="settings__subtitle">复制</h3>
        <label className="settings__field settings__field--toggle">
          <span className="settings__field-text">
            <strong className="settings__field-label">复制时自动把不兼容的格式转成 PNG</strong>
            <span className="settings__hint">
              webp / avif / gif 会先转成 PNG 再放进剪贴板，Relay、Photoshop 这类不认 webp
              的软件也能粘贴。Figma、Eagle 本来就认原格式，关掉可以保留体积更小的原文件。
              动图 GIF 转成 PNG 后只保留首帧。
            </span>
          </span>
          <input
            type="checkbox"
            checked={convert}
            onChange={(event) => setConvert(event.target.checked)}
          />
        </label>
      </div>

      <div className="settings__group">
        <h3 className="settings__subtitle">恢复</h3>
        <div className="settings__field">
          <span className="settings__field-text">
            <strong className="settings__field-label">恢复默认设置</strong>
            <span className="settings__hint">
              会把外观、素材库视图、复制格式、清理策略和快捷键都恢复成出厂值。
            </span>
          </span>
          <button
            type="button"
            className="settings__button"
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true)
                return
              }
              setConfirmReset(false)
              void resetSettings()
            }}
            onBlur={() => setConfirmReset(false)}
          >
            {confirmReset ? '再点一次确认' : '恢复默认'}
          </button>
        </div>
      </div>
    </div>
  )
}

const GITHUB_URL = 'https://github.com/hupumpkin/InsPin'

function About(): React.JSX.Element {
  const [version, setVersion] = useState('')

  useEffect(() => {
    let alive = true
    void window.insPin?.data
      ?.info()
      .then((info) => {
        if (alive) setVersion(info.appVersion)
      })
      .catch(() => {
        // 读不到版本不影响介绍页
      })
    return () => {
      alive = false
    }
  }, [])

  /** 更新页交给系统浏览器：内置浏览器的下载体验不够好。 */
  const openGithub = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault()
    void window.insPin?.openExternal(GITHUB_URL)
  }

  return (
    <div className="settings__about">
      <div className="settings__about-main">
        <div className="settings__about-icon">
          <img src={appIcon} alt="" />
        </div>
        <h2 className="settings__about-title">灵感钉</h2>
        <p className="settings__about-copy">一块帮你快捷采集灵感的本地画布</p>
        <a className="settings__about-update" href={GITHUB_URL} onClick={openGithub}>
          <span>找更新</span>
          <MaskIcon className="settings__about-github" src={githubIcon} />
          <span className="settings__about-link">{GITHUB_URL}</span>
        </a>
      </div>
      <p className="settings__about-version">{version || ' '}</p>
    </div>
  )
}

function Shortcuts(): React.JSX.Element {
  const shortcuts = useUiStore((state) => state.shortcuts)
  const setShortcut = useUiStore((state) => state.setShortcut)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 录到一个组合后统一做冲突检查与落库。 */
  function commit(accelerator: string): void {
    const conflict = shortcutConflict(shortcuts, recording!, accelerator)
    if (conflict) {
      setError(`和「${conflict.label}」重复了，换一个组合`)
      return
    }
    setShortcut(recording!, accelerator)
    setRecording(null)
    setError(null)
  }

  useEffect(() => {
    if (!recording) return
    function onKeyDown(event: KeyboardEvent): void {
      // 录制时把按键全收走：不让它触发画布工具，也不让它冒泡到别的快捷键处理
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(null)
        setError(null)
        return
      }
      const accelerator = acceleratorFromEvent(event)
      if (accelerator) commit(accelerator)
    }
    function onMouseDown(event: MouseEvent): void {
      // 点击录制按钮本身是左键，放过去；中键按下才算一次录制
      if (event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
      if (!supportsMouseBinding(recording!)) {
        setError('这个动作只支持键盘快捷键')
        return
      }
      const accelerator = acceleratorFromMouseEvent(event)
      if (accelerator) commit(accelerator)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [recording, shortcuts, setShortcut])

  const groups = SHORTCUT_DEFINITIONS.reduce<{ name: string; items: typeof SHORTCUT_DEFINITIONS }[]>(
    (list, definition) => {
      const found = list.find((group) => group.name === definition.group)
      if (found) found.items = [...found.items, definition]
      else list.push({ name: definition.group, items: [definition] })
      return list
    },
    []
  )

  return (
    <div className="settings__section">
      <p className="settings__lead">
        点一下右边的键位，再按下新的组合就能改；也可以按鼠标中键（可带 ⌥⌃⇧⌘）。输入框里打字时这些快捷键不会抢键。
      </p>
      {error && <p className="settings__error">{error}</p>}
      {groups.map((group) => (
        <div key={group.name} className="settings__group">
          <h3 className="settings__subtitle">{group.name}</h3>
          <dl className="settings__keys">
            {group.items.map((definition) => {
              const active = recording === definition.action
              return (
                <div key={definition.action} className="settings__key">
                  <dt>{definition.label}</dt>
                  <dd>
                    <button
                      type="button"
                      className="settings__shortcut"
                      data-recording={active ? 'true' : undefined}
                      aria-pressed={active}
                      onClick={() => {
                        setRecording(definition.action)
                        setError(null)
                      }}
                    >
                      {active ? '请按新的快捷键或中键…' : formatAccelerator(shortcuts[definition.action])}
                    </button>
                    {!isDefaultShortcut(definition.action, shortcuts[definition.action]) && (
                      <button
                        type="button"
                        className="settings__shortcut-reset"
                        onClick={() => setShortcut(definition.action, defaultShortcut(definition.action))}
                      >
                        恢复默认
                      </button>
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        </div>
      ))}
      <p className="settings__hint">
        空格临时平移、Esc 取消选择、Enter 原位编辑、鼠标双击这些操作是固定的，不参与改键。
      </p>
      <p className="settings__hint">
        绑到鼠标中键的动作在 InsPin 界面里都能用；网页区域里只有「智能采集」和「新建浏览器标签」会响应，其余动作请先点回画布。
      </p>
    </div>
  )
}
