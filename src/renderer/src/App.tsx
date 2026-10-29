import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Folder } from 'reicon-react'
import { COLLAPSE_WIDTH } from '../../shared/panel'
import { BrowserMarkIcon } from './components/BrowserChromeIcons'
import BrowserPanel from './components/BrowserPanel'
import CanvasStage from './components/CanvasStage'
import CaptureOverlay from './components/CaptureOverlay'
import CanvasToolbar from './components/CanvasToolbar'
import CommandPalette from './components/CommandPalette'
import CornerButton from './components/CornerButton'
import FolderPanel from './components/FolderPanel'
import LayersPanel from './components/LayersPanel'
import PanelSplitter from './components/PanelSplitter'
import SettingsPanel from './components/SettingsPanel'
import { browserBridge, canvasBridge, settingsBridge } from './bridge'
import { isEditableTarget } from './dom'
import { viewCenter } from './canvas/view-center'
import {
  acceleratorFromEvent,
  acceleratorFromMouseEvent,
  isDefaultShortcut,
  matchesAccelerator,
  sameAccelerator
} from '../../shared/shortcuts'
import { useBrowserStore } from './state/browser'
import { useGraphStore } from './state/graph'
import { useProjectStore } from './state/projects'
import { useUiStore } from './state/ui'

/**
 * 智能采集入口（⌘1）：浏览器没开就先展开，确保有标签页，再进入连续采集。
 * 面板几何由主进程算，所以等 setPanel 返回后再开始，避免抢在展开之前调用。
 */
async function beginSmartCollect(): Promise<void> {
  // 已经在采集（框选或连续采集）时不要重复进入
  if (useGraphStore.getState().capture) return
  const ui = useUiStore.getState()
  if (ui.folderPanelOpen) ui.closeFolderPanel()
  if (!ui.panel.open) {
    const api = browserBridge()
    if (api) {
      const layout = await api.setPanel({ open: true })
      useUiStore.getState().applyPanel(layout)
    }
  }
  if (useBrowserStore.getState().state.tabs.length === 0) {
    await useBrowserStore.getState().newTab()
  }
  void useGraphStore.getState().startCapture('collect')
}

export default function App(): React.JSX.Element {
  const loadProjects = useProjectStore((state) => state.load)
  const currentId = useProjectStore((state) => state.currentId)
  const loadGraph = useGraphStore((state) => state.load)
  const importClipboard = useGraphStore((state) => state.importClipboard)
  const setNotice = useGraphStore((state) => state.setNotice)

  const capture = useGraphStore((state) => state.capture)
  const settings = useUiStore((state) => state.settings)
  const openSettings = useUiStore((state) => state.openSettings)
  const loadSettings = useUiStore((state) => state.loadSettings)
  const applySettings = useUiStore((state) => state.applySettings)
  const panel = useUiStore((state) => state.panel)
  const applyPanel = useUiStore((state) => state.applyPanel)
  const toggleBrowser = useUiStore((state) => state.toggleBrowser)
  const hideBrowserImmediately = useUiStore((state) => state.hideBrowserImmediately)
  const folderPanelOpen = useUiStore((state) => state.folderPanelOpen)
  const openFolderPanel = useUiStore((state) => state.openFolderPanel)
  const closeFolderPanel = useUiStore((state) => state.closeFolderPanel)
  const layersOpen = useUiStore((state) => state.layersOpen)
  const toggleLayers = useUiStore((state) => state.toggleLayers)
  const canvasControlsCollapsed = useUiStore((state) => state.canvasControlsCollapsed)
  const setCanvasControlsCollapsed = useUiStore((state) => state.setCanvasControlsCollapsed)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  /** 非紧凑状态下量到的宽度：收起来之后仍靠它预测"展开会不会撞上"。 */
  const barSizesRef = useRef({ toolbar: 271, controls: 213 })

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // 切换项目就换一张画布
  useEffect(() => {
    void loadGraph(currentId)
  }, [currentId, loadGraph])

  // 程序坞右键 / 应用菜单里点了设置，主进程推过来，界面把面板打开
  useEffect(() => settingsBridge()?.onOpen(openSettings), [openSettings])

  // 原图在 Finder 里被删后，主进程会清掉素材与画布节点；当前项目跟着重读一次画布
  useEffect(() => {
    const api = canvasBridge()
    if (!api || typeof api.onAssetsPruned !== 'function') return
    return api.onAssetsPruned((notice) => {
      void useGraphStore.getState().refreshAfterPrune(notice.projectIds)
    })
  }, [])

  // 设置（快捷键、清理策略、外观）存在主进程：首帧读一次，之后订阅它的变化
  useEffect(() => {
    void loadSettings()
    return settingsBridge()?.onChanged(applySettings)
  }, [loadSettings, applySettings])

  // 面板几何的权威在主进程（它才知道窗口真实尺寸、也要摆原生网页视图）：
  // 首帧拉一次对齐，之后订阅它推来的变化（开关、停靠切换、拖宽度、窗口降级都会推）
  useEffect(() => {
    const api = browserBridge()
    if (!api) return
    void api.getPanel().then(applyPanel)
    return api.onPanelChanged(applyPanel)
  }, [applyPanel])

  // 非冻结智能采集直接在网页内接住点击；这里把命中的候选送进既有导入链路。
  useEffect(() => {
    const api = browserBridge()
    if (!api || typeof api.onSmartCollectPicked !== 'function') return
    return api.onSmartCollectPicked((pick) => {
      void useGraphStore.getState().commitCapture(pick.selection, viewCenter(), {
        candidateId: pick.candidateId,
        continuous: true
      })
    })
  }, [])

  /**
   * 底部工具条与右下控制区打架时，按可用间距逐项收进"更多"：
   *   0 = 全展开，1–3 = 图层 / 颜色 / 设置依次收起，4 = 缩放也收起。
   *
   * 用"全展开时的间距"来推进，而不是用收起后的实际间距——否则收起一步就
   * 不挤了，下一步永远不会发生。间距按窗口与面板几何同步算，不依赖动画中的 DOM 位置。
   */
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useLayoutEffect(() => {
    // 全展开时量一次真实宽度，之后一直用它预测。
    // 只允许变大：浏览器收起 → 文件夹揭开之间，按钮还在展开动画里，量到的宽度
    // 会偏小；拿它当基准会误判“不挤”，文件夹打开后就不收拢了。
    if (canvasControlsCollapsed === 0) {
      const toolbar = document.querySelector('.toolbar')?.getBoundingClientRect()
      const controls = document.querySelector('.canvas-controls')?.getBoundingClientRect()
      if (toolbar && controls) {
        barSizesRef.current = {
          toolbar: Math.max(barSizesRef.current.toolbar, toolbar.width),
          controls: Math.max(barSizesRef.current.controls, controls.width)
        }
      }
    }

    const sizes = barSizesRef.current
    const rightDockInset = panel.open && panel.dock === 'right' ? panel.width + 8 : 0
    const controlsRightEdge = viewportWidth - 20 - rightDockInset
    const controlsLeft = controlsRightEdge - sizes.controls
    // 底部工具条的实际位置由 --panel-shift 决定；文件夹侧栏与浏览器侧栏一样
    // 会遮住画布左边，必须用同一个位移算间距，否则打开文件夹时按钮不会收拢。
    const shift = folderPanelOpen
      ? panel.openWidth / 2
      : panel.open && (panel.dock === 'left' || panel.dock === 'float')
        ? panel.width / 2
        : 0
    const toolbarRight = viewportWidth / 2 + shift + sizes.toolbar / 2
    const gap = controlsLeft - toolbarRight

    // 每一级收回的间距门槛（px）。第一级只是"靠近"，真正腾出宽度从第二级开始。
    const thresholds = [20, 0, -40, -80]
    let desired = canvasControlsCollapsed
    while (desired < 4 && gap < thresholds[desired]!) desired += 1
    // 展开方向要求多 8px 余量，避免在临界宽度反复跳
    while (desired > 0 && gap >= thresholds[desired - 1]! + 8) desired -= 1
    if (desired !== canvasControlsCollapsed) setCanvasControlsCollapsed(desired)
  }, [
    viewportWidth,
    panel.open,
    panel.width,
    panel.openWidth,
    panel.dock,
    folderPanelOpen,
    canvasControlsCollapsed,
    setCanvasControlsCollapsed
  ])

  useEffect(() => {
    /**
     * 与输入设备无关的那部分快捷键（面板、命令面板、智能采集、新标签）。
     * 键盘和鼠标中键都走这里，避免两边各写一份、改键后只生效一半。
     */
    function runGlobalShortcut(accelerator: string | null): boolean {
      if (!accelerator) return false
      const shortcuts = useUiStore.getState().shortcuts
      const match = (binding: string | null): boolean => sameAccelerator(accelerator, binding)

      if (match(shortcuts.toggleBrowser)) {
        const ui = useUiStore.getState()
        if (ui.folderPanelOpen) {
          ui.closeFolderPanel()
          window.setTimeout(() => useUiStore.getState().toggleBrowser(), 260)
        } else {
          ui.toggleBrowser()
        }
        return true
      }
      if (match(shortcuts.toggleLayers)) {
        toggleLayers()
        return true
      }
      if (match(shortcuts.commandPalette)) {
        setPaletteOpen((open) => !open)
        return true
      }
      if (match(shortcuts.smartCollect)) {
        void beginSmartCollect()
        return true
      }
      if (match(shortcuts.newTab)) {
        void useBrowserStore.getState().newTab()
        return true
      }
      return false
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target)) return
      // 设置面板打开时按键只属于设置，不再触发后面画布 / 浏览器的动作
      if (useUiStore.getState().settings) return
      if (runGlobalShortcut(acceleratorFromEvent(event))) {
        event.preventDefault()
        return
      }
      if (event.key === 'Escape') {
        // 非冻结采集时网页盖在界面上；焦点若恰好在 InsPin 自己的 chrome 上，
        // Esc 也要能退出采集，不能只认网页里那一条。
        if (useGraphStore.getState().capture?.live) {
          event.preventDefault()
          useGraphStore.getState().cancelCapture()
          return
        }
        setPaletteOpen(false)
      }
    }

    function onMouseDown(event: MouseEvent): void {
      if (event.button !== 1) return
      if (isEditableTarget(event.target) || useUiStore.getState().settings) return
      if (runGlobalShortcut(acceleratorFromMouseEvent(event))) {
        event.preventDefault()
        // 捕获阶段就收走，避免画布再把这次中键当成自己的快捷键
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [toggleLayers])

  // 网页有焦点时按键不会到达上面的 window 监听，主进程会转发这一条
  useEffect(() => {
    const unsubscribe = browserBridge()?.onSmartCollectRequested(() => {
      void beginSmartCollect()
    })
    return () => unsubscribe?.()
  }, [])

  // 非冻结采集时焦点在网页里：Esc 在主进程里退出，界面这边把采集状态跟着清掉
  useEffect(() => {
    const api = browserBridge()
    if (!api || typeof api.onCaptureEnded !== 'function') return
    return api.onCaptureEnded(() => useGraphStore.setState({ capture: null, captureFocus: null }))
  }, [])

  // ⌘V：把剪贴板里的图片贴进画布
  useEffect(() => {
    let lastTrigger = 0

    // ⌘V 可能同时触发 keydown 与 paste，两条路只认第一次，避免导入两张
    function trigger(): void {
      const now = Date.now()
      if (now - lastTrigger < 400) return
      lastTrigger = now
      // 刚复制过画布对象时，⌘V 是"粘贴对象"（画布那边处理），不是贴图
      if (useGraphStore.getState().clipboardCount > 0) return
      void importClipboard(useProjectStore.getState().currentId).then((result) => {
        if (!result.ok && !result.canceled) setNotice(result.message, 'error')
      })
    }

    function onPaste(event: ClipboardEvent): void {
      // 输入框里的粘贴是正常用字，不能抢
      if (isEditableTarget(event.target) || useUiStore.getState().settings) return
      // 原生 paste 事件不告诉我们按了什么键。只有粘贴还是默认的 ⌘V 时才由它触发；
      // 用户改过键的话，交给下面的 keydown 按新组合处理，避免旧组合仍然生效。
      if (!isDefaultShortcut('paste', useUiStore.getState().shortcuts.paste)) return
      event.preventDefault()
      trigger()
    }

    function onPasteKeyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target) || useUiStore.getState().settings) return
      if (matchesAccelerator(event, useUiStore.getState().shortcuts.paste)) trigger()
    }

    document.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onPasteKeyDown)
    return () => {
      document.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onPasteKeyDown)
    }
  }, [importClipboard, setNotice])

  /**
   * 浮动模式下画布仍是整窗的，面板只是盖在上面——所以居中类的浮层（工具栏、⌘K、
   * 项目浮层）得往右让开半个面板，否则会缩在面板底下。左右停靠时画布本来就窄了，
   * 不用再让。
   */
  // 左侧浏览器与浮层浏览器都会遮住画布左边；画布世界坐标不随之改变，
  // 只有工具栏、命令面板等 UI 需要移到剩余可见窗口的中心。
  const panelOccludesCanvas =
    folderPanelOpen || (panel.open && (panel.dock === 'left' || panel.dock === 'float'))
  // 浏览器 / 文件夹从左揭开时，画布世界仍铺满窗口；但可见窗口的左边缘需要独立
  // 保留圆角，不能被侧栏的矩形右缘切成直角。
  const leftCanvasViewportOpen = folderPanelOpen || (panel.open && panel.dock === 'left')
  const activePanelWidth = folderPanelOpen ? panel.openWidth : panel.width
  const panelShift = panelOccludesCanvas ? activePanelWidth / 2 : 0
  const panelInset = panelOccludesCanvas ? activePanelWidth : 0
  // 窗口窄到面板只能自动收起时，按钮就没什么可点的了，干脆不显示
  const canToggleBrowser = folderPanelOpen || panel.open || panel.windowWidth >= COLLAPSE_WIDTH

  const toggleFolder = (): void => {
    if (folderPanelOpen) {
      closeFolderPanel()
      return
    }
    // 先由主进程同步藏掉 WebContentsView；否则原生网页会浮在空文件夹侧栏上面。
    void hideBrowserImmediately().then(openFolderPanel)
  }

  const openBrowser = (): void => {
    // 文件夹的收起动效结束后才开始浏览器揭开，视觉上任意时刻都只有一个侧栏。
    if (folderPanelOpen) {
      closeFolderPanel()
      window.setTimeout(toggleBrowser, 260)
      return
    }
    toggleBrowser()
  }

  return (
    <div
      className="app"
      data-panel-open={panelOccludesCanvas ? 'true' : 'false'}
      data-dock={panel.dock}
      style={
        {
          '--panel-w': `${panel.openWidth}px`,
          // 关闭时从窗口物理左缘开始、被 canvas-area 自身裁掉；打开后跟随侧栏右缘。
          // 这样遮罩与侧栏用相同的位移动画，拖动时也不会出现 8px 的错位。
          '--canvas-viewport-left': `${leftCanvasViewportOpen ? panel.openWidth : 0}px`,
          '--panel-shift': `${panelShift}px`,
          '--panel-inset': `${panelInset}px`
        } as CSSProperties
      }
    >
      {/* 左侧模式由画布让出宽度、浏览器按宽度揭开；右/浮动模式仍保留原有卡片行为。
          网页本身是主进程的原生视图，盖在这块 chrome 的下面。 */}
      <BrowserPanel />
      <FolderPanel />

      {/* 分栏线（D3.5）：默认不显，鼠标挪上来才浮出细线 */}
      <PanelSplitter />

      {/* 浏览器开关是固定铰点，不属于会向右收回的画布区域。 */}
      {canToggleBrowser && (
        <CornerButton
          corner="top-left"
          label={panel.open && !folderPanelOpen ? '收起浏览器' : '打开浏览器'}
          pressed={panel.open && !folderPanelOpen}
          onClick={openBrowser}
        >
          <BrowserMarkIcon className="browser-mark" />
        </CornerButton>
      )}

      {/* 区域截图框选层（D3.16）：盖住整个窗口，所以挂在 .app 上而不是画布里 */}
      {capture && !capture.live && <CaptureOverlay screen={capture} />}

      {/* 设置：程序坞右键 / 应用菜单点进来（逃生用的，所以挂在最外层） */}
      {settings && <SettingsPanel />}

      {/* 画布那一侧：左侧模式从左缘收回露出浏览器；右侧停靠同样让出宽度；浮动时仍铺满。 */}
      <div className="canvas-area">
        {/*
          独立的“画布视图窗口”：它会在侧栏打开时从左向右缩窄，但内部世界层始终
          同尺寸。因此仅改变看见的范围，不会改变 Pixi 画布或对象的坐标、比例。
        */}
        <div className="canvas-viewport">
          <CanvasStage />
        </div>

        {/* 空文件夹侧栏：仅复用浏览器的展开/收起机制，内容稍后再接。
            浏览器侧栏打开时原生网页会盖住这块区域，此时不再露出文件夹开关——
            否则得为它留一条白色让位带，网页就铺不满底边。 */}
        {!(panel.open && !folderPanelOpen) && (
          <CornerButton
            corner="bottom-left"
            label={folderPanelOpen ? '收起文件夹侧栏' : '打开文件夹侧栏'}
            pressed={folderPanelOpen}
            onClick={toggleFolder}
          >
            <Folder size={24} />
          </CornerButton>
        )}

        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}

        <CanvasToolbar />

        {layersOpen && <LayersPanel placement="canvas-controls" />}
      </div>
    </div>
  )
}
