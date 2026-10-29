import { create } from 'zustand'
import type { SettingsTab } from '../../../shared/ipc'
import {
  DEFAULT_PANEL_PREFS,
  ratioForWidth,
  resolvePanelLayout,
  type PanelDock,
  type PanelLayout
} from '../../../shared/panel'
import {
  DEFAULT_ASSET_CLEANUP,
  DEFAULT_SETTINGS,
  type AppSettings,
  type AssetCleanupSettings,
  type LibraryView
} from '../../../shared/settings'
import { DEFAULT_SHORTCUTS, type ShortcutAction, type ShortcutBindings } from '../../../shared/shortcuts'
import { browserBridge, settingsBridge } from '../bridge'

/**
 * 界面级状态（路线图 D2.1 / D2.9）。
 *
 * 工具选择放在 store 里，是因为工具栏在角落、画布在中间，两边都得读同一个值。
 *
 * 浏览器面板（D3.5–D3.7）的**几何权威在主进程**：那边才知道窗口的真实尺寸、
 * 也要用它去摆原生网页视图。这里存的是一份**投影**——主进程算完推过来，
 * 界面照着摆 chrome、画分栏线、平移工具栏。
 */

export type ToolId = 'select' | 'hand' | 'shape-rectangle' | 'shape-ellipse' | 'shape-line' | 'text'

/** 画布底色的预设；右下角色板与设置 → 通用共用同一份。 */
export const CANVAS_COLORS = [
  { label: '浅灰', value: '#f5f4f7' },
  { label: '白色', value: '#ffffff' },
  { label: '暖白', value: '#f4f1eb' },
  { label: '深灰', value: '#20242e' }
] as const

/** 首帧还没拿到主进程布局时，先按默认偏好估一个，省得面板闪一下。 */
function initialPanel(): PanelLayout {
  const width = typeof window === 'undefined' ? 1500 : window.innerWidth
  return resolvePanelLayout({ windowWidth: width, prefs: { ...DEFAULT_PANEL_PREFS } })
}

interface UiState {
  tool: ToolId
  setTool: (tool: ToolId) => void

  /** 浏览器面板的当前布局（主进程推来） */
  panel: PanelLayout
  /** 主进程推来新布局 / 各操作拿回布局后，落到这里 */
  applyPanel: (layout: PanelLayout) => void
  /** 收起 / 展开（点左上角按钮、⌘ 关闭标签、Esc） */
  toggleBrowser: () => void
  closeBrowser: () => void
  /** 切换到文件夹侧栏前立即藏起原生网页，防止两种侧栏在同一时刻可见。 */
  hideBrowserImmediately: () => Promise<void>
  /** 停靠：左 / 右 / 浮动 */
  setPanelDock: (dock: PanelDock) => void
  /** 拖分栏线途中：立刻改本地宽度（CSS 跟手），并按帧把原生视图也挪过去 */
  previewPanelWidth: (width: number) => void
  /** 松手：把目标宽度交给主进程换算并存下来 */
  commitPanelWidth: (width: number) => void
  /** 正在拖拽分栏线：画布渲染器应暂停重建 backing store，避免闪屏。 */
  panelResizing: boolean
  setPanelResizing: (resizing: boolean) => void

  /** 左下文件夹的空侧栏；本轮只复用浏览器的揭开/收起容器，不加入业务内容。 */
  folderPanelOpen: boolean
  openFolderPanel: () => void
  closeFolderPanel: () => void

  /** 图层面板（D4a.2）是否展开。**默认收起**——用户点左上角的图层按钮再展开 */
  layersOpen: boolean
  toggleLayers: () => void
  /**
   * 检查器（D1.8）是否展开。**不常态展示**：选中对象时不会自动弹出，
   * 只有按 ⌥⌘I（或点图层面板里的入口）才出现。
   */
  inspectorOpen: boolean
  toggleInspector: () => void
  /** 画布右下角的两个面板共用同一块空间，打开其中一个时收起另一个。 */
  closeCanvasPanels: () => void
  /** 画布背景色；由 CanvasStage 同步给 Pixi 的真实渲染背景。 */
  canvasColor: string
  setCanvasColor: (color: string) => void
  /** 素材库默认排列方式（设置 → 通用） */
  libraryView: LibraryView
  setLibraryView: (view: LibraryView) => void
  /** 进入 InsPin 时是否自动展开浏览器（设置 → 通用） */
  openBrowserOnLaunch: boolean
  setOpenBrowserOnLaunch: (value: boolean) => void
  /** 智能采集时是否冻结网页；关闭后可在滚动中连续采集。 */
  freezeSmartCollection: boolean
  setFreezeSmartCollection: (value: boolean) => void
  /** 复制到其他软件时，把 webp / avif / gif 转成 PNG（默认开，见设置 → 通用） */
  copyConvertToPng: boolean
  setCopyConvertToPng: (value: boolean) => void
  /** 是否已同意「以图搜图会把图片上传到第三方站点」 */
  imageSearchConsent: boolean
  setImageSearchConsent: (value: boolean) => void
  /** 搜图结果一次最多收下多少张（1–50） */
  imageSearchCollectLimit: number
  setImageSearchCollectLimit: (value: number) => void
  /**
   * 右下角收进"更多"的入口数量（0–5，依次是图层、颜色、对象、设置、缩放）。
   * 由 App 按画布可用宽度逐级推进；只要大于 0，底部工具条也收成纯图标。
   */
  canvasControlsCollapsed: number
  setCanvasControlsCollapsed: (count: number) => void
  /** 素材自动清理策略 */
  assetCleanup: AssetCleanupSettings
  setAssetCleanup: (patch: Partial<AssetCleanupSettings>) => void
  /** 可改键的快捷键绑定 */
  shortcuts: ShortcutBindings
  setShortcut: (action: ShortcutAction, accelerator: string) => void
  /** 从主进程读一次设置；界面首帧先按默认值渲染，读完再对齐 */
  loadSettings: () => Promise<void>
  /** 主进程推来新设置（重载/多窗口） */
  applySettings: (settings: AppSettings) => void
  /** 恢复出厂设置 */
  resetSettings: () => Promise<void>
  /** 设置面板（程序坞右键 / 应用菜单打开）；null = 没开 */
  settings: SettingsTab | null
  openSettings: (tab: SettingsTab) => void
  closeSettings: () => void
}

export const useUiStore = create<UiState>((set, get) => {
  /** 所有面板操作都走"调桥 → 主进程算 → 拿回布局"，界面不再自己算宽度。 */
  const send = (patch: Parameters<NonNullable<ReturnType<typeof browserBridge>>['setPanel']>[0]): void => {
    const api = browserBridge()
    if (!api) return
    void api.setPanel(patch).then((layout) => set({ panel: layout }))
  }

  /** 把主进程那份设置铺进界面状态。 */
  const applySettingsToState = (settings: AppSettings): void => {
    set({
      copyConvertToPng: settings.copyConvertToPng,
      canvasColor: settings.canvasColor,
      libraryView: settings.libraryView,
      openBrowserOnLaunch: settings.openBrowserOnLaunch,
      freezeSmartCollection: settings.freezeSmartCollection,
      imageSearchConsent: settings.imageSearchConsent,
      imageSearchCollectLimit: settings.imageSearchCollectLimit,
      assetCleanup: settings.assetCleanup,
      shortcuts: settings.shortcuts
    })
  }

  /** 改一项：本地先改（界面立刻响应），再把补丁交给主进程校验、落盘。 */
  const savePatch = (patch: Partial<AppSettings>): void => {
    const api = settingsBridge()
    if (!api) return
    void api
      .update(patch)
      .then(applySettingsToState)
      .catch(() => {
        // 主进程不可用时保留本地值，至少本次会话里设置是生效的
      })
  }

  return {
    tool: 'select',
    setTool: (tool) => set({ tool }),

    panel: initialPanel(),
    applyPanel: (layout) => set({ panel: layout }),
    toggleBrowser: () => send({ open: !get().panel.requested }),
    closeBrowser: () => {
      if (get().panel.requested) send({ open: false })
    },
    hideBrowserImmediately: async () => {
      const api = browserBridge()
      if (!api) return
      const panel = await api.hidePanelImmediately()
      set({ panel })
    },
    setPanelDock: (dock) => send({ dock }),
    previewPanelWidth: (width) => {
      const { panel } = get()
      // 本地先改，chrome / 分栏线 / 工具栏这一帧就跟上
      set({ panel: { ...panel, width, openWidth: width } })
      // 原生网页视图在主进程中，不等下一次 animation frame。此前这里和主进程各
      // 延迟一次，视觉上会出现 chrome 已跟手、网页隔一两帧才追上的拖尾。
      // IPC 是无回执的，主进程只采纳当前这一条，不会阻塞 pointermove。
      browserBridge()?.previewPanel(width)
    },
    commitPanelWidth: (width) => {
      const { panel } = get()
      send({ ratio: ratioForWidth(width, panel.windowWidth) })
    },
    panelResizing: false,
    setPanelResizing: (panelResizing) => set({ panelResizing }),

    folderPanelOpen: false,
    openFolderPanel: () => set({ folderPanelOpen: true }),
    closeFolderPanel: () => set({ folderPanelOpen: false }),

    layersOpen: false,
    toggleLayers: () =>
      set((state) => ({
        layersOpen: !state.layersOpen,
        inspectorOpen: state.layersOpen ? state.inspectorOpen : false
      })),
    inspectorOpen: false,
    toggleInspector: () =>
      set((state) => ({
        inspectorOpen: !state.inspectorOpen,
        layersOpen: state.inspectorOpen ? state.layersOpen : false
      })),
    closeCanvasPanels: () => set({ layersOpen: false, inspectorOpen: false }),
    canvasColor: DEFAULT_SETTINGS.canvasColor,
    setCanvasColor: (canvasColor) => {
      set({ canvasColor })
      savePatch({ canvasColor })
    },

    libraryView: DEFAULT_SETTINGS.libraryView,
    setLibraryView: (libraryView) => {
      set({ libraryView })
      savePatch({ libraryView })
    },

    openBrowserOnLaunch: DEFAULT_SETTINGS.openBrowserOnLaunch,
    setOpenBrowserOnLaunch: (openBrowserOnLaunch) => {
      set({ openBrowserOnLaunch })
      savePatch({ openBrowserOnLaunch })
    },

    freezeSmartCollection: DEFAULT_SETTINGS.freezeSmartCollection,
    setFreezeSmartCollection: (freezeSmartCollection) => {
      set({ freezeSmartCollection })
      savePatch({ freezeSmartCollection })
    },

    copyConvertToPng: DEFAULT_SETTINGS.copyConvertToPng,
    setCopyConvertToPng: (copyConvertToPng) => {
      set({ copyConvertToPng })
      savePatch({ copyConvertToPng })
    },

    imageSearchConsent: DEFAULT_SETTINGS.imageSearchConsent,
    setImageSearchConsent: (imageSearchConsent) => {
      set({ imageSearchConsent })
      savePatch({ imageSearchConsent })
    },

    imageSearchCollectLimit: DEFAULT_SETTINGS.imageSearchCollectLimit,
    setImageSearchCollectLimit: (imageSearchCollectLimit) => {
      const value = Math.min(50, Math.max(1, Math.round(imageSearchCollectLimit)))
      set({ imageSearchCollectLimit: value })
      savePatch({ imageSearchCollectLimit: value })
    },

    canvasControlsCollapsed: 0,
    setCanvasControlsCollapsed: (canvasControlsCollapsed) => set({ canvasControlsCollapsed }),

    assetCleanup: { ...DEFAULT_ASSET_CLEANUP },
    setAssetCleanup: (patch) => {
      const assetCleanup = { ...get().assetCleanup, ...patch }
      set({ assetCleanup })
      savePatch({ assetCleanup })
    },

    shortcuts: { ...DEFAULT_SHORTCUTS },
    setShortcut: (action, accelerator) => {
      const shortcuts = { ...get().shortcuts, [action]: accelerator }
      set({ shortcuts })
      savePatch({ shortcuts })
    },

    loadSettings: async () => {
      const api = settingsBridge()
      if (!api) return
      try {
        applySettingsToState(await api.get())
      } catch {
        // 读不到就用默认值继续跑；设置不是打开应用的前提
      }
    },
    applySettings: applySettingsToState,
    resetSettings: async () => {
      const api = settingsBridge()
      if (!api) {
        applySettingsToState(DEFAULT_SETTINGS)
        return
      }
      try {
        applySettingsToState(await api.reset())
      } catch {
        applySettingsToState(DEFAULT_SETTINGS)
      }
    },

    settings: null,
    openSettings: (tab) => set({ settings: tab }),
    closeSettings: () => set({ settings: null })
  }
})
