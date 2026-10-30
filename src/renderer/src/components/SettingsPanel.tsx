import {
  useEffect,
  useRef,
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
  formatAcceleratorParts,
  isDefaultShortcut,
  modifierLabels,
  shortcutConflict,
  shortcutConflicts,
  supportsMouseBinding,
  SHORTCUT_DEFINITIONS,
  type HeldModifiers,
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
            <strong className="settings__field-label">采集时锁定屏幕</strong>
            <span className="settings__hint">默认开启，采集期间屏幕保持锁定，适合逐张收集。</span>
          </span>
          <input
            type="checkbox"
            checked={freezeSmartCollection}
            onChange={(event) => setFreezeSmartCollection(event.target.checked)}
          />
        </label>
        {!freezeSmartCollection && (
          <p className="settings__warning" role="note">
            屏幕保持可滚动，可边滚动边采集；切换标签页、收起面板或刷新网页会结束本次采集。
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

const NO_MODIFIERS: HeldModifiers = { ctrl: false, alt: false, shift: false, meta: false }

/** 空闲时显示已存的组合；录制时显示按住中的修饰键和"按键"占位。 */
function ShortcutKeycaps({
  accelerator,
  held
}: {
  accelerator: string | null
  held: HeldModifiers | null
}): React.JSX.Element {
  if (held) {
    return (
      <span className="settings__keycaps">
        {modifierLabels(held).map((label) => (
          <kbd key={label} className="settings__keycap" data-held="true">
            {label}
          </kbd>
        ))}
        <kbd className="settings__keycap settings__keycap--pending">按键</kbd>
        <span className="settings__record-hint">或中键</span>
      </span>
    )
  }
  const parts = formatAcceleratorParts(accelerator)
  if (parts.length === 0) return <span className="settings__unset">未设置</span>
  return (
    <span className="settings__keycaps">
      {parts.map((part, index) => (
        <kbd key={`${part}-${index}`} className="settings__keycap">
          {part}
        </kbd>
      ))}
    </span>
  )
}

function Shortcuts(): React.JSX.Element {
  const shortcuts = useUiStore((state) => state.shortcuts)
  const setShortcut = useUiStore((state) => state.setShortcut)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [held, setHeld] = useState<HeldModifiers>(NO_MODIFIERS)
  // pointerdown 与 mousedown 会为同一次中键各发一次，用这个标记只处理第一下。
  const pressHandled = useRef(false)

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
    setHeld(NO_MODIFIERS)
  }

  function startRecording(action: ShortcutAction): void {
    setRecording(action)
    setError(null)
    setHeld(NO_MODIFIERS)
    pressHandled.current = false
  }

  function cancelRecording(): void {
    setRecording(null)
    setError(null)
    setHeld(NO_MODIFIERS)
    pressHandled.current = false
  }

  useEffect(() => {
    if (!recording) return
    pressHandled.current = false

    function syncHeld(event: KeyboardEvent): void {
      setHeld({
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey
      })
    }

    function onKeyDown(event: KeyboardEvent): void {
      // 录制时把按键全收走：不让它触发画布工具，也不让它冒泡到别的快捷键处理
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        cancelRecording()
        return
      }
      // 长按只取第一下，系统连发不能重复录入
      if (event.repeat) return
      // 只按修饰键时先把它们实时亮出来，按到主键才落库
      syncHeld(event)
      const accelerator = acceleratorFromEvent(event)
      if (accelerator) commit(accelerator)
    }

    function onKeyUp(event: KeyboardEvent): void {
      syncHeld(event)
    }

    /** 中键：pointerdown / mousedown 只处理一次，并把默认行为挡掉。 */
    function onMiddleDown(event: MouseEvent): void {
      if (event.button !== 1 || pressHandled.current) return
      event.preventDefault()
      event.stopPropagation()
      pressHandled.current = true
      if (!supportsMouseBinding(recording!)) {
        setError('这个动作只支持键盘快捷键')
        return
      }
      const accelerator = acceleratorFromMouseEvent(event)
      if (accelerator) commit(accelerator)
    }

    function onMiddleUp(event: MouseEvent): void {
      if (event.button === 1) pressHandled.current = false
    }

    function onAuxClick(event: MouseEvent): void {
      if (event.button === 1) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    function onBlur(): void {
      // 切走窗口时手已经松开，别把修饰键一直亮着
      setHeld(NO_MODIFIERS)
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onMiddleDown, true)
    window.addEventListener('mousedown', onMiddleDown, true)
    window.addEventListener('pointerup', onMiddleUp, true)
    window.addEventListener('mouseup', onMiddleUp, true)
    window.addEventListener('auxclick', onAuxClick, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onMiddleDown, true)
      window.removeEventListener('mousedown', onMiddleDown, true)
      window.removeEventListener('pointerup', onMiddleUp, true)
      window.removeEventListener('mouseup', onMiddleUp, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('blur', onBlur)
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

  const conflicts = shortcutConflicts(shortcuts)
  const recordingLabel = recording
    ? (SHORTCUT_DEFINITIONS.find((definition) => definition.action === recording)?.label ?? '')
    : ''

  return (
    <div className="settings__section">
      {(error || conflicts.length > 0) && (
        <div className="settings__notices">
          {error && (
            <div className="settings__notice settings__notice--error" role="alert">
              {recordingLabel && <strong>{recordingLabel}</strong>}
              <span>{error}</span>
            </div>
          )}
          {conflicts.length > 0 && (
            <div className="settings__notice" role="alert">
              <strong>检测到快捷键冲突</strong>
              <ul>
                {conflicts.map((conflict) => (
                  <li key={`${conflict.action}-${conflict.source}-${conflict.otherLabel}`}>
                    {conflict.source === 'system'
                      ? `「${conflict.label}」与系统快捷键「${conflict.otherLabel}」冲突`
                      : `「${conflict.label}」和「${conflict.otherLabel}」重复`}
                    （{formatAccelerator(conflict.accelerator)}）
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className="settings__lead">
        点一下右边的键位进入录制，按住 ⌘ / ⌥ / ⇧ / ⌃ 会实时亮起，再按一个主键完成；也可以按鼠标中键（可带修饰键）。Esc 取消。
        输入框里打字时这些快捷键不会抢键。
      </p>
      {groups.map((group) => (
        <div key={group.name} className="settings__group">
          <h3 className="settings__subtitle">{group.name}</h3>
          <dl className="settings__keys">
            {group.items.map((definition) => {
              const active = recording === definition.action
              return (
                <div key={definition.action} className="settings__key">
                  <dt>
                    {definition.label}
                    {definition.hint && <span className="settings__key-hint">{definition.hint}</span>}
                  </dt>
                  <dd>
                    <button
                      type="button"
                      className="settings__shortcut"
                      data-recording={active ? 'true' : undefined}
                      aria-pressed={active}
                      aria-label={
                        active
                          ? `${definition.label}：正在录制，请按新的快捷键或鼠标中键`
                          : `${definition.label}：${formatAccelerator(shortcuts[definition.action])}`
                      }
                      onClick={() => startRecording(definition.action)}
                    >
                      <ShortcutKeycaps
                        accelerator={active ? null : shortcuts[definition.action]}
                        held={active ? held : null}
                      />
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
