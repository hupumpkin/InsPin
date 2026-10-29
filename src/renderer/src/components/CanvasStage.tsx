import { Application, Container } from 'pixi.js'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { Viewport, WebDropRequest } from '../../../shared/ipc'
import { LIBRARY_DRAG_MIME, parseLibraryDragPayload } from '../../../shared/local-library'
import {
  createDeleteNodesCommand,
  createFitTextNodeCommand,
  createMoveNodesCommand,
  createResizeNodeCommand,
  createResizeNodesCommand,
  createSetCanvasElementCommand,
  createSetAssetCropCommand,
  createRotateNodeCommand,
  normalizeAngle,
  type Box
} from '../../../shared/node-commands'
import { createAddNodeCommand } from '../../../shared/command'
import { cropFromResize, cropOf } from '../../../shared/crop'
import {
  createCanvasElementNode,
  TEXT_PADDING,
  type AssetCrop,
  type CanvasShapeKind
} from '../../../shared/node'
import { scaleGroupChanges } from '../../../shared/group-scale'
import type { Node } from '../../../shared/node'
import type { SceneItem } from '../../../shared/scene'
import { buildScene, contentBounds, cullScene } from '../../../shared/scene'
import { ancestorsOf, childToward, descendantsOf, outermostAncestorId } from '../../../shared/tree'
import {
  createGroupCommand,
  createMoveNodeCommand,
  createMoveNodesToParentCommand,
  createReorderNodesCommand,
  createSetNodeFlagsCommand,
  createUngroupCommand
} from '../../../shared/tree-commands'
import { isAutoLayoutContainer, flowChildIds } from '../../../shared/auto-layout'
import {
  acceleratorFromEvent,
  acceleratorFromMouseEvent,
  formatAccelerator,
  sameAccelerator
} from '../../../shared/shortcuts'
import {
  createRemoveAutoLayoutCommand,
  createSetAutoLayoutCommand,
  createWrapInAutoLayoutCommand
} from '../../../shared/auto-layout-commands'
import {
  boundsOfItems,
  boxesOfItems,
  hitTest,
  itemsInRect,
  onBoxEdge,
  rectFromPoints,
  rotationsOfItems,
  type Point,
  type Rect
} from '../canvas/hit-test'
import {
  buildSceneLayer,
  releaseUnusedTextures,
  type SceneLayer,
  type PreviewBox
} from '../canvas/scene-layer'
import { measureTextWidth, textLineHeight } from '../canvas/text-metrics'
import { setViewCenter } from '../canvas/view-center'
import {
  boxContains,
  expandBox,
  fitViewport,
  panDeltasFromWheel,
  panFromWheel,
  toScreen,
  toWorld,
  zoomAt,
  zoomByStep,
  zoomFromWheel,
  zoomPercent
} from '../canvas/viewport'
import {
  BRIDGE_STALE_MESSAGE,
  browserBridge,
  canvasBridge,
  ensureCanvasBridge,
  imageSearchBridge,
  settingsBridge
} from '../bridge'
import {
  IMAGE_SEARCH_LABELS,
  imageSearchConsentDisclosure,
  type ImageSearchCatalogItem,
  type ImageSearchEngineId
} from '../../../shared/image-search'
import { isEditableTarget } from '../dom'
import { activeTab, displayUrl } from '../../../shared/browser'
import { useBrowserStore } from '../state/browser'
import NodeBadges from './NodeBadges'
import { useGraphStore } from '../state/graph'
import { useCurrentProject } from '../state/projects'
import { useSelectionStore } from '../state/selection'
import { useUiStore } from '../state/ui'
import {
  cursorForHandle,
  handleAtPoint,
  isCorner,
  movingEdges,
  rotateAround,
  rotateZoneAtPoint,
  toLocalPoint,
  type HandleId
} from '../canvas/handles'
import { snapBoxes, snapResizeBox, type GuideLine } from '../canvas/snapping'
import { computeContainerDrop, findItem, parentIsContainer } from '../canvas/auto-layout-drop'
import { previewPositionFromWorld } from '../canvas/preview-position'
import { createFrameScheduler, type FrameScheduler } from '../canvas/render-scheduler'
import { canRunCutout, collectCutoutTargets } from '../cutout-targets'
import { alignBoxes, type AlignMode } from '../canvas/alignment'
import AutoLayoutToolbar from './AutoLayoutToolbar'
import CanvasControls from './CanvasControls'
import CropOverlay, { type CropResult } from './CropOverlay'
import CanvasElementPropertiesToolbar from './CanvasElementPropertiesToolbar'
import SelectionOverlay from './SelectionOverlay'
import SelectionToolbar from './SelectionToolbar'
import Toast from './Toast'

declare global {
  interface Window {
    /**
     * 画布实际提交的帧数。自检用它确认"静止后不再重绘"（D6b），
     * 性能排查时也是最直接的指标。
     */
    __insPinCanvasFrames?: number
  }
}

/**
 * 画布区（路线图 D2.1–D2.12）。
 *
 * 分工：
 *   - **模型是唯一事实来源**，渲染层每次整棵重铺，自己不存状态；
 *   - 平移缩放只改一层容器的 position/scale，**不动节点坐标**；
 *   - 拖动/缩放过程只做**预览**（临时改容器位置），**松手才提交一条命令**——
 *     这样一次拖动在历史里只占一步，⌘Z 一下就整个退回去。
 *
 * 拖动时用的位移是"世界坐标位移"，与节点的"相对父节点坐标"增量一致，所以父容器里的
 * 子节点也能用同一套逻辑（D4a 会用上）。
 */

const SAVE_DEBOUNCE_MS = 600
const MIN_SIZE = 4
/** 建层时在视口四周多留的比例（0.75 = 每边再扩 3/4 屏） */
const CULL_MARGIN = 0.75

/** 旋转光标：CSS 没有现成的"旋转"光标，用一个小箭头 SVG（顺时针弧线）当光标。
 *  Figma 在角外侧显示的也是这样一个旋转箭头。 */
const ROTATE_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 5a7 7 0 1 1-6.7 9" fill="none" stroke="#6d54eb" stroke-width="2" stroke-linecap="round"/><path d="M12 1.5 15.5 5 12 8.5z" fill="#6d54eb"/></svg>'
)}") 12 12, alias`

/** 指针捕获：合成事件（自检用）里没有真实指针，捕获会抛，忽略即可。 */
function capturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId)
  } catch {
    /* 没有真实指针，忽略 */
  }
}

function releasePointer(element: Element, pointerId: number): void {
  try {
    element.releasePointerCapture(pointerId)
  } catch {
    /* 同上 */
  }
}

/** 编组时要先生成一个组 id。 */
function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID
  return typeof uuid === 'function'
    ? uuid.call(globalThis.crypto)
    : `n-${Math.random().toString(36).slice(2)}`
}

/** Shift 绘制矩形 / 圆形时以较长轴为边长，保留起点所在的象限。 */
function shapeRectFromPoints(origin: Point, point: Point, shape: CanvasShapeKind, lockSquare: boolean): Rect {
  if (!lockSquare || (shape !== 'rectangle' && shape !== 'ellipse')) return rectFromPoints(origin, point)
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  const end = { x: origin.x + (dx < 0 ? -side : side), y: origin.y + (dy < 0 ? -side : side) }
  return rectFromPoints(origin, end)
}

/** 与属性条保持一致的字号范围；缩放时也夹在这个区间里。 */
const TEXT_MIN_FONT_SIZE = 10
const TEXT_MAX_FONT_SIZE = 160

/**
 * 文本对象的实际包围盒：逐行量字宽，行高用字体自己的行高。
 * 自动宽度文本不折行，宽度就取最长那一行——盒子因此始终紧贴文字。
 */
function textBoxSize(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split('\n')
  let width = 0
  for (const line of lines) {
    width = Math.max(width, measureTextWidth(line, fontSize))
  }
  return {
    w: Math.max(1, Math.ceil(width)),
    h: lines.length * textLineHeight(fontSize)
  }
}

/** 拖放进来的三种文本（解析顺序在 `shared/drop.ts`）。 */
type WebDropPayload = WebDropRequest['payload']

type DragState =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number }
  | { kind: 'marquee'; pointerId: number; origin: Point; additive: boolean; baseIds: string[] }
  | {
      kind: 'move'
      pointerId: number
      origin: Point
      start: { id: string; x: number; y: number; w: number; h: number }[]
      /** ⇧ 移动：以首次有效位移决定横向或纵向，并在本次拖拽中保持。 */
      axis: 'x' | 'y' | null
    }
  | {
      kind: 'resize'
      pointerId: number
      handle: HandleId
      origin: Point
      id: string
      /** ⌘ + 拖动手柄：改可见框，同时把变化映射成非破坏式裁切。 */
      crop: AssetCrop | null
      /**
       * 按下时这个节点的盒子——**画布绝对坐标**，和指针位置同一个坐标系。
       * 模型的 x/y 是相对父节点的，所以提交时要换算回去（见 `toLocalBox`）。
       */
      base: Rect
      /** 该节点当时的旋转角（缩放要在它的局部坐标系里算） */
      rotation: number
    }
  | {
      kind: 'rotate'
      pointerId: number
      id: string
      /** 旋转中心（世界坐标），也是框的中心 */
      center: Point
      /** 按下时指针相对中心的角度 */
      startAngle: number
      from: number
      /** 该节点当时的盒子（预览要用） */
      box: Box
    }
  | { kind: 'create-shape'; pointerId: number; origin: Point; shape: CanvasShapeKind }

interface InlineEditor {
  kind: 'text'
  origin: Point
  screen: Point
  value: string
  /** 有值 = 编辑既有文本；没有 = 创建新文本。 */
  nodeId?: string
  /** 编辑框按节点的真实字号/颜色显示，打开那一刻就所见即所得。 */
  fontSize: number
  color: string
}

export default function CanvasStage(): React.JSX.Element {
  const project = useCurrentProject()
  const graph = useGraphStore((state) => state.graph)
  const assets = useGraphStore((state) => state.assets)
  const savedViewport = useGraphStore((state) => state.viewport)
  const loadToken = useGraphStore((state) => state.loadToken)
  const status = useGraphStore((state) => state.status)
  const notice = useGraphStore((state) => state.notice)
  const captureFocus = useGraphStore((state) => state.captureFocus)
  const capture = useGraphStore((state) => state.capture)
  const setNotice = useGraphStore((state) => state.setNotice)
  const clearNotice = useGraphStore((state) => state.clearNotice)
  const importPaths = useGraphStore((state) => state.importPaths)
  const importWeb = useGraphStore((state) => state.importWeb)
  const importLibraryItems = useGraphStore((state) => state.importLibraryItems)
  const runCutout = useGraphStore((state) => state.cutout)
  const execute = useGraphStore((state) => state.execute)
  const copySelection = useGraphStore((state) => state.copy)
  const duplicateSelection = useGraphStore((state) => state.duplicate)
  const pasteSelection = useGraphStore((state) => state.paste)
  const setPasteTarget = useGraphStore((state) => state.setPasteTarget)
  const setPasteContainer = useGraphStore((state) => state.setPasteContainer)
  const undo = useGraphStore((state) => state.undo)
  const redo = useGraphStore((state) => state.redo)
  const tool = useUiStore((state) => state.tool)
  const setTool = useUiStore((state) => state.setTool)
  const panel = useUiStore((state) => state.panel)
  const panelResizing = useUiStore((state) => state.panelResizing)
  const canvasColor = useUiStore((state) => state.canvasColor)
  const folderPanelOpen = useUiStore((state) => state.folderPanelOpen)
  const smartCollectShortcut = useUiStore((state) => state.shortcuts.smartCollect)
  const browserShortcut = useUiStore((state) => state.shortcuts.toggleBrowser)
  /** 浏览器遮住的左侧宽度；画布不改坐标，只用它计算实际可见窗口的中心。 */
  const panelInset = panel.open && (panel.dock === 'left' || panel.dock === 'float') ? panel.width : 0
  /** 空画布提示只在实际可见的画布里居中；侧栏打开时让开它，别被盖住。 */
  const emptyInset: CSSProperties = folderPanelOpen
    ? { left: panel.openWidth }
    : panel.open
      ? panel.dock === 'right'
        ? { right: panel.width }
        : { left: panel.width }
      : {}

  const selectedIds = useSelectionStore((state) => state.ids)
  const pendingSelectionIds = useSelectionStore((state) => state.pendingIds)
  const select = useSelectionStore((state) => state.set)
  const clearSelection = useSelectionStore((state) => state.clear)
  /** 图层面板里悬停的那一行；悬停面板时画布对应对象也要高亮（D4a.2） */
  const panelHoverId = useSelectionStore((state) => state.hoverId)

  const hostRef = useRef<HTMLDivElement | null>(null)

  // 批量收下结果后，等指针回到画布再整批选中；指针本来就在画布上（网页拖入）时立刻选中。
  useEffect(() => {
    if (pendingSelectionIds.length === 0) return
    if (hostRef.current?.matches(':hover')) useSelectionStore.getState().takePending()
  }, [pendingSelectionIds])
  /** 最近一次真实指针位置；在画布之外时会自动回退到摄像机中心。 */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const panelInsetRef = useRef(panelInset)
  const appRef = useRef<Application | null>(null)
  const frameRef = useRef<FrameScheduler | null>(null)
  /** 渲染器像素密度：建 Pixi 时定下，同时用来判断"缩略图还够不够清晰" */
  const pixelRatioRef = useRef(Math.min(window.devicePixelRatio || 1, 2))
  const worldRef = useRef<Container | null>(null)
  const layerRef = useRef<SceneLayer | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const spaceRef = useRef(false)
  /**
   * "已进入的容器"（双击下潜的落点）。有值时单击选中的是它下面的那一层，
   * 点到它外面就清掉。见 `targetIdFor` / `onDoubleClick`。
   */
  const enteredRef = useRef<string | null>(null)
  const saveTimer = useRef<number | null>(null)
  /** 平移/滚轮：同一帧内只落一次视口，指针事件再密也不重渲染 N 次 */
  const panPendingRef = useRef({ dx: 0, dy: 0 })
  const panFrameRef = useRef<number | null>(null)
  const wheelPendingRef = useRef<{
    zoom: boolean
    dx: number
    dy: number
    deltaY: number
    anchor: { x: number; y: number }
  } | null>(null)
  const wheelFrameRef = useRef<number | null>(null)
  /** 粘贴落点判断要用最新的场景树和选中项，但不希望每次移动鼠标都重绑监听。 */
  const itemsRef = useRef<SceneItem[]>([])
  const selectedIdsRef = useRef<string[]>([])

  const [ready, setReady] = useState(false)
  const [bridgeReady, setBridgeReady] = useState(true)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const viewportRef = useRef<Viewport>(viewport)
  const [panning, setPanning] = useState(false)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [textured, setTextured] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverCursor, setHoverCursor] = useState('default')
  const [sizeBadge, setSizeBadge] = useState<{ bounds: Rect; text: string } | null>(null)
  const [guides, setGuides] = useState<GuideLine[]>([])
  /**
   * 正在拖动（移动/缩放/旋转）选中对象。拖动中把选中工具条收起来——它跟着对象浮在画布上，
   * 拖的时候压在鼠标底下既挡视线又容易被误点；松手再浮回来。
   * **只在指针真的动过之后才置位**（见 `onPointerMove`）：单击选一下也会走一次按下-抬起，
   * 那样工具条会闪一下。
   */
  const [nodeDragging, setNodeDragging] = useState(false)
  /** 只有"移动"时收起选中框；缩放/旋转仍要看得见框和控制点。 */
  const [movingSelection, setMovingSelection] = useState(false)
  /**
   * 拖动中每个被拖对象的**实时盒子**（画布绝对坐标）。给选中框用——
   * 模型要等松手才改，但蓝框得跟着手指走，不能停在原地。
   */
  const [dragBoxes, setDragBoxes] = useState<Map<string, Rect> | null>(null)
  /** 拖进自动布局容器时的插入线（世界坐标） */
  const [insertion, setInsertion] = useState<Rect | null>(null)
  /** 自动布局工具栏的实际宽度（要夹在视口内，见 autoLayoutTargetStyle） */
  const [toolbarWidth, setToolbarWidth] = useState(0)
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null)
  /** 对象工具条的宽度，用于与对象水平居中。单图与多选共用一条。 */
  const [selectionToolbarWidth, setSelectionToolbarWidth] = useState(0)
  const [selectionToolbarEl, setSelectionToolbarEl] = useState<HTMLDivElement | null>(null)
  const [searchEngines, setSearchEngines] = useState<ImageSearchCatalogItem[]>([])
  const searchEngineOptions = useMemo(
    () =>
      searchEngines.length > 0
        ? searchEngines.map((item) => ({ id: item.id, label: item.label }))
        : (['pinterest', 'huaban', 'google', 'zcool'] as ImageSearchEngineId[]).map((id) => ({
            id,
            label: IMAGE_SEARCH_LABELS[id]
          })),
    [searchEngines]
  )
  const [searchBusy, setSearchBusy] = useState<ImageSearchEngineId | null>(null)
  const [searchConsent, setSearchConsent] = useState<{
    engineId: ImageSearchEngineId
    assetFileName: string
    mode: 'auto' | 'paste'
    crop?: AssetCrop
  } | null>(null)

  useEffect(() => {
    const bridge = imageSearchBridge()
    if (!bridge) return
    let alive = true
    void bridge
      .catalog()
      .then((items) => {
        if (alive) setSearchEngines(items)
      })
      .catch(() => {
        // 目录读不到就先不显示；点「搜图」时会再报错
      })
    return () => {
      alive = false
    }
  }, [])

  // 搜索阶段由主进程推过来：界面随时能看见“在做什么”，而不是干等。
  useEffect(() => {
    const bridge = imageSearchBridge()
    if (!bridge || typeof bridge.onProgress !== 'function') return
    return bridge.onProgress(({ engineId, stage }) => {
      const label = IMAGE_SEARCH_LABELS[engineId]
      const message =
        stage === 'opening'
          ? `正在打开 ${label}…`
          : stage === 'resolving'
            ? '正在准备图片…'
            : stage === 'injecting'
              ? `正在把图片传到 ${label}…`
              : `已上传，正在等 ${label} 出结果…`
      setNotice(message, 'loading')
    })
  }, [setNotice])
  /** 属性条宽度随数值增长；测量值用于让工具条始终居中贴在对象外侧。 */
  const [elementPropsWidth, setElementPropsWidth] = useState(0)
  const [elementPropsEl, setElementPropsEl] = useState<HTMLDivElement | null>(null)
  /** macOS 14+ 且本机小工具齐全时才展示抠图入口。 */
  const [cutoutAvailable, setCutoutAvailable] = useState(false)
  const [cutoutBusy, setCutoutBusy] = useState(false)
  /** 裁切浮层是临时态：crop = 确认后写进画布；search = 只借它框一块去搜图。 */
  const [cropSession, setCropSession] = useState<{
    nodeId: string
    initial: AssetCrop
    purpose: 'crop' | 'search'
  } | null>(null)
  /** 可视化裁切浮层的实时结果；Enter 直接应用它，不必等“完成”按钮。 */
  const cropDraftRef = useRef<CropResult | null>(null)
  /** 文本在落库前用原生输入框收内容，提交后成为普通可移动对象。 */
  const [inlineEditor, setInlineEditor] = useState<InlineEditor | null>(null)
  /** 绘制过程的真实图形预览，避免只有蓝色框而看不到最终形状。 */
  const [shapeDraft, setShapeDraft] = useState<{ shape: CanvasShapeKind; rect: Rect } | null>(null)
  const inlineEditorRef = useRef<HTMLTextAreaElement | null>(null)
  /** 正在被原位编辑的文本节点；场景重建后要重新把它藏起来。 */
  const editingNodeIdRef = useRef<string | null>(null)
  /**
   * 上一次建层覆盖到的**世界范围**（比看得见的多留一圈）。
   *
   * 视口移出这个范围就得重建，否则新进画面的对象根本没被建出来——它们的纹理
   * 还等着加载，屏幕上却什么都没有。视口只在"建层那个 effect"里用来裁剪、
   * 不进依赖（平移缩放不该每次都整棵重铺），所以这个范围得自己记着。
   */
  const builtBoxRef = useRef<Rect | null>(null)
  /** 视口走出上面那个范围时 +1，用来逼建层 effect 重跑 */
  const [cullTick, setCullTick] = useState(0)

  useEffect(() => {
    if (!toolbarEl) return
    const measure = (): void => setToolbarWidth(toolbarEl.offsetWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(toolbarEl)
    return () => observer.disconnect()
  }, [toolbarEl])

  useEffect(() => {
    if (!selectionToolbarEl) return
    const measure = (): void => setSelectionToolbarWidth(selectionToolbarEl.offsetWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(selectionToolbarEl)
    return () => observer.disconnect()
  }, [selectionToolbarEl])

  useEffect(() => {
    if (!elementPropsEl) return
    const measure = (): void => setElementPropsWidth(elementPropsEl.offsetWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(elementPropsEl)
    return () => observer.disconnect()
  }, [elementPropsEl])

  /**
   * 原位编辑器只在"打开"那一刻聚焦，之后打字不能重置光标。
   *
   * 聚焦必须等这一轮输入事件的**默认动作**跑完：真实鼠标按下时，浏览器会在
   * pointerdown 派发结束后把焦点移到 body。若在这里同步 focus，紧接着就会被
   * 抢走并触发一次假 blur，空文本被当成取消、编辑框立刻消失——这正是"点文本
   * 工具后毫无反应"的成因。合成事件没有默认焦点流程，所以旧自检测不出来。
   */
  const inlineEditorOpen = inlineEditor !== null
  const inlineEditorNodeId = inlineEditor?.nodeId ?? null
  useEffect(() => {
    if (!inlineEditorOpen) return
    const frame = window.requestAnimationFrame(() => {
      const editor = inlineEditorRef.current
      if (!editor) return
      editor.focus({ preventScroll: true })
      editor.setSelectionRange(editor.value.length, editor.value.length)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [inlineEditorOpen, inlineEditorNodeId])

  // 裁切是单图临时态。用户改选、删掉对象或切换项目时立刻取消预览，
  // 不能让面板悄悄把上一张图改掉。
  useEffect(() => {
    if (!cropSession) return
    const node = graph?.nodes[cropSession.nodeId]
    if (node?.type === 'asset' && selectedIds.length === 1 && selectedIds[0] === cropSession.nodeId) return
    endCrop()
  }, [cropSession, graph, selectedIds])

  const canvas = canvasBridge()

  // 场景树（模型投影）。用 memo 保证同一份图不重复算，也让下面的 effect 依赖稳定
  const items = useMemo(() => (graph ? buildScene(graph) : []), [graph])
  itemsRef.current = items
  selectedIdsRef.current = selectedIds

  /**
   * 选中对象里能复制的图片（含组/容器内的）。
   * 按**节点**去重而不是按素材：同一张图在画布上摆了 40 次，就该复制出 40 个；
   * 这里只防"父组和它的子节点都被遍历到"造成的重复。
   */
  const copyItems = useMemo(() => {
    if (!graph) return []
    const items: { fileName: string; name: string }[] = []
    const seenNodes = new Set<string>()
    const visit = (id: string): void => {
      if (seenNodes.has(id)) return
      seenNodes.add(id)
      const node = graph.nodes[id]
      if (!node) return
      if (node.type === 'asset') {
        const info = assets[node.props.assetId]
        if (info) items.push({ fileName: info.fileName, name: node.name })
      }
      for (const childId of node.childIds) visit(childId)
    }
    for (const id of selectedIds) visit(id)
    return items
  }, [graph, assets, selectedIds])

  /** 首版只接受一张直接选中的兼容位图，结果默认排在原图右侧。 */
  const cutoutTargets = useMemo(
    () => collectCutoutTargets(graph, assets, selectedIds, items),
    [graph, assets, selectedIds, items]
  )
  const showCutout = canRunCutout(cutoutTargets, cutoutAvailable)

  const commitViewport = useCallback(
    (next: Viewport): void => {
      setViewport(next)
      const projectId = project?.id
      if (!projectId) return
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void canvasBridge()?.saveViewport(projectId, next)
      }, SAVE_DEBOUNCE_MS)
    },
    [project?.id]
  )

  useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

  /**
   * 平移/滚轮按帧合并：指针事件只累加，下一帧统一算一次新视口（D6b）。
   *
   * 不合并的话，120Hz 触控板滑一下就是几十次 `setViewport`，整个 CanvasStage
   * （外加所有 DOM 叠层）跟着重渲染几十次，而画面本来一帧只画一次——纯白烧 CPU。
   */
  const flushPan = useCallback((): void => {
    if (panFrameRef.current !== null) {
      window.cancelAnimationFrame(panFrameRef.current)
      panFrameRef.current = null
    }
    const { dx, dy } = panPendingRef.current
    if (dx === 0 && dy === 0) return
    panPendingRef.current = { dx: 0, dy: 0 }
    setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
  }, [])

  const queuePan = useCallback(
    (dx: number, dy: number): void => {
      panPendingRef.current.dx += dx
      panPendingRef.current.dy += dy
      if (panFrameRef.current !== null) return
      panFrameRef.current = window.requestAnimationFrame(() => {
        panFrameRef.current = null
        flushPan()
      })
    },
    [flushPan]
  )

  const flushWheel = useCallback((): void => {
    if (wheelFrameRef.current !== null) {
      window.cancelAnimationFrame(wheelFrameRef.current)
      wheelFrameRef.current = null
    }
    const pending = wheelPendingRef.current
    if (!pending) return
    wheelPendingRef.current = null
    if (pending.zoom) {
      setViewport((current) =>
        zoomAt(current, zoomFromWheel(current.zoom, pending.deltaY), pending.anchor)
      )
    } else {
      setViewport((current) => panFromWheel(current, pending.dx, pending.dy))
    }
  }, [])

  const queueWheel = useCallback(
    (event: WheelEvent, host: HTMLElement, multiplier: number): void => {
      const zoom = event.metaKey || event.ctrlKey
      const previous = wheelPendingRef.current
      // 同一帧里换了手势（极少见）：先把上一段落下去，别把缩放和平移混在一起
      if (previous && previous.zoom !== zoom) flushWheel()

      const rect = host.getBoundingClientRect()
      const pending = wheelPendingRef.current ?? {
        zoom,
        dx: 0,
        dy: 0,
        deltaY: 0,
        anchor: { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }
      pending.zoom = zoom
      pending.anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      if (zoom) {
        pending.deltaY += event.deltaY * multiplier
      } else {
        const delta = panDeltasFromWheel(
          event.deltaX * multiplier,
          event.deltaY * multiplier,
          event.shiftKey
        )
        pending.dx += delta.x
        pending.dy += delta.y
      }
      wheelPendingRef.current = pending

      if (wheelFrameRef.current !== null) return
      wheelFrameRef.current = window.requestAnimationFrame(() => {
        wheelFrameRef.current = null
        flushWheel()
      })
    },
    [flushWheel]
  )

  // 卸载时丢掉还没跑的那一帧，别在组件已经没了之后 setState
  useEffect(
    () => () => {
      if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current)
      if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current)
    },
    []
  )

  /**
   * 统一给所有粘贴通路提供落点。
   *
   * 指针位于真正可见的摄像机区域时按其世界坐标粘贴；浏览器面板、工具条等区域
   * 不属于可见画布时，改用当前摄像机的可见中心。用 ref 保存这一瞬时信息，鼠标移动
   * 不会触发画布树重渲染。
   */
  const refreshPasteTarget = useCallback((): void => {
    const host = hostRef.current
    if (!host) {
      setPasteTarget(null)
      setPasteContainer(null)
      return
    }
    const rect = host.getBoundingClientRect()
    const inset = Math.min(Math.max(0, panelInsetRef.current), host.clientWidth)
    const pointer = pointerRef.current
    const inVisibleViewport = pointer !== null &&
      pointer.x >= rect.left + inset && pointer.x <= rect.right &&
      pointer.y >= rect.top && pointer.y <= rect.bottom
    const screen = inVisibleViewport
      ? { x: pointer.x - rect.left, y: pointer.y - rect.top }
      : { x: inset + Math.max(1, host.clientWidth - inset) / 2, y: host.clientHeight / 2 }
    const world = toWorld(viewportRef.current, screen)
    setPasteTarget(world)

    const currentGraph = useGraphStore.getState().graph
    const drop = currentGraph
      ? computeContainerDrop(currentGraph, itemsRef.current, world)
      : null
    if (drop) {
      setPasteContainer({ containerId: drop.containerId, index: drop.index })
      return
    }
    // 没有指针命中时，如果只选中了一个自动布局容器，粘贴就落到它末尾。
    const only = selectedIdsRef.current.length === 1 ? currentGraph?.nodes[selectedIdsRef.current[0]!] : null
    setPasteContainer(
      only && isAutoLayoutContainer(only)
        ? { containerId: only.id, index: only.childIds.length }
        : null
    )
  }, [setPasteContainer, setPasteTarget])

  useEffect(() => {
    panelInsetRef.current = panelInset
    refreshPasteTarget()
  }, [panelInset, refreshPasteTarget])

  useEffect(() => {
    refreshPasteTarget()
  }, [viewport, refreshPasteTarget])

  useEffect(() => {
    refreshPasteTarget()
  }, [graph, selectedIds, refreshPasteTarget])

  useEffect(() => {
    const trackPointer = (event: PointerEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      refreshPasteTarget()
    }
    // 指针离开窗口 / 应用失焦后，粘贴不能再沿用最后停在窗口边缘的坐标。
    const clearPointer = (): void => {
      pointerRef.current = null
      refreshPasteTarget()
    }
    window.addEventListener('pointermove', trackPointer, { passive: true })
    window.addEventListener('blur', clearPointer)
    document.documentElement.addEventListener('pointerleave', clearPointer)
    refreshPasteTarget()
    return () => {
      window.removeEventListener('pointermove', trackPointer)
      window.removeEventListener('blur', clearPointer)
      document.documentElement.removeEventListener('pointerleave', clearPointer)
      setPasteTarget(null)
      setPasteContainer(null)
    }
  }, [refreshPasteTarget, setPasteContainer, setPasteTarget])

  /** 连续采集时，下一张图在右侧出现，镜头同步平移到它的中心。 */
  useEffect(() => {
    // 采集结束后 captureFocus 可能还没清掉；这时不能再跟着侧栏宽度动镜头。
    if (!captureFocus || !capture) return
    const host = hostRef.current
    if (!host) return
    const current = viewportRef.current
    const visible = Math.max(1, host.clientWidth - panelInset)
    const screenCenter = { x: panelInset + visible / 2, y: host.clientHeight / 2 }
    commitViewport({
      ...current,
      x: screenCenter.x - captureFocus.x * current.zoom,
      y: screenCenter.y - captureFocus.y * current.zoom
    })
  }, [captureFocus, capture, commitViewport, panelInset])

  // 视口中心随时记着：区域截图（D3.16）要把图正好放在用户眼前。
  // 放在 effect 里而不是 commitViewport 里，是因为**恢复视图**（开项目）也要更新它。
  //
  // **要按"看得见的画布"算，不是按窗口算**：浏览器盖住左边时，窗口中心其实压在
  // 面板底下，图会落在看不见的地方（用户 2026-10-15 手测发现：截完只看到提示语，
  // 图上哪去了不知道）。画布世界本身不缩窄，只有这个可见中心需要避让。
  useEffect(() => {
    const host = hostRef.current
    const w = host?.clientWidth ?? 0
    const h = host?.clientHeight ?? 0
    const visible = Math.max(1, w - panelInset)
    setViewCenter(toWorld(viewport, { x: panelInset + visible / 2, y: h / 2 }))
  }, [viewport, panelInset])

  const viewportSize = useCallback(
    (): { w: number; h: number } => ({
      w: hostRef.current?.clientWidth ?? 0,
      h: hostRef.current?.clientHeight ?? 0
    }),
    []
  )

  /** ⇧2：把单个或多个选中对象完整地放进用户真正看得见的画布区域。 */
  const focusSelection = useCallback((): void => {
    const host = hostRef.current
    const bounds = boundsOfItems(items, selectedIds)
    if (!host || !bounds) return

    const visibleSize = {
      w: Math.max(1, host.clientWidth - panelInset),
      h: host.clientHeight
    }
    const focused = fitViewport(bounds, visibleSize, 64)
    // 左侧浏览器展开时，可见画布的原点不在 x=0；把焦点从可见区坐标换回整张画布坐标。
    commitViewport({ ...focused, x: focused.x + panelInset })
  }, [items, selectedIds, panelInset, commitViewport])

  /**
   * 画布按需渲染：谁改了画面谁请求一帧（D6b）。
   *
   * 走 ref 转发，layer / 各种 effect 拿到的永远是当前应用实例的调度器；
   * 同一帧内的多次请求会合并，静止时一帧都不画。
   */
  const requestRender = useCallback((): void => {
    frameRef.current?.invalidate()
  }, [])

  // 建 Pixi 应用（只做一次）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const app = new Application()
    appRef.current = app

    void (async () => {
      await app.init({
        background: canvasColor,
        antialias: true,
        autoDensity: true,
        resolution: pixelRatioRef.current,
        // Pixi 默认把 render 挂在 ticker 上，静止画面也会按屏幕刷新率一直画。
        // 画布是常驻界面，那样会白白耗电；改成内容变了才请求一帧。
        autoStart: false
      })
      if (disposed) {
        app.destroy(true)
        return
      }
      // Pixi 8 不会自动把 canvas 挂到页面里，得自己塞进去
      host.appendChild(app.canvas)
      const world = new Container()
      app.stage.addChild(world)
      worldRef.current = world
      // 统计"实际提交的帧"：手动渲染算一次，ticker 每次跑也算一次。自检靠它确认
      // 静止后不再画；万一将来有人把 ticker 又打开，这个数字也会如实涨上去。
      const countFrame = (): void => {
        window.__insPinCanvasFrames = (window.__insPinCanvasFrames ?? 0) + 1
      }
      frameRef.current = createFrameScheduler(() => {
        app.render()
        countFrame()
      })
      app.ticker.add(countFrame)
      setReady(true)
      requestRender()
    })()

    return () => {
      disposed = true
      setReady(false)
      frameRef.current?.dispose()
      frameRef.current = null
      worldRef.current = null
      layerRef.current = null
      appRef.current = null
      app.destroy(true, { children: true })
    }
  }, [requestRender])

  // 画布色是 Pixi 渲染背景的一部分，不只换外层 CSS；已有对象和空画布都会立即更新。
  useEffect(() => {
    const app = appRef.current
    // Application 的 renderer 在异步 init 完成前尚不存在；开发模式的 Strict Mode
    // 会刻意跑一次那段窗口，不能在这里抢跑。
    if (ready && app) {
      app.renderer.background.color = canvasColor
      requestRender()
    }
  }, [canvasColor, ready, requestRender])

  // `.canvas-area` 的宽度会随浏览器的揭开/收起做 CSS 动画。不能交给 Pixi 的
  // `resizeTo`：它会在拖分栏线的每一帧重建 GPU backing store，右侧画布就会闪。
  // 这里受控地观察宿主尺寸：拖动中保持上一帧图像，松手后才一次性同步最终尺寸。
  useEffect(() => {
    if (!ready) return
    const host = hostRef.current
    const app = appRef.current
    if (!host || !app) return

    let frame = 0
    const resize = (): void => {
      if (panelResizing) return
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const width = host.clientWidth
        const height = host.clientHeight
        if (width > 0 && height > 0) {
          app.renderer.resize(width, height)
          // 改完 drawing buffer 必须重画一次，否则松手后画面会停在旧尺寸上。
          requestRender()
        }
      })
    }

    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [ready, panelResizing, requestRender])

  // 视图变化时只动世界容器
  useEffect(() => {
    const world = worldRef.current
    if (!world) return
    world.position.set(viewport.x, viewport.y)
    world.scale.set(viewport.zoom)
    requestRender()
  }, [viewport, ready, requestRender])

  // 后台时浏览器会暂停 requestAnimationFrame；回到前台补画一帧。静止的画面不会再有
  // 别的请求把它带回来，GPU 缓冲若被回收就会停在空白。
  useEffect(() => {
    const onVisibility = (): void => {
      if (!document.hidden) requestRender()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [requestRender])

  // 模型变了就整棵重铺；视口外的节点先裁掉（D2.10）
  useEffect(() => {
    const bridge = canvasBridge()
    const world = worldRef.current
    if (!ready || !bridge || !world) return

    setTextured(null)
    // 多留一圈：平移半屏以内不用重建，走出去了才由下面那个 effect 触发
    const built = expandBox(visibleWorldRect(viewport, viewportSize()), CULL_MARGIN)
    builtBoxRef.current = built
    const visible = cullScene(items, built)
    const layer = buildSceneLayer(visible, assets, bridge, {
      requestRender,
      // 建层时按当前缩放决定每张图要不要原图；之后放大会由 setZoom 补载
      zoom: viewport.zoom,
      pixelRatio: pixelRatioRef.current
    })
    world.addChild(layer.container)
    layerRef.current = layer
    requestRender()
    // 原位编辑中的文本在新层里也要藏起来（藏着它的编辑框还在）。
    layer.setEditing(editingNodeIdRef.current)

    // 这一层建好了：把上一批里已经用不到的纹理卸掉（D6b.3，平移看久了不至于越占越多）
    releaseUnusedTextures(layer.urls)

    let cancelled = false
    void layer.ready.then((stats) => {
      if (!cancelled) setTextured(stats.textured)
    })

    return () => {
      cancelled = true
      world.removeChild(layer.container)
      layer.destroy()
      if (layerRef.current === layer) layerRef.current = null
    }
    // viewport 只用来算裁剪，不进依赖：平移缩放不该重铺整个场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, items, assets, cullTick, requestRender])

  /**
   * 平移/缩放把视口带出了"已建范围"就重建一次。
   *
   * 代价是重建那一棵树，但只在真的走出去时才发生，不是每帧。
   */
  useEffect(() => {
    const built = builtBoxRef.current
    if (!built) return
    if (boxContains(built, visibleWorldRect(viewport, viewportSize()))) return
    setCullTick((tick) => tick + 1)
  }, [viewport])

  /**
   * 放大跨过"缩略图够不够清晰"的界线时补载原图（D6b）。
   *
   * 缩小时不做反向降级：已经解码的纹理再卸掉，来回缩放会反复读盘。
   * 等这一层被重建（平移出范围、内容变化）时，自然会按当时的缩放重新决定。
   */
  useEffect(() => {
    layerRef.current?.setZoom(viewport.zoom)
  }, [viewport.zoom, ready])

  /**
   * 读到新项目时按保存过的视图复位。
   *
   * **必须在渲染期对齐，不能放进 effect**：建层那个 effect 就在同一个 commit 里、
   * 且排在它前面，会拿**旧视口（还是原点）**去裁剪——内容被整片裁掉，画布于是空白，
   * 只剩占位和选择框；非得手动拖一下触发重建才显出来（用户 2026-10-15 报的正是这个）。
   * 渲染期改状态 React 会在提交前重来一遍，建层时拿到的就是复位后的视口。
   */
  const [syncedToken, setSyncedToken] = useState(loadToken)
  if (syncedToken !== loadToken) {
    setSyncedToken(loadToken)
    setViewport(savedViewport)
  }

  // 选中集里的节点可能已经被删/被撤销掉了，及时清干净
  useEffect(() => {
    if (!graph) return
    const alive = selectedIds.filter((id) => graph.nodes[id])
    if (alive.length !== selectedIds.length) select(alive)
    // 进去过的容器没了（删除 / 撤销 / 换项目），容器上下文一并作废
    if (enteredRef.current && !graph.nodes[enteredRef.current]) enteredRef.current = null
  }, [graph, selectedIds, select])

  // 换工具时光标要立刻跟上（不用等鼠标动一下）
  useEffect(() => {
    setHoverCursor(tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair')
  }, [tool])

  // 桥过期（开发时改了 preload）自动刷新一次界面
  useEffect(() => {
    setBridgeReady(ensureCanvasBridge())
  }, [])

  // macOS 版本与随包 Vision 工具均可用才露出入口；不可用不打扰非 Mac 用户。
  useEffect(() => {
    const api = window.insPin?.cutout
    if (!api) return
    let alive = true
    void api
      .capability()
      .then((capability) => {
        if (alive) setCutoutAvailable(capability.available)
      })
      .catch(() => {
        if (alive) setCutoutAvailable(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // Figma 式导航：双指滑动（或无修饰键滚轮）平移；捏合会在 Chromium 中带
  // ctrlKey，⌘/Ctrl + 鼠标滚轮也缩放。缩放始终以光标为锚点。
  useEffect(() => {
    if (!ready) return
    const host = hostRef.current
    if (!host) return

    const onWheel = (event: WheelEvent): void => {
      const canvas = appRef.current?.canvas
      if (event.target !== host && event.target !== canvas) return

      event.preventDefault()
      event.stopPropagation()
      const multiplier =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? host.clientHeight
            : 1

      // 高频滚轮/触控板：先累加，下一帧统一落一次视口（见 queueWheel）
      queueWheel(event, host, multiplier)
    }

    // Pixi 和画布内交互元素可能在冒泡阶段接住滚轮；捕获阶段接管真正的画布，
    // 以保证平移和以光标为中心的缩放稳定触发。
    host.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => host.removeEventListener('wheel', onWheel, true)
  }, [ready, queueWheel])

  // 滚轮改动也要落盘：单独攒一下
  useEffect(() => {
    const projectId = project?.id
    if (!projectId) return
    const timer = window.setTimeout(() => {
      void canvasBridge()?.saveViewport(projectId, viewport)
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [viewport, project?.id])

  // 按住空格 = 临时抓手
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isEditableTarget(event.target)) return
      event.preventDefault()
      spaceRef.current = true
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // 快捷键：V/H 切工具、Delete 删除、Esc 取消选中、⌘Z/⇧⌘Z 撤销重做。
  // 键盘与鼠标中键共用同一套动作，改键后两边同时生效。
  useEffect(() => {
    /** 设备无关：同一个组合串，无论来自键盘还是中键，都按同一套规则执行。 */
    const runShortcut = (accelerator: string | null, target: EventTarget | null): boolean => {
      if (!accelerator) return false
      const shortcuts = useUiStore.getState().shortcuts
      const match = (binding: string | null): boolean => sameAccelerator(accelerator, binding)

      if (match(shortcuts.undo)) {
        undo()
        return true
      }
      if (match(shortcuts.redo)) {
        redo()
        return true
      }
      if (match(shortcuts.duplicate)) {
        if (selectedIds.length === 0) return false
        const duplicated = duplicateSelection(selectedIds)
        if (duplicated) select(duplicated.ids)
        return true
      }
      if (match(shortcuts.toggleLayerVisibility)) {
        if (!graph || selectedIds.length === 0) return false
        const shouldShow = selectedIds.some((id) => graph.nodes[id]?.visible === false)
        for (const id of selectedIds) {
          if (graph.nodes[id]) execute(createSetNodeFlagsCommand(id, { visible: shouldShow }))
        }
        return true
      }
      if (match(shortcuts.toggleLayerLock)) {
        if (!graph || selectedIds.length === 0) return false
        const shouldUnlock = selectedIds.some((id) => graph.nodes[id]?.locked === true)
        for (const id of selectedIds) {
          if (graph.nodes[id]) execute(createSetNodeFlagsCommand(id, { locked: !shouldUnlock }))
        }
        return true
      }
      // 编组 / 解组（D4a.5）
      if (match(shortcuts.group)) {
        groupSelection()
        return true
      }
      if (match(shortcuts.ungroup)) {
        ungroupSelection()
        return true
      }
      // 调整图层顺序：与 Figma 的四种层级快捷键一致。
      {
        const front = match(shortcuts.layerFront)
        const back = match(shortcuts.layerBack)
        const forward = match(shortcuts.layerForward)
        const backward = match(shortcuts.layerBackward)
        if (front || back || forward || backward) {
          if (selectedIds.length === 0) return false
          const mode = front
            ? 'front'
            : back
              ? 'back'
              : forward
                ? 'forward'
                : 'backward'
          execute(createReorderNodesCommand(selectedIds, mode))
          return true
        }
      }
      // ⇧A：给选中的对象套上自动布局（Figma 同款，D4b.5）
      if (match(shortcuts.autoLayout)) {
        if (!graph || selectedIds.length === 0) return false
        wrapInAutoLayout()
        return true
      }
      if (match(shortcuts.removeAutoLayout)) {
        if (!graph || selectedIds.length === 0) return false
        removeAutoLayoutSelection()
        return true
      }
      // 复制到其他软件：和内部复制节点分开，互不干扰
      if (match(shortcuts.copyToApps)) {
        if (selectedIds.length === 0) return false
        void copyToApps()
        return true
      }
      // 复制 / 粘贴画布对象（D4a.7）：复制还会同步选中的图片到系统剪贴板。
      if (match(shortcuts.copy)) {
        if (selectedIds.length === 0) return false
        void copySelectedWithSystem()
        return true
      }
      if (match(shortcuts.cut)) {
        if (!graph || selectedIds.length === 0) return false
        copySelection(selectedIds)
        if (copyItems.length > 0) void copyToApps({ silent: true })
        setNotice(`已剪切 ${selectedIds.length} 个对象`, 'success')
        execute(createDeleteNodesCommand(graph, selectedIds))
        enteredRef.current = null
        clearSelection()
        return true
      }
      if (match(shortcuts.paste)) {
        // 按当下鼠标位置重新算一次；鼠标不在可见画布内时会回到摄像机中心。
        refreshPasteTarget()
        const pasted = pasteSelection()
        if (!pasted || pasted.length === 0) return false
        select(pasted)
        return true
      }
      if (match(shortcuts.delete)) {
        // 焦点在图层面板 / 素材侧栏里时交给它们自己处理，避免删两次
        if (target instanceof Element && target.closest('.layers, .folder-panel')) return false
        if (!graph || selectedIds.length === 0) return false
        execute(createDeleteNodesCommand(graph, selectedIds))
        enteredRef.current = null
        clearSelection()
        return true
      }
      if (match(shortcuts.toolSelect)) {
        setTool('select')
        return true
      }
      if (match(shortcuts.toolHand)) {
        setTool('hand')
        return true
      }
      return false
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      // 设置面板是模态的：按键不应该顺手删除或移动后面的画布对象
      if (useUiStore.getState().settings) return

      // 搜索中按 Esc 先叫停搜索，不要顺手清空选中
      if (searchBusy && event.key === 'Escape') {
        event.preventDefault()
        setNotice('正在取消…', 'loading')
        void imageSearchBridge()?.cancel().catch(() => {})
        return
      }

      // 裁切也是模态的：只认 Enter（完成）和 Esc（取消），别让 Delete 之类的快捷键
      // 在裁切途中把图删掉。
      if (cropSession) {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelCrop()
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          // 局部搜索还要选站点，Enter 不替用户做决定
          if (cropSession.purpose === 'crop' && cropDraftRef.current) applyCrop(cropDraftRef.current)
          return
        }
        return
      }

      const mod = event.metaKey || event.ctrlKey
      // Figma 同款：⇧2 聚焦当前选择；多选时按整体包围盒处理。
      if (event.shiftKey && !mod && !event.altKey && event.code === 'Digit2') {
        if (selectedIds.length === 0) return
        event.preventDefault()
        focusSelection()
        return
      }
      if (runShortcut(acceleratorFromEvent(event), event.target)) {
        event.preventDefault()
        return
      }
      // Figma 同款：选中文本后按 Enter，或双击，进入原位编辑。
      if (event.key === 'Enter' && selectedIds.length === 1) {
        const node = graph?.nodes[selectedIds[0] ?? '']
        const item = node ? findItem(items, node.id) : null
        if (node?.type === 'frame' && node.props.element?.kind === 'text' && item) {
          event.preventDefault()
          openInlineEditor(
            'text',
            toScreen(viewport, { x: item.absX, y: item.absY }),
            { x: item.absX, y: item.absY },
            node.id,
            node.props.element.text
          )
          return
        }
      }
      if (event.key === 'Escape') {
        enteredRef.current = null
        clearSelection()
      }
    }

    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 1) return
      if (isEditableTarget(event.target)) return
      if (useUiStore.getState().settings) return
      if (runShortcut(acceleratorFromMouseEvent(event), event.target)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [
    graph,
    selectedIds,
    copyItems,
    execute,
    undo,
    redo,
    clearSelection,
    setTool,
    copySelection,
    pasteSelection,
    select,
    focusSelection,
    cropSession,
    searchBusy,
    items,
    viewport,
    setNotice,
    refreshPasteTarget
  ])

  /** 把选中的对象打成一个组，并选中新组（D4a.5）。 */
  function groupSelection(): void {
    if (!graph || selectedIds.length === 0) return
    const groupId = randomId()
    execute(createGroupCommand({ groupId, nodeIds: selectedIds }))
    select([groupId])
  }

  /** ⇧A 与选中工具栏的"自动布局"：给选中的对象套上自动布局容器（D4b.5）。 */
  function wrapInAutoLayout(): void {
    if (!graph || selectedIds.length === 0) return
    const frameId = randomId()
    execute(createWrapInAutoLayoutCommand(graph, selectedIds, { frameId, name: '自动整理' }))
    select([frameId])
  }

  function removeAutoLayoutSelection(): void {
    if (!graph) return
    const freed: string[] = []
    for (const id of selectedIds) {
      const node = graph.nodes[id]
      if (!node || !isAutoLayoutContainer(node)) continue
      freed.push(...node.childIds)
      execute(createRemoveAutoLayoutCommand(id))
    }
    if (freed.length > 0) select(freed)
  }

  /**
   * 把选中的对象做成一条参考快照（D5.5）：浮窗归主进程管，这里只负责发起，
   * 顺手把用户能看到的那句提示接住（没选东西 / 对象已经不在了）。
   */
  async function createSnapshot(): Promise<void> {
    if (!project) {
      setNotice('请先新建项目，再创建快照', 'error')
      return
    }
    if (selectedIds.length === 0) {
      setNotice('请先选择要创建快照的内容', 'info')
      return
    }
    const api = window.insPin?.snapshots
    if (!api) {
      setNotice(BRIDGE_STALE_MESSAGE, 'error')
      return
    }
    const result = await api.create(project.id, selectedIds)
    if (!result.ok) setNotice(result.message, 'error')
  }

  /**
   * 「复制」（⇧⌘C）：把选中的图片放到系统剪贴板，切到 Figma / Eagle 等软件按 ⌘V。
   * 批量走"文件地址列表"，所以几十上百张也很轻；详见 `main/copy-images.ts`。
   */
  async function copyToApps(options: { silent?: boolean } = {}): Promise<void> {
    if (copyItems.length === 0) {
      if (!options.silent) setNotice('选中内容不包含图片，无法复制', 'error')
      return
    }
    const api = canvasBridge()
    if (!api || typeof api.copyImages !== 'function') {
      if (!options.silent) setNotice(BRIDGE_STALE_MESSAGE, 'error')
      return
    }
    const result = await api.copyImages(copyItems, {
      convertToPng: useUiStore.getState().copyConvertToPng
    })
    if (!result.ok) {
      setNotice(result.message, 'error')
      return
    }
    if (options.silent) return
    const converted = result.converted > 0 ? `（${result.converted} 张已转 PNG）` : ''
    setNotice(`已复制 ${result.count} 张图片${converted}`, 'success')
  }

  /** ⌘C / 工具条复制：内部粘贴与系统剪贴板始终同步；图片优先写为原图。 */
  async function copySelectedWithSystem(): Promise<void> {
    if (selectedIds.length === 0) return
    copySelection(selectedIds)
    if (copyItems.length > 0) {
      await copyToApps()
      return
    }
    try {
      // 系统剪贴板没有可跨应用识别的“画布节点”格式；保留带版本号的 InsPin
      // 描述，让复制操作在系统层面可感知，而 ⌘V 仍由应用内节点剪贴板精确还原。
      await navigator.clipboard.writeText(JSON.stringify({ app: 'InsPin', version: 1, nodeIds: selectedIds }))
      setNotice(`已复制 ${selectedIds.length} 个对象`, 'success')
    } catch {
      setNotice('对象已复制到 InsPin；系统剪贴板暂不可写入', 'error')
    }
  }

  /** 在 Finder 中定位当前这张素材；只传内容哈希文件名，不把本机路径暴露给渲染层。 */
  async function revealSelectedAsset(): Promise<void> {
    const node = graph?.nodes[selectedIds[0] ?? '']
    if (!node || node.type !== 'asset') return
    const asset = assets[node.props.assetId]
    const api = canvasBridge()
    if (!asset || !api || typeof api.revealAsset !== 'function') {
      setNotice(asset ? BRIDGE_STALE_MESSAGE : '找不到这张图片的本地文件', 'error')
      return
    }
    const revealed = await api.revealAsset(asset.fileName)
    if (!revealed) setNotice('这张图片的本地文件已不存在', 'error')
  }

  /** 打开素材采集时记录的网页来源；没有可用来源时给出明确反馈。 */
  function openSelectedSource(): void {
    const node = graph?.nodes[selectedIds[0] ?? '']
    if (!node || node.type !== 'asset') return
    const asset = assets[node.props.assetId]
    const sourcePage = asset?.pageUrl ?? asset?.sourceUrl
    if (!sourcePage) {
      setNotice('这张图片没有可打开的来源页', 'error')
      return
    }
    if (!useUiStore.getState().panel.requested) useUiStore.getState().toggleBrowser()
    void browserBridge()?.newTab(sourcePage)
  }

  /** 点「搜图」里的站点：先确认一次隐私说明，再交给主进程。 */
  async function pickImageSearch(
    engineId: ImageSearchEngineId,
    mode: 'auto' | 'paste' = 'auto',
    crop?: AssetCrop
  ): Promise<void> {
    const bridge = imageSearchBridge()
    if (!bridge) {
      setNotice(BRIDGE_STALE_MESSAGE, 'error')
      return
    }
    const node = graph?.nodes[selectedIds[0] ?? '']
    if (!node || node.type !== 'asset') return
    const asset = assets[node.props.assetId]
    if (!asset || asset.missing) {
      setNotice('找不到这张图片的本地文件', 'error')
      return
    }
    const settingsApi = settingsBridge()
    const settings = settingsApi ? await settingsApi.get().catch(() => null) : null
    if (settings && !settings.imageSearchConsent) {
      setSearchConsent({ engineId, assetFileName: asset.fileName, mode, ...(crop ? { crop } : {}) })
      return
    }
    await runImageSearch(engineId, asset.fileName, mode, crop)
  }

  async function runImageSearch(
    engineId: ImageSearchEngineId,
    assetFileName: string,
    mode: 'auto' | 'paste' = 'auto',
    crop?: AssetCrop
  ): Promise<void> {
    const bridge = imageSearchBridge()
    if (!bridge) {
      setNotice(BRIDGE_STALE_MESSAGE, 'error')
      return
    }
    if (!project?.id) {
      setNotice('先打开一个画布再搜图', 'error')
      return
    }
    setSearchBusy(engineId)
    setNotice(`正在用 ${IMAGE_SEARCH_LABELS[engineId]} 搜索…`, 'info')
    try {
      const result = await bridge.start({
        engineId,
        assetFileName,
        projectId: project.id,
        mode,
        ...(crop ? { crop } : {})
      })
      if (!result.ok) {
        setNotice(result.message, result.reason === 'cancelled' ? 'info' : 'error')
        return
      }
      setNotice(
        result.mode === 'paste'
          ? '图片已复制，请在侧栏按 ⌘V 粘贴搜索'
          : '结果已在侧栏打开，喜欢的图可以直接拖回画布',
        'success'
      )
    } catch {
      setNotice('搜索失败了，可以在侧栏手动完成', 'error')
    } finally {
      setSearchBusy(null)
    }
  }

  /** 搜索中随时可停：主进程每个等待循环都会看这个标记，最多 120ms 就退出。 */
  function cancelImageSearch(): void {
    setNotice('正在取消…', 'loading')
    void imageSearchBridge()?.cancel().catch(() => {
      // 搜索已经结束时取消是空操作
    })
  }

  async function acceptSearchConsent(): Promise<void> {
    const pending = searchConsent
    if (!pending) return
    setSearchConsent(null)
    try {
      await imageSearchBridge()?.acceptConsent()
    } catch {
      // 写盘失败时主进程仍会拦住，下一次会再问
    }
    await runImageSearch(pending.engineId, pending.assetFileName, pending.mode, pending.crop)
  }

  /**
   * 进入可视化裁切：先保存初始裁切区域，取消 / Esc 始终回到它。
   * 画布里的那张图先藏起来，浮层用原图自己画，避免两层图叠出重影。
   */
  function startCrop(): void {
    const node = graph?.nodes[selectedIds[0] ?? '']
    if (!node || node.type !== 'asset') return
    const item = findItem(items, node.id)
    const asset = assets[node.props.assetId]
    if (!item || !asset || asset.missing || !canvas) {
      setNotice('找不到这张图片的本地文件', 'error')
      return
    }
    const initial = cropOf(node.props.crop)
    cropDraftRef.current = {
      box: { x: item.absX, y: item.absY, w: item.w, h: item.h },
      crop: initial
    }
    editingNodeIdRef.current = node.id
    layerRef.current?.setEditing(node.id)
    setCropSession({ nodeId: node.id, initial, purpose: 'crop' })
  }

  /** 借同一块裁切浮层框选局部：只用来搜图，不动画布上的裁切区域。 */
  function startCropSearch(): void {
    const node = graph?.nodes[selectedIds[0] ?? '']
    if (!node || node.type !== 'asset') return
    const item = findItem(items, node.id)
    const asset = assets[node.props.assetId]
    if (!item || !asset || asset.missing || !canvas) {
      setNotice('找不到这张图片的本地文件', 'error')
      return
    }
    const initial = cropOf(node.props.crop)
    cropDraftRef.current = {
      box: { x: item.absX, y: item.absY, w: item.w, h: item.h },
      crop: initial
    }
    editingNodeIdRef.current = node.id
    layerRef.current?.setEditing(node.id)
    setCropSession({ nodeId: node.id, initial, purpose: 'search' })
  }

  /** 浮层里选好站点：用框出来的区域去搜，原图的裁切保持不动。 */
  function searchCrop(result: CropResult, engineId: ImageSearchEngineId): void {
    const node = cropSession ? graph?.nodes[cropSession.nodeId] : undefined
    const asset = node?.type === 'asset' ? assets[node.props.assetId] : undefined
    endCrop()
    if (!asset) return
    void pickImageSearch(engineId, 'auto', result.crop)
  }

  function endCrop(): void {
    cropDraftRef.current = null
    editingNodeIdRef.current = null
    layerRef.current?.setEditing(null)
    setCropSession(null)
  }

  function cancelCrop(): void {
    endCrop()
  }

  /** 浮层给的裁切框同时写回盒子和裁切区域：框多大，结果就多大，图不会被拉变形。 */
  function applyCrop(result: CropResult): void {
    const session = cropSession
    if (!session || !graph) return
    const node = graph.nodes[session.nodeId]
    if (!node || node.type !== 'asset') {
      endCrop()
      return
    }
    const box = toLocalBox(result.box, node.id)
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6
    const unchanged =
      near(box.x, node.x) &&
      near(box.y, node.y) &&
      near(box.w, node.w) &&
      near(box.h, node.h) &&
      near(result.crop.x, session.initial.x) &&
      near(result.crop.y, session.initial.y) &&
      near(result.crop.w, session.initial.w) &&
      near(result.crop.h, session.initial.h)
    endCrop()
    if (unchanged) return
    execute(
      createSetAssetCropCommand(
        node.id,
        { box: { x: node.x, y: node.y, w: node.w, h: node.h }, crop: session.initial },
        { box, crop: result.crop }
      )
    )
  }

  /** 多选对齐 / 等距分布，以共同包围盒为准；每个节点仍按各自父级坐标落库。 */
  function alignSelection(mode: AlignMode): void {
    if (!graph || selectedIds.length < 2) return
    const boxes = boxesOfItems(items, selectedIds)
    const targets = alignBoxes(boxes, mode)
    const moves = targets.flatMap(({ id, x, y }) => {
      const node = graph.nodes[id]
      const box = boxes.get(id)
      if (!node || !box) return []
      const local = toLocalBox({ x, y, w: box.w, h: box.h }, id)
      if (local.x === node.x && local.y === node.y) return []
      return [{ id, from: { x: node.x, y: node.y }, to: { x: local.x, y: local.y } }]
    })
    if (moves.length > 0) execute(createMoveNodesCommand(moves))
  }

  /** 交给主进程执行 Apple Vision，成功后直接选中右侧新生成的透明 PNG。 */
  async function cutoutSelection(): Promise<void> {
    if (cutoutBusy || !project || !canRunCutout(cutoutTargets, cutoutAvailable)) return
    setCutoutBusy(true)
    try {
      const result = await runCutout(project.id, cutoutTargets)
      if (result.ok && result.importedNode) select([result.importedNode.id])
    } finally {
      setCutoutBusy(false)
    }
  }

  /**
   * ⇧⌘G。选中的是**自动布局容器**时等于"解除自动布局"（Figma 同款），
   * 否则把组/框架解散、选中被放出来的子节点（D4a.5）。
   */
  function ungroupSelection(): void {
    if (!graph) return
    const freed: string[] = []
    for (const id of selectedIds) {
      const node = graph.nodes[id]
      if (!node) continue
      if (isAutoLayoutContainer(node)) {
        // 解除会自动把套出来的框一起解散，选中跟着落到被放出来的那些对象上
        freed.push(...node.childIds)
        execute(createRemoveAutoLayoutCommand(id))
        continue
      }
      if (node.type === 'group' || node.type === 'frame') {
        freed.push(...node.childIds)
        execute(createUngroupCommand(id))
      }
    }
    if (freed.length > 0) select(freed)
  }

  function addShape(shape: CanvasShapeKind, origin: Point, dragged: Rect): void {
    if (!project) return
    const tiny = dragged.w < MIN_SIZE || dragged.h < MIN_SIZE
    const w = shape === 'line' ? Math.max(80, dragged.w) : tiny ? 160 : Math.max(MIN_SIZE, dragged.w)
    const h = shape === 'line' ? 4 : tiny ? 104 : Math.max(MIN_SIZE, dragged.h)
    const node = createCanvasElementNode({
      id: randomId(),
      projectId: project.id,
      parentId: null,
      name: shape === 'rectangle' ? '矩形' : shape === 'ellipse' ? '圆形' : '线条',
      x: tiny ? origin.x : dragged.x,
      y: tiny ? origin.y : dragged.y,
      w,
      h,
      element: { kind: 'shape', shape, fill: '#D9D9D9', cornerRadius: 0 }
    })
    execute(createAddNodeCommand(node))
    select([node.id])
    setTool('select')
  }

  function openInlineEditor(
    kind: InlineEditor['kind'],
    screen: Point,
    origin: Point,
    nodeId?: string,
    value = '',
    fontSize = 24,
    color = '#2F3440'
  ): void {
    // 编辑既有文本时先把它在画布上藏起来：编辑框负责显示，避免两层文字叠加重影。
    editingNodeIdRef.current = nodeId ?? null
    layerRef.current?.setEditing(nodeId ?? null)
    setInlineEditor({ kind, screen, origin, nodeId, value, fontSize, color })
  }

  /**
   * 文本工具落点只开编辑框，提交时才正式建层。
   * 编辑期间由 textarea 本体做实时预览；提交后节点才是普通可移动、可缩放的文本对象，
   * 也只用一条历史命令，撤销不会留下一个空文本层。
   */
  function startTextAt(screen: Point, origin: Point): void {
    if (!project) return
    openInlineEditor('text', screen, origin)
  }

  function closeInlineEditor(): void {
    editingNodeIdRef.current = null
    layerRef.current?.setEditing(null)
    setInlineEditor(null)
  }

  function commitInlineEditor(): void {
    if (!inlineEditor) return
    const editor = inlineEditor
    const text = editor.value.trim()
    closeInlineEditor()
    setTool('select')

    if (editor.nodeId) {
      const node = graph?.nodes[editor.nodeId]
      if (!graph || node?.type !== 'frame' || node.props.element?.kind !== 'text') return
      if (!text) {
        // 清空既有文本：不留不可见的空图层（与新建时直接离开的行为一致）。
        execute(createDeleteNodesCommand(graph, [node.id]))
        select([])
        return
      }
      // 自动宽度文本：落定后盒子也跟着内容收缩/伸展，选中框才不会忽大忽小。
      const size = textBoxSize(text, node.props.element.fontSize)
      const box = {
        x: node.x,
        y: node.y,
        w: size.w + TEXT_PADDING * 2,
        h: size.h + TEXT_PADDING * 2
      }
      if (text !== node.props.element.text || box.w !== node.w || box.h !== node.h) {
        execute(
          createFitTextNodeCommand(
            node.id,
            { element: node.props.element, box: { x: node.x, y: node.y, w: node.w, h: node.h } },
            { element: { ...node.props.element, text }, box }
          )
        )
      }
      select([node.id])
      return
    }

    if (!text || !project) return
    const size = textBoxSize(text, editor.fontSize)
    const node = createCanvasElementNode({
      id: randomId(),
      projectId: project.id,
      parentId: null,
      name: '文本',
      // 盒子比字形大一圈留白；留白同时决定选中框和命中区，编辑框用同一圈。
      // 落点取整：文字纹理落在整像素上才不会被线性过滤糊一层。
      x: Math.round(editor.origin.x - TEXT_PADDING),
      y: Math.round(editor.origin.y - TEXT_PADDING),
      w: size.w + TEXT_PADDING * 2,
      h: size.h + TEXT_PADDING * 2,
      element: { kind: 'text', text, color: editor.color, fontSize: editor.fontSize }
    })
    execute(createAddNodeCommand(node))
    select([node.id])
  }

  // ---------- 指针交互 ----------

  /**
   * 点中容器里的对象时，实际要选中**最外层那个组**（Figma 的行为）——
   * 这样"拖动父组、子项跟随"才有抓手。
   *
   * 双击下潜后（`enteredRef` 有值）就改选**该容器下的那一层**，直到点/双击到容器外面才退出。
   */
  function targetIdFor(hitId: string): string {
    if (!graph) return hitId
    const entered = enteredRef.current
    if (entered) {
      const inside = childToward(graph, entered, hitId)
      if (inside) return inside
    }
    return outermostAncestorId(graph, hitId) ?? hitId
  }

  /**
   * 指针落在"已进入的容器"外面时退出容器上下文（Figma 如此）。
   * **只在点击时调用**，不能挂在悬停上——否则鼠标一扫过容器边缘就退出了。
   */
  function exitIfOutside(hitId: string | null): void {
    const entered = enteredRef.current
    if (!entered || !graph) return
    if (hitId === entered) return
    if (hitId && childToward(graph, entered, hitId)) return
    enteredRef.current = null
  }

  /**
   * 点击命中 → 该选中谁，顺带维护"已进入的容器"上下文。
   *
   * 三条路：
   *   - 戳中容器**自己的空白处**：选中这个容器，上下文退回上一层（等于"退出来"）；
   *   - 戳中容器里的东西：按上下文选它那一层（见 `targetIdFor`）；
   *   - 戳到外面/空白：退出上下文，照常选最外层。
   *
   * 悬停走的是只读的 `targetIdFor`——鼠标扫过容器边缘不该把上下文弄丢。
   */
  function resolveClick(rawHit: string | null): string | null {
    if (!rawHit) {
      enteredRef.current = null
      return null
    }
    const entered = enteredRef.current
    if (entered && rawHit === entered) {
      enteredRef.current = null
      return entered
    }
    exitIfOutside(rawHit)
    return targetIdFor(rawHit)
  }

  /**
   * 能不能拖着改尺寸。
   *
   * **组**可以，但走的是"等比缩放整棵子树"（Figma 的规矩，见 `shared/group-scale.ts`）——
   * 组的边框就是内容的并集（`shared/scene.ts`），本来就没有可单独设的宽高。
   * **转过角度的组**先不给：那时"边"在屏幕上不横平竖直，要在局部坐标轴里算缩放，还没做
   * （和参考线吸附是同一条界线）。
   */
  function canResize(node: Node | undefined): boolean {
    if (!node) return false
    return node.type !== 'group' || node.rotation === 0
  }

  /** 文本是自动宽度对象，只能拖四角等比缩放；拖边拉伸对它没有意义。 */
  function resizeHandleAt(node: Node | undefined, bounds: Rect, point: Point): HandleId | null {
    if (!canResize(node)) return null
    const handle = handleAtPoint(bounds, viewport, point)
    if (handle && node?.type === 'frame' && node.props.element?.kind === 'text' && !isCorner(handle)) {
      return null
    }
    return handle
  }

  /** 画布绝对坐标的盒子 → 模型坐标（相对父节点）。 */
  function toLocalBox(box: Box, id: string): Box {
    const position = previewPositionFromWorld(items, id, box)
    return { ...position, w: box.w, h: box.h }
  }

  /** 双击：往下潜一层（进容器）。Figma 每双击一次进一层。 */
  function onDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (tool !== 'select' || !graph) return
    const world = toWorld(viewport, localPoint(event))
    const rawHit = hitTest(items, world)
    if (!rawHit) return

    const textNode = graph.nodes[rawHit]
    const textItem = findItem(items, rawHit)
    if (textNode?.type === 'frame' && textNode.props.element?.kind === 'text' && textItem) {
      const origin = { x: textItem.absX + TEXT_PADDING, y: textItem.absY + TEXT_PADDING }
      openInlineEditor(
        'text',
        toScreen(viewport, origin),
        origin,
        textNode.id,
        textNode.props.element.text,
        textNode.props.element.fontSize,
        textNode.props.element.color
      )
      return
    }

    exitIfOutside(rawHit)
    const level = targetIdFor(rawHit)
    const deeper = childToward(graph, level, rawHit)
    if (!deeper) return

    enteredRef.current = level
    // 双击前的 hover 仍是外层组；不清掉就会与刚选中的子图同时画两只蓝框。
    setHoverId(null)
    select([deeper])
  }

  /** 指针/鼠标事件 → 画布内的屏幕坐标（只用到这几个字段，所以不必限定具体事件类型）。 */
  function localPoint(event: {
    clientX: number
    clientY: number
    currentTarget: HTMLDivElement
  }): Point {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    const host = hostRef.current
    if (!host) return

    // 编辑中点画布：这一次点击只负责提交。否则文本工具仍是激活态，会在这里
    // 再开一个空编辑框，把刚输入的内容覆盖掉。
    if (inlineEditor) {
      commitInlineEditor()
      return
    }

    const screen = localPoint(event)
    const world = toWorld(viewport, screen)
    // 同一帧里刚点完工具条又点画布时，React 订阅还可能拿着上一帧的闭包。
    // 这里读取 Zustand 的即时值，确保这一次点击按用户刚选的工具执行。
    const activeTool = useUiStore.getState().tool

    if (activeTool === 'hand' || spaceRef.current) {
      dragRef.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY
      }
      setPanning(true)
      capturePointer(host, event.pointerId)
      return
    }
    if (activeTool.startsWith('shape-')) {
      const shape = activeTool.slice('shape-'.length) as CanvasShapeKind
      dragRef.current = { kind: 'create-shape', pointerId: event.pointerId, origin: world, shape }
      setShapeDraft({ shape, rect: { x: world.x, y: world.y, w: 0, h: 0 } })
      capturePointer(host, event.pointerId)
      return
    }
    if (activeTool === 'text') {
      startTextAt(screen, world)
      return
    }
    if (activeTool !== 'select') return

    // 单选时：先判边/角（缩放），再判角外一圈（旋转）
    const localHit = localScreenPoint(screen)
    if (localHit) {
      const node = graph?.nodes[selectedIds[0] ?? '']
      const handle = resizeHandleAt(node, localHit.bounds, localHit.point)
      if (handle && node) {
        // 基准用**画布绝对坐标**：和指针位置同坐标系，嵌在容器里的对象也算得对；
        // 对组来说这就是"内容的并集"那个框（模型里的 w/h 对组没有意义）。
        const base = {
          x: localHit.bounds.x,
          y: localHit.bounds.y,
          w: localHit.bounds.w,
          h: localHit.bounds.h
        }
        dragRef.current = {
          kind: 'resize',
          pointerId: event.pointerId,
          handle,
          origin: world,
          id: node.id,
          crop: event.metaKey && node.type === 'asset' ? cropOf(node.props.crop) : null,
          base,
          rotation: localHit.rotation
        }
        capturePointer(host, event.pointerId)
        return
      }
      if (node && rotateZoneAtPoint(localHit.bounds, viewport, localHit.point)) {
        const center = {
          x: localHit.bounds.x + localHit.bounds.w / 2,
          y: localHit.bounds.y + localHit.bounds.h / 2
        }
        dragRef.current = {
          kind: 'rotate',
          pointerId: event.pointerId,
          id: node.id,
          center,
          startAngle: Math.atan2(world.y - center.y, world.x - center.x),
          from: node.rotation,
          box: { x: node.x, y: node.y, w: node.w, h: node.h }
        }
        capturePointer(host, event.pointerId)
        return
      }
    }

    const rawHit = hitTest(items, world)
    const hit = resolveClick(rawHit)
    if (hit) {
      const next = event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
        ? selectedIds.includes(hit)
          ? selectedIds.filter((id) => id !== hit)
          : [...selectedIds, hit]
        : selectedIds.includes(hit)
          ? selectedIds
          : [hit]
      // 鼠标按下前留下的预选框（尤其是双击刚进入的父组）不能跨越一次选择。
      // 否则会把 hover 框和 selected 框叠在一起，视觉上像“多出一个蓝框”。
      setHoverId(null)
      // Figma 同款：⌥ 拖动生成副本；⌘ 保留给裁切手柄等已有修饰行为。
      const duplicated = event.altKey ? duplicateSelection(next) : null
      const dragIds = duplicated?.ids ?? next
      const sourceIds = duplicated?.sourceIds ?? next
      select(dragIds)

      // 起点盒子用**画布绝对坐标**：吸附要拿它跟别人的绝对盒子比，
      // 蓝框也要按它画；嵌在容器里的对象用相对坐标会算错。
      const boxes = boxesOfItems(items, sourceIds)
      const start = sourceIds.flatMap((sourceId, index) => {
        const box = boxes.get(sourceId)
        const id = dragIds[index]
        return box && id ? [{ id, x: box.x, y: box.y, w: box.w, h: box.h }] : []
      })
      if (start.length > 0) {
        dragRef.current = { kind: 'move', pointerId: event.pointerId, origin: world, start, axis: null }
        capturePointer(host, event.pointerId)
      }
      return
    }

    // 空白处：框选
    if (!event.shiftKey) clearSelection()
    dragRef.current = {
      kind: 'marquee',
      pointerId: event.pointerId,
      origin: world,
      additive: event.shiftKey,
      baseIds: event.shiftKey ? selectedIds : []
    }
    setMarquee({ x: world.x, y: world.y, w: 0, h: 0 })
    capturePointer(host, event.pointerId)
  }

  /**
   * 画布上其它节点的盒子，作为吸附参照。
   *
   * 排除三类，否则参考线会满屏乱窜：
   *   - **被拖的那几个**自己；
   *   - 它们的**祖先**——父容器包着被拖的东西，而且组的边框本身就是由里面的东西算出来的
   *     （见 `shared/scene.ts`），拿它当对齐参照等于自己跟自己对齐；
   *   - 它们的**子孙**——跟着一起动，相对关系永远不变，吸上去就是一条常亮的假参考线。
   *
   * 剩下的正好是"能真正对齐的别人"：兄弟、以及画布上别的对象。
   */
  function otherBoxes(movingIds = selectedIds): Rect[] {
    const excluded = new Set<string>(movingIds)
    if (graph) {
      for (const id of movingIds) {
        for (const ancestor of ancestorsOf(graph, id)) excluded.add(ancestor.id)
        for (const descendant of descendantsOf(graph, id)) excluded.add(descendant)
      }
    }

    const boxes: Rect[] = []
    const walk = (list: SceneItem[]): void => {
      for (const item of list) {
        if (item.node.visible && !excluded.has(item.node.id)) {
          boxes.push({ x: item.absX, y: item.absY, w: item.w, h: item.h })
        }
        walk(item.children)
      }
    }
    walk(items)
    return boxes
  }

  /**
   * 算出移动后的位移：先按指针位移，再交给吸附做微调。
   * **提交时也用这个结果**——否则松手会跳回没吸附的位置。
   */
  function moveDelta(
    drag: Extract<DragState, { kind: 'move' }>,
    world: Point
  ): { dx: number; dy: number; guides: GuideLine[] } {
    let rawDx = world.x - drag.origin.x
    let rawDy = world.y - drag.origin.y

    if (drag.axis) {
      if (drag.axis === 'x') rawDy = 0
      else rawDx = 0
    }

    const left = Math.min(...drag.start.map((s) => s.x))
    const top = Math.min(...drag.start.map((s) => s.y))
    const right = Math.max(...drag.start.map((s) => s.x + s.w))
    const bottom = Math.max(...drag.start.map((s) => s.y + s.h))

    const moving = { x: left + rawDx, y: top + rawDy, w: right - left, h: bottom - top }
    // 吸附阈值按屏幕 6px 换算到世界坐标
    const snap = snapBoxes(moving, otherBoxes(drag.start.map((item) => item.id)), 6 / viewport.zoom)
    return { dx: rawDx + snap.dx, dy: rawDy + snap.dy, guides: snap.guides }
  }

  /**
   * 算出缩放后的新盒子。
   *
   * 规则对齐 Figma：
   *   - **默认自由比例**：拖角改两个方向，拖边只改一个方向；
   *   - **按住 ⇧ 锁定原比例**：另一边按原比例跟着走；
   *   - **不翻转**：拖过头就在最小尺寸停住，不会把图翻过来（Figma 也是如此）。
   */
  /** 旋转预览用的角度（⇧ 吸附到 15°）。 */
  function rotateAngle(
    drag: Extract<DragState, { kind: 'rotate' }>,
    world: Point,
    shiftKey: boolean
  ): number {
    const angle = Math.atan2(world.y - drag.center.y, world.x - drag.center.x)
    let degrees = drag.from + ((angle - drag.startAngle) * 180) / Math.PI
    if (shiftKey) degrees = Math.round(degrees / 15) * 15
    return normalizeAngle(degrees)
  }

  /**
   * 算出缩放后的新盒子。
   *
   * 图片规则：默认锁定比例，按住 ⇧ 才允许自由比例；组保持原先的 ⇧ 锁比例规则。
   *   - **不翻转**：拖过头在最小尺寸停住；
   *   - **节点转过的话，整个计算在它的局部坐标系里做**（把指针反向旋转回未旋转的姿态），
   *     再把算好的中心转回世界。否则旋转过的节点一拖边就会歪。
   */
  function resizeBox(
    drag: Extract<DragState, { kind: 'resize' }>,
    world: Point,
    shiftKey: boolean
  ): Box {
    const { base, handle, rotation } = drag
    const center = { x: base.x + base.w / 2, y: base.y + base.h / 2 }
    const local = rotateAround(world, center, -rotation)

    const west = handle.includes('w')
    const east = handle.includes('e')
    const north = handle.includes('n')
    const south = handle.includes('s')

    const anchor = {
      x: west ? center.x + base.w / 2 : center.x - base.w / 2,
      y: north ? center.y + base.h / 2 : center.y - base.h / 2
    }

    let left = center.x - base.w / 2
    let right = center.x + base.w / 2
    let top = center.y - base.h / 2
    let bottom = center.y + base.h / 2

    if (west) left = Math.min(local.x, right - MIN_SIZE)
    if (east) right = Math.max(local.x, left + MIN_SIZE)
    if (north) top = Math.min(local.y, bottom - MIN_SIZE)
    if (south) bottom = Math.max(local.y, top + MIN_SIZE)

    let w = right - left
    let h = bottom - top

    const node = graph?.nodes[drag.id]
    // 文本只做等比缩放（缩放即改字号）；⌘ 快捷裁切默认自由框选，⇧ 可临时锁比例；
    // 普通图片正好相反。
    const isText = node?.type === 'frame' && node.props.element?.kind === 'text'
    const lockAspect = isText || (drag.crop ? shiftKey : node?.type === 'asset' ? !shiftKey : shiftKey)
    if (lockAspect && base.w > 0 && base.h > 0) {
      const ratio = base.w / base.h
      if (isCorner(handle)) {
        if (w / base.w >= h / base.h) h = w / ratio
        else w = h * ratio
      } else if (west || east) {
        h = w / ratio
      } else {
        w = h * ratio
      }
      // 按锚点摆回去，比例锁定才不会跑位
      if (west) left = anchor.x - w
      else if (east) right = anchor.x + w
      if (north) top = anchor.y - h
      else if (south) bottom = anchor.y + h
    }

    let localCenterX = (left + right) / 2
    let localCenterY = (top + bottom) / 2
    // 按住 ⇧ 拖单边时，另一轴围绕原中心对称生长
    if (lockAspect && !isCorner(handle)) {
      if (west || east) localCenterY = center.y
      else localCenterX = center.x
    }

    const newCenter = rotateAround({ x: localCenterX, y: localCenterY }, center, rotation)
    return {
      x: Math.round(newCenter.x - w / 2),
      y: Math.round(newCenter.y - h / 2),
      w: Math.round(w),
      h: Math.round(h)
    }
  }

  /**
   * 文本缩放的落点：等比缩放换算成字号，字号吸到整数，盒子再按字号重算。
   *
   * 吸附发生在**预览阶段**（resizeResult 也走这里），所以拖动时文字是一档一档
   * 变大的，不会出现松手才跳一下。盒子宽高含 3px 留白，换算比例时先把它扣掉。
   */
  function textScaleResult(
    drag: Extract<DragState, { kind: 'resize' }>,
    box: Box,
    node: Node
  ): { box: Box; fontSize: number } | null {
    if (node.type !== 'frame' || node.props.element?.kind !== 'text') return null
    const innerBase = Math.max(1, drag.base.w - TEXT_PADDING * 2)
    const innerNext = Math.max(1, box.w - TEXT_PADDING * 2)
    const raw = node.props.element.fontSize * (innerNext / innerBase)
    const fontSize = Math.min(TEXT_MAX_FONT_SIZE, Math.max(TEXT_MIN_FONT_SIZE, Math.round(raw)))
    const size = textBoxSize(node.props.element.text, fontSize)
    const w = size.w + TEXT_PADDING * 2
    const h = size.h + TEXT_PADDING * 2
    // 以拖动结果的中心为基准重算盒子，四角缩放时视觉上仍钉住对角。
    return {
      box: {
        x: Math.round(box.x + box.w / 2 - w / 2),
        y: Math.round(box.y + box.h / 2 - h / 2),
        w: Math.round(w),
        h: Math.round(h)
      },
      fontSize
    }
  }

  /**
   * 缩放的最终结果：几何计算之上再叠一层吸附（D2.6）。
   *
   * 只在没旋转、也没锁比例时吸附：
   *   - 转过以后"边"在屏幕上不横平竖直，拿横竖参考线去吸会错位；
   *   - ⇧ 锁比例时吸一条边会破坏比例，两者本就冲突。
   * 吸附若把边吸得比最小尺寸还小，宁可整条放弃吸附，也不缩成一条缝。
   */
  function resizeResult(
    drag: Extract<DragState, { kind: 'resize' }>,
    world: Point,
    shiftKey: boolean
  ): { box: Box; guides: GuideLine[] } {
    const box = resizeBox(drag, world, shiftKey)
    const node = graph?.nodes[drag.id]
    if (node?.type === 'frame' && node.props.element?.kind === 'text') {
      const fitted = textScaleResult(drag, box, node)
      return fitted ? { box: fitted.box, guides: [] } : { box, guides: [] }
    }
    const lockAspect = drag.crop ? shiftKey : node?.type === 'asset' ? !shiftKey : shiftKey
    if (lockAspect || drag.rotation !== 0) return { box, guides: [] }

    const snapped = snapResizeBox(box, movingEdges(drag.handle), otherBoxes(), 6 / viewport.zoom)
    const rect = {
      x: Math.round(snapped.rect.x),
      y: Math.round(snapped.rect.y),
      w: Math.round(snapped.rect.w),
      h: Math.round(snapped.rect.h)
    }
    if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) return { box, guides: [] }
    return { box: rect, guides: snapped.guides }
  }

  /** 单选时，把屏幕点转进该节点的局部坐标系（节点转过以后判定才不会错）。 */
  function localScreenPoint(screen: Point): { point: Point; bounds: Rect; rotation: number } | null {
    const bounds = boundsOfItems(items, selectedIds)
    if (!bounds || selectedIds.length !== 1) return null
    const rotation = rotationsOfItems(items, selectedIds).get(selectedIds[0] ?? '') ?? 0
    const centerScreen = toScreen(viewport, {
      x: bounds.x + bounds.w / 2,
      y: bounds.y + bounds.h / 2
    })
    return { point: rotateAround(screen, centerScreen, -rotation), bounds, rotation }
  }

  /**
   * 悬停状态机：决定"此刻指针下是什么、光标该是什么样"。
   * 只在**没有拖动**时更新——拖动中光标要保持住，不然会跳。
   */
  function updateHover(screen: Point, world: Point): void {
    if (tool === 'hand' || spaceRef.current) {
      setHoverId(null)
      setHoverCursor('grab')
      return
    }
    if (tool !== 'select') {
      setHoverId(null)
      setHoverCursor('crosshair')
      return
    }

    const bounds = boundsOfItems(items, selectedIds)
    if (selectedIds.length === 1 && bounds) {
      // 节点转过以后，边/角在屏幕上也是转过的 → 先把指针转回局部坐标系再判定
      const rotation = rotationsOfItems(items, selectedIds).get(selectedIds[0] ?? '') ?? 0
      const centerScreen = toScreen(viewport, {
        x: bounds.x + bounds.w / 2,
        y: bounds.y + bounds.h / 2
      })
      const local = rotateAround(screen, centerScreen, -rotation)

      // 边/角命中区优先：压在上面就是缩放（组没有缩放柄，见 `canResize`）
      const handle = resizeHandleAt(graph?.nodes[selectedIds[0] ?? ''], bounds, local)
      if (handle) {
        setHoverId(null)
        setHoverCursor(cursorForHandle(handle))
        return
      }
      // 角的外侧一小圈 = 旋转
      if (rotateZoneAtPoint(bounds, viewport, local)) {
        setHoverId(null)
        setHoverCursor(ROTATE_CURSOR)
        return
      }
    }

    const rawHit = hitTest(items, world)
    const hit = rawHit ? targetIdFor(rawHit) : null
    if (hit) {
      // 已经选中的对象不再画预选框
      setHoverId(selectedIds.includes(hit) ? null : hit)
      setHoverCursor('move')
      return
    }
    // 压在选中框的边上也算"能拖"（Figma 如此）
    if (bounds && onBoxEdge(bounds, world)) {
      setHoverId(null)
      setHoverCursor('move')
      return
    }
    setHoverId(null)
    setHoverCursor('default')
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      const screen = localPoint(event)
      updateHover(screen, toWorld(viewport, screen))
      return
    }

    if (drag.kind === 'pan') {
      queuePan(event.clientX - drag.lastX, event.clientY - drag.lastY)
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      return
    }

    const world = toWorld(viewport, localPoint(event))

    if (drag.kind === 'marquee') {
      const rect = rectFromPoints(drag.origin, world)
      setMarquee(rect)
      const found = itemsInRect(items, rect)
      select(drag.additive ? [...new Set([...drag.baseIds, ...found])] : found)
      return
    }

    if (drag.kind === 'create-shape') {
      setShapeDraft({ shape: drag.shape, rect: shapeRectFromPoints(drag.origin, world, drag.shape, event.shiftKey) })
      return
    }

    // 到这儿只剩移动 / 缩放 / 旋转：指针真的动过了，收起选中工具条
    setNodeDragging(true)
    if (drag.kind === 'move') setMovingSelection(true)

    if (drag.kind === 'move') {
      if (event.shiftKey && drag.axis === null) {
        const dx = world.x - drag.origin.x
        const dy = world.y - drag.origin.y
        if (dx !== 0 || dy !== 0) drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      }
      if (!event.shiftKey) drag.axis = null
      const drop = graph
        ? computeContainerDrop(graph, items, world, drag.start.map((s) => s.id))
        : null
      const moved = moveDelta(drag, world)

      // 预览给渲染层的坐标是**相对父节点**的，蓝框要的是**绝对**的——同一份数据两种口径
      const preview = new Map<string, PreviewBox>()
      const live = new Map<string, Rect>()
      for (const s of drag.start) {
        preview.set(s.id, previewPositionFromWorld(items, s.id, { x: s.x + moved.dx, y: s.y + moved.dy }))
        live.set(s.id, { x: s.x + moved.dx, y: s.y + moved.dy, w: s.w, h: s.h })
      }
      layerRef.current?.preview(preview)
      setDragBoxes(live)
      setInsertion(drop ? drop.line : null)
      // 落进容器后位置由布局决定，吸附参考线没有意义
      setGuides(drop ? [] : moved.guides)
      return
    }

    if (drag.kind === 'rotate') {
      const degrees = rotateAngle(drag, world, event.shiftKey)
      layerRef.current?.preview(
        new Map([[drag.id, { x: drag.box.x, y: drag.box.y, rotation: degrees }]])
      )
      setSizeBadge({ bounds: drag.box, text: `${Math.round(degrees)}°` })
      return
    }

    if (drag.kind === 'resize') {
      const { box, guides: snapGuides } = resizeResult(drag, world, event.shiftKey)
      const crop = drag.crop ? cropFromResize(drag.crop, drag.base, box) : undefined
      // 预览要的是模型坐标；组的话缩的是外面那层容器，里面的东西自然跟着缩
      layerRef.current?.preview(new Map([[drag.id, { ...toLocalBox(box, drag.id), ...(crop ? { crop } : {}) }]]))
      setDragBoxes(new Map([[drag.id, { x: box.x, y: box.y, w: box.w, h: box.h }]]))
      setGuides(snapGuides)
      // 缩放时在框下方显示实时尺寸（Figma 同款）
      setSizeBadge({ bounds: box, text: `${box.w} × ${box.h}` })
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    // 松手前把还没落下的那一小段平移补上，避免画面差几个像素
    if (drag.kind === 'pan') flushPan()
    setPanning(false)
    setMarquee(null)
    setSizeBadge(null)
    setGuides([])
    setInsertion(null)
    setDragBoxes(null)
    // 松手：选中工具条和选中框都浮回来
    setNodeDragging(false)
    setMovingSelection(false)
    releasePointer(event.currentTarget, event.pointerId)

    const world = toWorld(viewport, localPoint(event))

    if (drag.kind === 'create-shape') {
      addShape(drag.shape, drag.origin, shapeRectFromPoints(drag.origin, world, drag.shape, event.shiftKey))
      setShapeDraft(null)
      return
    }

    if (drag.kind === 'move') {
      setInsertion(null)

      // 拖进自动布局容器：按插入线落位（D4b.7）；拖出容器：变回自由节点（D4b.8）
      if (graph && drag.start.length > 0) {
        const ids = drag.start.map((s) => s.id)
        const drop = computeContainerDrop(graph, items, world, ids)
        if (drop) {
          const sameParent = ids.every((id) => graph.nodes[id]?.parentId === drop.containerId)
          if (ids.length > 1) {
            // 多选拖入：整组一次性落位，历史里也只有一步。
            execute(createMoveNodesToParentCommand(ids, drop.containerId, drop.index))
            return
          }
          const id = ids[0]!
          const currentIndex = flowChildIds(graph, drop.containerId).indexOf(id)
          // drop.index 已经是"把被拖动项摘掉之后"的落点，不用再减一
          if (!sameParent || drop.index !== currentIndex) {
            execute(createMoveNodeCommand(id, drop.containerId, drop.index))
            return
          }
          layerRef.current?.clearPreview()
          return
        }
        const inContainer = ids.filter((id) => parentIsContainer(graph, id))
        if (inContainer.length > 0) {
          execute(createMoveNodesToParentCommand(inContainer, null, graph.rootIds.length))
          return
        }
      }

      if (event.shiftKey && drag.axis === null) {
        const dx = world.x - drag.origin.x
        const dy = world.y - drag.origin.y
        if (dx !== 0 || dy !== 0) drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      }
      if (!event.shiftKey) drag.axis = null
      const moved = moveDelta(drag, world)
      const dx = Math.round(moved.dx)
      const dy = Math.round(moved.dy)
      if (dx !== 0 || dy !== 0) {
        execute(
          createMoveNodesCommand(
            // 位移是"平移"，与坐标系无关：模型的 x/y 直接加同一个位移即可，
            // `drag.start` 那份是绝对坐标，只用来算吸附和画蓝框。
            drag.start.flatMap((s) => {
              const node = graph?.nodes[s.id]
              if (!node) return []
              return [
                {
                  id: s.id,
                  from: { x: node.x, y: node.y },
                  to: { x: node.x + dx, y: node.y + dy }
                }
              ]
            })
          )
        )
      } else {
        layerRef.current?.clearPreview()
      }
      return
    }

    if (drag.kind === 'rotate') {
      const degrees = rotateAngle(drag, world, event.shiftKey)
      if (degrees !== drag.from) execute(createRotateNodeCommand(drag.id, drag.from, degrees))
      else layerRef.current?.clearPreview()
      return
    }

    if (drag.kind === 'resize') {
      // 手柄热区有 6px，点在角上但没拖动时不能按“指针位置”反算尺寸——
      // 那会把一次普通点击变成悄悄缩小 6px（文本还会连带改字号）。
      const travelled = Math.hypot(world.x - drag.origin.x, world.y - drag.origin.y) * viewport.zoom
      if (travelled < 2) {
        layerRef.current?.clearPreview()
        return
      }
      const { box } = resizeResult(drag, world, event.shiftKey)
      const node = graph?.nodes[drag.id]
      const moved =
        box.x !== drag.base.x || box.y !== drag.base.y || box.w !== drag.base.w || box.h !== drag.base.h

      if (!graph || !node || !moved) {
        layerRef.current?.clearPreview()
        return
      }

      // 文本：一条命令同时改字号与盒子，⌘Z 不会只退回一半。
      if (node.type === 'frame' && node.props.element?.kind === 'text') {
        const fitted = textScaleResult(drag, box, node)
        if (fitted) {
          execute(
            createFitTextNodeCommand(
              drag.id,
              { element: node.props.element, box: toLocalBox(drag.base, drag.id) },
              {
                element: { ...node.props.element, fontSize: fitted.fontSize },
                box: toLocalBox(fitted.box, drag.id)
              }
            )
          )
        } else {
          layerRef.current?.clearPreview()
        }
        return
      }

      if (drag.crop && node.type === 'asset') {
        execute(
          createSetAssetCropCommand(
            drag.id,
            { box: { x: node.x, y: node.y, w: node.w, h: node.h }, crop: drag.crop },
            { box: toLocalBox(box, drag.id), crop: cropFromResize(drag.crop, drag.base, box) }
          )
        )
        return
      }

      // 拖组的角 = 把**整棵子树**按比例缩放（一条命令，⌘Z 一下退回）
      if (node.type === 'group') {
        const changes = scaleGroupChanges(
          graph,
          drag.id,
          toLocalBox(drag.base, drag.id),
          toLocalBox(box, drag.id)
        )
        if (changes.length > 1) execute(createResizeNodesCommand(changes))
        else layerRef.current?.clearPreview()
        return
      }

      execute(
        createResizeNodeCommand(
          drag.id,
          { x: node.x, y: node.y, w: node.w, h: node.h },
          toLocalBox(box, drag.id)
        )
      )
    }
  }

  /** 落点 → 画布世界坐标；节点就摆在这儿（占位框和真图用同一个左上角，不会跳）。 */
  function dropWorldPoint(event: DragEvent<HTMLDivElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect()
    return toWorld(viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top })
  }

  /** 当前浏览器标签的地址，做 referrer 用（起始页是占位符，当作没有）。 */
  function currentPageUrl(): string | null {
    const browser = useBrowserStore.getState().state
    return displayUrl(activeTab(browser)) || null
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragActive(false)
    if (!canvas) {
      setNotice(BRIDGE_STALE_MESSAGE, 'error')
      return
    }
    if (!project) {
      setNotice('请先新建项目，再导入图片', 'error')
      return
    }

    // 0) 本地素材侧栏：托管素材直接复用；外部只读文件由主进程先复制进资产库。
    const libraryPayload = event.dataTransfer.getData(LIBRARY_DRAG_MIME)
    if (libraryPayload) {
      const items = parseLibraryDragPayload(libraryPayload)
      if (items.length === 0) {
        setNotice('素材信息已失效，请重新拖动', 'error')
        return
      }
      void importLibraryItems(project.id, items, dropWorldPoint(event))
      return
    }

    // 1) 访达里拖来的图片文件：走本地文件那条老路
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => canvas.pathOf(file))
      .filter((path) => path.length > 0)
    if (paths.length > 0) {
      void importPaths(project.id, paths)
      return
    }

    // 2) 网页上拖来的：通常**只有地址、没有字节**（D3.8/D3.9），交给主进程二次下载
    const data = event.dataTransfer
    const payload = {
      textHtml: data.getData('text/html') || null,
      textUriList: data.getData('text/uri-list') || null,
      textPlain: data.getData('text/plain') || null
    }
    if (!payload.textHtml && !payload.textUriList && !payload.textPlain) {
      setNotice('未识别到图片，请拖入图片文件或网页图片', 'error')
      return
    }
    void receiveWebDrop(payload, dropWorldPoint(event))
  }

  /** 网页图片的下载、成功和失败都由工具条上方的 Toast 反馈，不在画布留下临时物。 */
  async function receiveWebDrop(
    payload: WebDropPayload,
    at: Point
  ): Promise<void> {
    if (!project) return
    await importWeb(project.id, {
      payload,
      pageUrl: currentPageUrl(),
      position: at
    })
  }

  // 拖动/平移中光标不由悬停决定，避免跳来跳去
  const cursor = (panning ? 'grabbing' : hoverCursor) as CSSProperties['cursor']

  const fitting = (): void => {
    commitViewport(fitViewport(contentBounds(items), viewportSize()))
  }

  const hasContent = Boolean(graph && graph.rootIds.length > 0)

  // 选中单个自动布局容器时，在它上方浮出"情境工具栏"（D4b.10）
  const autoLayoutTarget =
    graph && selectedIds.length === 1
      ? (() => {
          const node = graph.nodes[selectedIds[0]!]
          return node && node.type === 'frame' && isAutoLayoutContainer(node) ? node : null
        })()
      : null

  const autoLayoutTargetStyle: CSSProperties | null = (() => {
    if (!autoLayoutTarget) return null
    const item = findItem(items, autoLayoutTarget.id)
    if (!item) return null
    const topLeft = toScreen(viewport, { x: item.absX, y: item.absY })
    const bottomRight = toScreen(viewport, { x: item.absX + item.w, y: item.absY + item.h })
    const TOOLBAR_HEIGHT = 46
    const above = topLeft.y - TOOLBAR_HEIGHT - 8
    const top = above >= 8 ? above : bottomRight.y + 8
    // 工具栏与对象水平居中，同时夹在可见画布内。
    const stageWidth = viewportSize().w
    const minLeft = panelInset + 8
    const maxLeft = Math.max(minLeft, stageWidth - toolbarWidth - 8)
    const center = (topLeft.x + bottomRight.x) / 2
    const left = Math.min(Math.max(minLeft, center - toolbarWidth / 2), maxLeft)
    return { position: 'absolute', left, top, maxWidth: 'calc(100% - 16px)' }
  })()

  /** 所有贴对象的工具条都在选区外侧留 8px，并以选区中心线对齐。 */
  const SELECTION_TOOLBAR_HEIGHT = 40
  const selectionToolbarStyle: CSSProperties | null = (() => {
    if (selectedIds.length === 0 || marquee || nodeDragging) return null
    const item = boundsOfItems(items, selectedIds)
    if (!item) return null
    const topLeft = toScreen(viewport, { x: item.x, y: item.y })
    const bottomRight = toScreen(viewport, { x: item.x + item.w, y: item.y + item.h })
    const autoToolbarAbove = autoLayoutTarget ? topLeft.y - 46 - 8 >= 8 : false
    const above = autoLayoutTarget
      ? topLeft.y - 46 - 8 - SELECTION_TOOLBAR_HEIGHT - 8
      : topLeft.y - SELECTION_TOOLBAR_HEIGHT - 8
    const top = above >= 8
      ? above
      : bottomRight.y + 8 + (autoLayoutTarget && !autoToolbarAbove ? 46 + 8 : 0)
    const stageWidth = viewportSize().w
    const minLeft = panelInset + 8
    const maxLeft = Math.max(minLeft, stageWidth - selectionToolbarWidth - 8)
    const center = (topLeft.x + bottomRight.x) / 2
    const left = Math.min(Math.max(minLeft, center - selectionToolbarWidth / 2), maxLeft)
    return { position: 'absolute', left, top, maxWidth: 'calc(100% - 16px)' }
  })()

  const selectedAsset =
    graph && selectedIds.length === 1 && graph.nodes[selectedIds[0] ?? '']?.type === 'asset'
      ? graph.nodes[selectedIds[0] ?? '']
      : null
  const searchConsentDisclosure = searchConsent
    ? imageSearchConsentDisclosure(searchConsent.engineId)
    : null
  const selectedPinTarget =
    graph && selectedIds.length === 1
      ? (() => {
          const node = graph.nodes[selectedIds[0]!]
          return node && (node.type === 'group' || (node.type === 'frame' && isAutoLayoutContainer(node))) ? node : null
        })()
      : null
  const selectedElement = (() => {
    if (selectedIds.length !== 1) return null
    const node = graph?.nodes[selectedIds[0] ?? '']
    return node?.type === 'frame' ? node.props.element ?? null : null
  })()
  const selectionToolbarVisible = Boolean(selectedAsset || selectedPinTarget || selectedIds.length > 1)
  /** 编辑框内容尺寸；与提交后节点的包围盒共用同一套测量结果。 */
  const inlineEditorSize = inlineEditor
    ? textBoxSize(inlineEditor.value, inlineEditor.fontSize)
    : null
  const elementPropsStyle: CSSProperties | null = (() => {
    if (!selectedElement) return null
    const item = boundsOfItems(items, selectedIds)
    if (!item) return null
    const topLeft = toScreen(viewport, { x: item.x, y: item.y })
    const bottomRight = toScreen(viewport, { x: item.x + item.w, y: item.y + item.h })
    const stage = viewportSize()
    const minLeft = panelInset + 8
    const center = (topLeft.x + bottomRight.x) / 2
    const left = Math.min(
      Math.max(minLeft, center - elementPropsWidth / 2),
      Math.max(minLeft, stage.w - elementPropsWidth - 8)
    )
    // 自动布局容器上方已有自己的情境条，属性条改到下方，避免两条工具条互相盖住。
    const above = topLeft.y - 44 - 8
    const top = !autoLayoutTarget && above >= 8 ? above : bottomRight.y + 8
    return { position: 'absolute', left, top, maxWidth: 'calc(100% - 16px)' }
  })()


  return (
    <div
      className="stage"
      data-drag-active={dragActive}
      data-textured={textured === null ? 'pending' : String(textured)}
      data-selected={selectedIds.length}
      data-content={hasContent}
      data-project-ready={project ? 'true' : 'false'}
      data-graph-ready={graph ? 'true' : 'false'}
      onDragOver={(event) => {
        event.preventDefault()
        if (!dragActive) setDragActive(true)
      }}
      onDragLeave={(event) => {
        // 拖回浏览器时，指针已经落在原生网页视图/侧栏上，stage 收不到"离开"的子元素
        // 事件；按面板几何判断，避免"松开即可收进画布"一直挂在画布上。
        const x = event.clientX
        const overSidePanel = folderPanelOpen
          ? x <= panel.openWidth
          : panel.open
            ? panel.dock === 'right'
              ? x >= window.innerWidth - panel.width - 8
              : x <= panel.width
            : false
        if (overSidePanel || event.currentTarget === event.target) setDragActive(false)
      }}
      onDrop={onDrop}
    >
      <div
        className="stage__canvas"
        ref={hostRef}
        style={{ cursor }}
        onMouseDown={(event) => {
          // 文本工具按下画布时，浏览器默认会把焦点移到 body；它会和下一帧的
          // editor.focus() 抢时序，偶尔让刚出现的编辑框立刻失焦被当成“取消”。
          if (useUiStore.getState().tool === 'text') event.preventDefault()
        }}
        onPointerEnter={() => {
          if (useSelectionStore.getState().pendingIds.length > 0) {
            useSelectionStore.getState().takePending()
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => {
          if (dragRef.current) return
          setHoverId(null)
          setHoverCursor(tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair')
        }}
      />

      {ready && project && !cropSession && <NodeBadges items={items} assets={assets} viewport={viewport} />}

      {ready && project && !cropSession && (
        <SelectionOverlay
          items={items}
          selectedIds={
            inlineEditor?.nodeId
              ? selectedIds.filter((id) => id !== inlineEditor.nodeId)
              : selectedIds
          }
          hoverId={inlineEditor ? null : panelHoverId ?? hoverId}
          viewport={viewport}
          marquee={marquee}
          sizeBadge={sizeBadge}
          guides={guides}
          insertion={insertion}
          liveBoxes={dragBoxes}
          moving={movingSelection}
        />
      )}

      {shapeDraft && <ShapeDraftPreview shape={shapeDraft.shape} rect={shapeDraft.rect} viewport={viewport} />}

      {autoLayoutTarget && autoLayoutTargetStyle && graph && (
        <AutoLayoutToolbar
          node={autoLayoutTarget}
          childCount={flowChildIds(graph, autoLayoutTarget.id).length}
          style={autoLayoutTargetStyle}
          containerRef={setToolbarEl}
          onPatch={(patch) => execute(createSetAutoLayoutCommand(autoLayoutTarget.id, patch))}
          onRemove={() => execute(createRemoveAutoLayoutCommand(autoLayoutTarget.id))}
        />
      )}

      {!cropSession && selectionToolbarVisible && selectionToolbarStyle && (
        <SelectionToolbar
          style={selectionToolbarStyle}
          containerRef={setSelectionToolbarEl}
          single={
            selectedAsset
              ? {
                  onSnapshot: () => void createSnapshot(),
                  onCrop: startCrop,
                  onSource: openSelectedSource,
                  onCopy: () => void copySelectedWithSystem(),
                  cutout: showCutout ? { busy: cutoutBusy, onRun: () => void cutoutSelection() } : undefined,
                  searchByImage: {
                    engines: searchEngineOptions,
                    busy: searchBusy,
                    onPick: (id, mode) => void pickImageSearch(id, mode),
                    onCropSearch: startCropSearch,
                    onCancel: cancelImageSearch
                  }
                }
              : undefined
          }
          multi={
            selectedIds.length > 1
              ? {
                  onSnapshot: () => void createSnapshot(),
                  onCopy: () => void copySelectedWithSystem(),
                  onAutoLayout: wrapInAutoLayout,
                  onAlign: alignSelection
                }
              : undefined
          }
          pinOnly={selectedPinTarget ? { onSnapshot: () => void createSnapshot(), onCopy: () => void copySelectedWithSystem() } : undefined}
        />
      )}

      {cropSession && (() => {
        const node = graph?.nodes[cropSession.nodeId]
        const item = node ? findItem(items, node.id) : null
        const asset = node?.type === 'asset' ? assets[node.props.assetId] : undefined
        if (!node || node.type !== 'asset' || !item || !asset || !canvas) return null
        return (
          <CropOverlay
            key={`${cropSession.nodeId}:${cropSession.purpose}`}
            box={{ x: item.absX, y: item.absY, w: item.w, h: item.h }}
            rotation={node.rotation}
            crop={cropSession.initial}
            naturalWidth={node.props.naturalWidth}
            naturalHeight={node.props.naturalHeight}
            url={canvas.assetUrl(asset.fileName)}
            viewport={viewport}
            stage={viewportSize()}
            insetLeft={panelInset}
            purpose={cropSession.purpose}
            searchEngines={searchEngineOptions}
            onDraft={(result) => {
              cropDraftRef.current = result
            }}
            onApply={applyCrop}
            onSearch={searchCrop}
            onCancel={cancelCrop}
          />
        )
      })()}

      {selectedElement && elementPropsStyle && graph && (
        <CanvasElementPropertiesToolbar
          elementId={selectedIds[0] ?? ''}
          element={selectedElement}
          style={elementPropsStyle}
          containerRef={setElementPropsEl}
          size={{ w: boundsOfItems(items, selectedIds)?.w ?? 1, h: boundsOfItems(items, selectedIds)?.h ?? 1 }}
          onChange={(elementId, next) => {
            const node = graph.nodes[elementId]
            if (node?.type !== 'frame' || !node.props.element) return
            // 文本是自动宽度：换字号后盒子要同步贴合，不能留下旧尺寸的选中框。
            if (next.kind === 'text') {
              const size = textBoxSize(next.text, next.fontSize)
              execute(
                createFitTextNodeCommand(
                  node.id,
                  { element: node.props.element, box: { x: node.x, y: node.y, w: node.w, h: node.h } },
                  {
                    element: next,
                    box: {
                      x: node.x,
                      y: node.y,
                      w: size.w + TEXT_PADDING * 2,
                      h: size.h + TEXT_PADDING * 2
                    }
                  }
                )
              )
              return
            }
            execute(createSetCanvasElementCommand(node.id, node.props.element, next))
          }}
          onResize={(elementId, { w, h }) => {
            const node = graph.nodes[elementId]
            if (!node) return
            execute(createResizeNodeCommand(node.id, { x: node.x, y: node.y, w: node.w, h: node.h }, { x: node.x, y: node.y, w, h }))
          }}
        />
      )}

      {inlineEditor?.kind === 'text' && inlineEditorSize && (
        <textarea
          ref={inlineEditorRef}
          className="canvas-text-editor"
          wrap="off"
          spellCheck={false}
          style={{
            // 编辑框的外沿与提交后的选中框完全重合：字体、留白、线宽都按缩放换算。
            // 宽高直接取测量结果（不依赖 textarea 自带的排版宽度，二者会差几个像素）。
            left: inlineEditor.screen.x - TEXT_PADDING * viewport.zoom - 1.5,
            top: inlineEditor.screen.y - TEXT_PADDING * viewport.zoom - 1.5,
            width: Math.max(2, inlineEditorSize.w * viewport.zoom),
            height: inlineEditorSize.h * viewport.zoom,
            padding: TEXT_PADDING * viewport.zoom,
            fontSize: inlineEditor.fontSize * viewport.zoom,
            lineHeight: `${textLineHeight(inlineEditor.fontSize) * viewport.zoom}px`,
            color: inlineEditor.color
          }}
          value={inlineEditor.value}
          onPointerDown={(event) => {
            event.stopPropagation()
            event.currentTarget.focus()
          }}
          onChange={(event) => setInlineEditor((current) => current ? { ...current, value: event.target.value } : current)}
          onBlur={commitInlineEditor}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              commitInlineEditor()
            }
          }}
        />
      )}


      {!bridgeReady && (
        <p className="stage__empty" style={emptyInset}>
          {BRIDGE_STALE_MESSAGE}
        </p>
      )}
      {bridgeReady && !project && (
        <p className="stage__empty" style={emptyInset}>
          先新建一个项目，再把图片拖进来
        </p>
      )}
      {bridgeReady && project && !hasContent && !inlineEditor && !dragActive && status !== 'loading' && (
        <p className="stage__empty" style={emptyInset}>
          {[
            browserShortcut ? `按【${formatAccelerator(browserShortcut)}】打开站点` : '',
            smartCollectShortcut
              ? `拖动素材或按【${formatAccelerator(smartCollectShortcut)}】智能采集`
              : '拖动素材至画布'
          ]
            .filter(Boolean)
            .join('　')}
        </p>
      )}

      {notice && <Toast notice={notice} onDismiss={clearNotice} />}

      {dragActive && <div className="stage__dropzone">松开即可收进画布</div>}

      {searchConsent && (
        <div className="project-confirm-backdrop" role="presentation">
          <section
            className="project-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="image-search-consent-title"
          >
            <h2 id="image-search-consent-title">
              用{searchConsent.crop ? '框选的这一块' : '这张图'}去网上搜相似图？
            </h2>
            <p>
              图片会上传到 {IMAGE_SEARCH_LABELS[searchConsent.engineId]}，InsPin
              不会保存副本，也不会上传到自己的服务器。如果站点拒绝自动上传，图片会被复制到剪贴板，你可以自己在侧栏按 ⌘V 粘贴。
              {searchConsentDisclosure ? ` ${searchConsentDisclosure}` : ''}
            </p>
            <div className="project-confirm__actions">
              <button type="button" onClick={() => setSearchConsent(null)}>
                取消
              </button>
              <button type="button" onClick={() => void acceptSearchConsent()}>
                同意并继续
              </button>
            </div>
          </section>
        </div>
      )}

      {ready && (
        <CanvasControls
          zoom={zoomPercent(viewport.zoom)}
          canZoom={Boolean(project)}
          onZoomIn={() => commitViewport(zoomByStep(viewport, viewportSize(), 1))}
          onZoomOut={() => commitViewport(zoomByStep(viewport, viewportSize(), -1))}
          onFit={fitting}
          onSetZoom={(percent) =>
            commitViewport(
              zoomAt(viewport, percent / 100, {
                x: viewportSize().w / 2,
                y: viewportSize().h / 2
              })
            )
          }
        />
      )}
    </div>
  )
}

/** 当前看到的画布范围（世界坐标），用来看谁需要渲染。 */
function visibleWorldRect(viewport: Viewport, size: { w: number; h: number }): Rect {
  const topLeft = toWorld(viewport, { x: 0, y: 0 })
  const bottomRight = toWorld(viewport, { x: size.w, y: size.h })
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: Math.max(0, bottomRight.x - topLeft.x),
    h: Math.max(0, bottomRight.y - topLeft.y)
  }
}

function ShapeDraftPreview({ shape, rect, viewport }: { shape: CanvasShapeKind; rect: Rect; viewport: Viewport }): React.JSX.Element {
  const topLeft = toScreen(viewport, { x: rect.x, y: rect.y })
  const bottomRight = toScreen(viewport, { x: rect.x + rect.w, y: rect.y + rect.h })
  return (
    <div
      className={`shape-draft shape-draft--${shape}`}
      aria-hidden="true"
      style={{ left: topLeft.x, top: topLeft.y, width: Math.max(1, bottomRight.x - topLeft.x), height: Math.max(1, bottomRight.y - topLeft.y) }}
    />
  )
}
