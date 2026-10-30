import { create } from 'zustand'
import type { Command } from '../../../shared/command'
import { HistoryStack } from '../../../shared/history'
import type {
  AssetInfo,
  CaptureMode,
  CaptureStartResult,
  CutoutTarget,
  ImportResult,
  PasteContainerTarget,
  Viewport,
  WebDropRequest,
  WindowRect
} from '../../../shared/ipc'
import type { ProjectGraph } from '../../../shared/node'
import type { LibraryDragItem } from '../../../shared/local-library'
import { copyNodes, createPasteCommand, type NodeClipboard } from '../../../shared/node-clipboard'
import {
  BRIDGE_STALE_MESSAGE,
  browserBridge,
  canvasBridge,
  localLibraryBridge
} from '../bridge'
import { useProjectStore } from './projects'
import { useSelectionStore } from './selection'
import {
  describeCaptureImport,
  describeSmartCollection,
  describeClipboardImport,
  describeImport,
  describeWebImport,
  webImportFailureMessage
} from '../import-notice'
import { toast, type ToastNotice, type ToastTone } from '../toast'
import { useUiStore } from './ui'

/**
 * 界面侧的画布数据（路线图 D1.4）。
 *
 * 事实来源在主进程的数据库；这一份是它的投影。D1.4 只需要"读出来显示 + 导入后刷新"，
 * 真正的编辑（平移缩放、选中、拖动）走命令、属于 D2。
 */

export type GraphStatus = 'idle' | 'loading' | 'ready' | 'error'

interface GraphState {
  graph: ProjectGraph | null
  assets: Record<string, AssetInfo>
  /** 上次保存的视图位置；画布读到新项目时用它复位（D2.12） */
  viewport: Viewport
  /** 每成功读一次画布就 +1，画布据此知道"该按新视图复位了"（用户平移不该被覆盖） */
  loadToken: number
  status: GraphStatus
  error: string | null
  importing: boolean
  /** 画布工具条上方的统一操作反馈。 */
  notice: ToastNotice | null
  /** 连续智能采集每次落图后，画布应把新对象带到可见区域中央。 */
  captureFocus: { x: number; y: number } | null
  canUndo: boolean
  canRedo: boolean
  /** 剪贴板里存了几个最外层节点（0 = 没东西可粘）；粘贴按钮据此灰显 */
  clipboardCount: number
  /** 由画布持续记录的落点；不进 React 状态，避免移动鼠标时重渲染整张画布。 */
  setPasteTarget: (target: { x: number; y: number } | null) => void
  /** 粘贴落点所在的自动布局容器；没有就落回画布顶层。 */
  setPasteContainer: (target: PasteContainerTarget | null) => void
  load: (projectId: string | null) => Promise<void>
  /**
   * 原图被外部删除、主进程已清掉节点：当前项目在里面就重读画布。
   * 不重置视图位置（用户没换项目），但历史栈要换新起点——旧历史里还留着那些节点。
   */
  refreshAfterPrune: (projectIds: string[]) => Promise<void>
  importPaths: (projectId: string | null, paths: string[]) => Promise<ImportResult>
  importViaPicker: (projectId: string | null) => Promise<ImportResult>
  importClipboard: (projectId: string | null) => Promise<ImportResult>
  /** 从网页拖进来的图（D3.8–D3.11）：地址交给主进程二次下载，这里只管刷新画布 */
  importWeb: (projectId: string | null, request: WebDropRequest) => Promise<ImportResult>
  /** 从素材侧栏拖入：托管素材直接复用，外部文件先复制进 inspin素材。 */
  importLibraryItems: (
    projectId: string | null,
    items: LibraryDragItem[],
    at: { x: number; y: number }
  ) => Promise<ImportResult>
  /** Apple Vision 单主体抠图；结果作为新节点导回画布。 */
  cutout: (projectId: string | null, targets: CutoutTarget[]) => Promise<ImportResult>
  /** 区域截图（D3.16）：正在框选的那一屏；null = 没在框 */
  capture: CaptureScreen | null
  /** 正在冻结 / 不冻结之间切换；期间禁用开关，避免连续请求打架。 */
  captureSwitching: boolean
  startCapture: (mode?: CaptureMode) => Promise<void>
  cancelCapture: () => void
  /** 采集中切换冻结状态；下一次采集沿用这个选择。 */
  setCaptureFreeze: (freeze: boolean) => Promise<void>
  /** 框好了：交选框给主进程去裁，并收进项目（`center` = 放哪儿，用视口中心） */
  commitCapture: (
    selection: WindowRect,
    center: { x: number; y: number } | null,
    options?: { candidateId?: string | null; continuous?: boolean }
  ) => Promise<void>
  /** 执行一条编辑命令，并记进历史 */
  execute: (command: Command) => void
  /** 复制选中的节点（连同子孙）到内存剪贴板（D4a.7） */
  copy: (ids: string[]) => void
  /** 在原位置生成一份可立即拖动的副本；不改动用户的复制剪贴板。 */
  duplicate: (ids: string[]) => { ids: string[]; sourceIds: string[] } | null
  /** 粘贴剪贴板里的节点；返回新生成的顶层 id，供调用方选中它们 */
  paste: () => string[] | null
  undo: () => void
  redo: () => void
  setNotice: (notice: ToastNotice | string, tone?: ToastTone) => void
  clearNotice: () => void
}

const NO_PROJECT: ImportResult = { ok: false, message: '先新建一个项目，再把图片导入进来' }
const NO_BRIDGE: ImportResult = { ok: false, message: BRIDGE_STALE_MESSAGE }

/** 这次导入新增的节点 id（用前后两张图对比，批量导入也能拿到全部）。 */
function addedNodeIds(before: ProjectGraph | null, after: ProjectGraph): string[] {
  const old = before?.nodes ?? {}
  return Object.keys(after.nodes).filter((id) => !(id in old))
}

/**
 * 只改选中态的一步：画布图不变，撤销/重做时恢复前后的选中集。
 *
 * 选中集不在图里（SelectionStore 单独存），所以用一条"空命令"占住历史位置，
 * 让「点选对象」和真正的编辑动作按发生顺序排在同一条撤销链上。
 */
class SelectionStep implements Command {
  readonly name = 'selection'

  constructor(
    readonly from: string[],
    readonly to: string[]
  ) {}

  apply(graph: ProjectGraph): ProjectGraph {
    return graph
  }

  revert(graph: ProjectGraph): ProjectGraph {
    return graph
  }
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

/** 正在框选的那一屏（D3.16）：拿到的截图 + 它在窗口里的位置。 */
export type CaptureScreen = Extract<CaptureStartResult, { ok: true }>

/** 编辑后多久写库；拖动是连续动作，命令只在松手时提交一次，这里再攒一下 */
const SAVE_DEBOUNCE_MS = 400

/**
 * 当前图由历史栈推导（§1.2：只存命令，不存快照）。
 * 放在模块作用域而不是 store 里：它是命令式的对象，不需要参与 React 重渲染。
 */
let history: HistoryStack | null = null
let saveTimer: number | null = null
/** 最近一次有效的鼠标落点；画布在鼠标离开可见区域时写入摄像机中心。 */
let pasteTarget: { x: number; y: number } | null = null
/** 落点所在的自动布局容器；粘贴多张图时一并塞进去。 */
let pasteContainer: PasteContainerTarget | null = null
let saveProjectId: string | null = null

/** 内存剪贴板（D4a.7）：系统剪贴板已被"粘贴图片"占用，节点复制另存一份。 */
let clipboard: NodeClipboard | null = null

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID
  return typeof uuid === 'function'
    ? uuid.call(globalThis.crypto)
    : `n-${Math.random().toString(36).slice(2)}`
}

function cancelPendingSave(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
}

/** 导入是主进程直接改的库，界面这边把它当成新的历史起点（不做成可撤销命令）。 */
function adoptImportedGraph(projectId: string, graph: ProjectGraph): void {
  saveProjectId = projectId
  cancelPendingSave()
  history = new HistoryStack(graph)
  associatingSelection = null
  clearPendingSelectionRecord()
}

function scheduleSave(graph: ProjectGraph): void {
  if (!saveProjectId) return
  const projectId = saveProjectId
  cancelPendingSave()
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void canvasBridge()?.saveGraph(projectId, graph)
  }, SAVE_DEBOUNCE_MS)
}

/** 快速切换项目时，晚回来的旧请求不能覆盖新结果。 */
let loadToken = 0

export const useGraphStore = create<GraphState>((set, get) => ({
  graph: null,
  assets: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  loadToken: 0,
  status: 'idle',
  error: null,
  importing: false,
  notice: null,
  captureFocus: null,
  canUndo: false,
  canRedo: false,
  clipboardCount: 0,

  setPasteTarget(target) {
    pasteTarget = target
  },

  setPasteContainer(target) {
    pasteContainer = target
  },

  async load(projectId) {
    // 换项目就把内存剪贴板清掉：旧项目的节点粘到新项目里没有意义
    clipboard = null
    if (!projectId) {
      loadToken++
      saveProjectId = null
      cancelPendingSave()
      history = null
      clearPendingSelectionRecord()
      restoreSelection([])
      set({
        graph: null,
        assets: {},
        status: 'ready',
        error: null,
        canUndo: false,
        canRedo: false,
        clipboardCount: 0
      })
      return
    }
    const canvas = canvasBridge()
    if (!canvas) {
      set({ status: 'error', error: BRIDGE_STALE_MESSAGE })
      return
    }

    const token = ++loadToken
    set({ status: 'loading', error: null })
    try {
      const result = await canvas.load(projectId)
      if (token !== loadToken) return
      if (result.ok) {
        // 新读回来的图是新的历史起点（旧项目未落盘的编辑作废）
        saveProjectId = projectId
        cancelPendingSave()
        history = new HistoryStack(result.graph)
        associatingSelection = null
        clearPendingSelectionRecord()
        // 换画布时旧的选中没有意义，静默清掉，别让它变成新历史里的第一步
        restoreSelection([])
        set((state) => ({
          graph: result.graph,
          assets: result.assets,
          viewport: result.viewport,
          loadToken: state.loadToken + 1,
          status: 'ready',
          canUndo: false,
          canRedo: false,
          clipboardCount: 0
        }))
      } else {
        set({ status: 'error', error: result.message })
      }
    } catch (error) {
      if (token !== loadToken) return
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  },

  async refreshAfterPrune(projectIds) {
    const projectId = useProjectStore.getState().currentId
    if (!projectId || !projectIds.includes(projectId)) return
    const canvas = canvasBridge()
    if (!canvas) return

    const result = await canvas.load(projectId)
    // 请求回来前用户可能已经切走；晚到的旧项目结果不能盖掉新画布
    if (!result.ok || useProjectStore.getState().currentId !== projectId) return

    adoptImportedGraph(projectId, result.graph)
    set({ graph: result.graph, assets: result.assets })
  },

  async importPaths(projectId, paths) {
    if (!projectId) return NO_PROJECT
    const canvas = canvasBridge()
    if (!canvas) return NO_BRIDGE

    set({ importing: true, notice: toast('loading', '正在读取剪贴板') })
    try {
      const result = await canvas.importPaths(projectId, paths)
      if (result.ok) {
        adoptImportedGraph(projectId, result.graph)
        set({ graph: result.graph, assets: result.assets, notice: describeImport(result) })
      } else if (result.canceled) {
        set({ notice: null })
      } else {
        set({ notice: toast('error', result.message, { dismissible: true }) })
      }
      return result
    } finally {
      set({ importing: false })
    }
  },

  async importViaPicker(projectId) {
    if (!projectId) return NO_PROJECT
    const canvas = canvasBridge()
    if (!canvas) return NO_BRIDGE

    set({ importing: true, notice: toast('loading', '正在导入图片') })
    try {
      const result = await canvas.pickFiles(projectId)
      if (result.ok) {
        adoptImportedGraph(projectId, result.graph)
        set({ graph: result.graph, assets: result.assets, notice: describeImport(result) })
      } else if (result.canceled) {
        set({ notice: null })
      } else {
        set({ notice: toast('error', result.message, { dismissible: true }) })
      }
      return result
    } finally {
      set({ importing: false })
    }
  },

  async importClipboard(projectId) {
    if (!projectId) return NO_PROJECT
    const canvas = canvasBridge()
    if (!canvas) return NO_BRIDGE

    set({ importing: true, notice: toast('loading', '正在导入图片') })
    try {
      const result = await canvas.importClipboard(projectId, pasteTarget, pasteContainer)
      if (result.ok) {
        adoptImportedGraph(projectId, result.graph)
        set({
          graph: result.graph,
          assets: result.assets,
          notice: describeClipboardImport(result),
          canUndo: false,
          canRedo: false
        })
      } else if (result.canceled) {
        set({ notice: null })
      } else {
        set({ notice: toast('error', result.message, { dismissible: true }) })
      }
      return result
    } finally {
      set({ importing: false })
    }
  },

  async importWeb(projectId, request) {
    if (!projectId) return NO_PROJECT
    const canvas = canvasBridge()
    if (!canvas) return NO_BRIDGE

    set({ importing: true, notice: toast('loading', '正在收集图片') })
    try {
      const before = get().graph
      const result = await canvas.importWeb(projectId, request)
      if (result.ok) {
        // 从网页批量收下多张时，等指针回到画布一并选中
        const added = addedNodeIds(before, result.graph)
        if (added.length > 1) useSelectionStore.getState().setPending(added)
        adoptImportedGraph(projectId, result.graph)
        set({
          graph: result.graph,
          assets: result.assets,
          notice: describeWebImport(result, useUiStore.getState().shortcuts.smartCollect)
        })
      } else {
        set({
          notice: toast(
            'error',
            webImportFailureMessage(useUiStore.getState().shortcuts.smartCollect),
            { dismissible: true }
          )
        })
      }
      return result
    } finally {
      set({ importing: false })
    }
  },

  async importLibraryItems(projectId, items, at) {
    if (!projectId) return NO_PROJECT
    const api = localLibraryBridge()
    if (!api) return NO_BRIDGE
    const hasLinked = items.some((item) => item.kind === 'linked')
    set({
      importing: true,
      notice: toast(
        'loading',
        hasLinked ? (items.length > 1 ? `正在复制 ${items.length} 张到 inspin素材` : '正在复制到 inspin素材') : '正在放入画布'
      )
    })
    try {
      const result = await api.placeItems({ projectId, items, at })
      if (result.ok) {
        adoptImportedGraph(projectId, result.graph)
        const count = result.importedCount
        const failed = result.errors.length
        const message =
          failed > 0
            ? `已放入 ${count} 张，${failed} 张未成功`
            : hasLinked
              ? count > 1
                ? `已复制 ${count} 张到 inspin素材并放入画布`
                : '已复制到 inspin素材并放入画布'
              : count > 1
                ? `已放入画布 · ${count} 张`
                : '已放入画布'
        set({
          graph: result.graph,
          assets: result.assets,
          notice: toast(failed > 0 ? 'info' : 'success', message),
          canUndo: false,
          canRedo: false
        })
      } else {
        set({ notice: toast('error', result.message, { dismissible: true }) })
      }
      return result
    } finally {
      set({ importing: false })
    }
  },

  async cutout(projectId, targets) {
    if (!projectId) return NO_PROJECT
    const api = window.insPin?.cutout
    if (!api) return NO_BRIDGE

    set({ importing: true, notice: toast('loading', '正在抠出主体') })
    try {
      const result = await api.run(projectId, targets)
      if (result.ok) {
        adoptImportedGraph(projectId, result.graph)
        set({
          graph: result.graph,
          assets: result.assets,
          notice: toast('success', '已抠出主体，原图保留在旁边')
        })
      } else {
        set({ notice: toast('error', result.message, { dismissible: true }) })
      }
      return result
    } finally {
      set({ importing: false })
    }
  },

  capture: null,
  captureSwitching: false,

  async startCapture(mode = 'capture') {
    const api = browserBridge()
    if (!api) {
      set({ notice: toast('error', BRIDGE_STALE_MESSAGE, { dismissible: true }) })
      return
    }
    const result = await api.captureStart(mode)
    if (result.ok) set({ capture: result, captureFocus: null })
    else set({ notice: toast('error', result.message, { dismissible: true }) })
  },

  cancelCapture() {
    set({ capture: null, captureFocus: null, captureSwitching: false })
    void browserBridge()?.captureCancel()
  },

  async setCaptureFreeze(freeze) {
    const current = get().capture
    if (!current || current.mode !== 'collect' || get().captureSwitching) return
    if (current.live === !freeze) return
    if (get().importing) return
    const api = browserBridge()
    if (!api || typeof api.captureSwitch !== 'function') {
      set({ notice: toast('error', BRIDGE_STALE_MESSAGE, { dismissible: true }) })
      return
    }
    set({ captureSwitching: true })
    try {
      const result = await api.captureSwitch(freeze)
      // 切换期间用户可能已经退出采集；结果晚到时不要再把采集界面拉回来。
      if (get().capture !== current) return
      if (result.ok) {
        useUiStore.getState().setFreezeSmartCollection(freeze)
        set({ capture: result, captureFocus: null })
      } else {
        set({ notice: toast('error', result.message, { dismissible: true }) })
      }
    } finally {
      set({ captureSwitching: false })
    }
  },

  async commitCapture(selection, center, options) {
    const projectId = useProjectStore.getState().currentId
    const api = canvasBridge()
    if (!options?.continuous) set({ capture: null })
    if (!projectId || !api) {
      void browserBridge()?.captureCancel()
      set({ notice: toast('error', projectId ? BRIDGE_STALE_MESSAGE : NO_PROJECT.message, { dismissible: true }) })
      return
    }
    set({ importing: true })
    try {
      const result = await api.importCapture(projectId, {
        selection,
        center,
        candidateId: options?.candidateId ?? null,
        continuous: options?.continuous === true
      })
      if (result.ok) {
        adoptImportedGraph(projectId, result.graph)
        set({
          graph: result.graph,
          assets: result.assets,
          captureFocus:
            options?.continuous && result.importedNode
              ? {
                  x: result.importedNode.x + result.importedNode.width / 2,
                  y: result.importedNode.y + result.importedNode.height / 2
                }
              : null,
          notice: result.collectionKind ? describeSmartCollection(result) : describeCaptureImport(result)
        })
      } else {
        set({ notice: toast('error', result.message, { dismissible: true }) })
      }
    } finally {
      set({ importing: false })
    }
  },

  execute(command) {
    if (!history) return
    // 先把还没落栈的选中变化记下来，保证「先点选、再编辑」的撤销顺序
    flushPendingSelection()
    // 记下命令执行前的选中；紧接着的同步选中变化（如删除后清空选中）
    // 会补进同一条命令的 after，而不是再占一步
    const before = [...useSelectionStore.getState().ids]
    const graph = history.execute(command)
    selectionSnapshots.set(command, { before, after: before })
    associatingSelection = command
    queueMicrotask(() => {
      if (associatingSelection === command) associatingSelection = null
    })
    set({ graph, canUndo: history.canUndo, canRedo: history.canRedo })
    scheduleSave(graph)
  },

  copy(ids) {
    const graph = get().graph
    if (!graph) return
    const clip = copyNodes(graph, ids)
    if (!clip) return
    clipboard = clip
    set({ clipboardCount: clip.roots.length })
  },

  duplicate(ids) {
    const graph = get().graph
    if (!graph) return null
    const clip = copyNodes(graph, ids)
    if (!clip) return null

    const newIds = new Map<string, string>()
    for (const node of clip.nodes) newIds.set(node.id, randomId())
    const duplicateIds = clip.roots
      .map((id) => newIds.get(id))
      .filter((id): id is string => Boolean(id))

    // 拖拽复制要先与原件重合；接下来的指针移动才是它的真实位移。
    get().execute(createPasteCommand(graph, clip, { dx: 0, dy: 0, newIds }))
    return { ids: duplicateIds, sourceIds: clip.roots }
  },

  paste() {
    const graph = get().graph
    if (!graph || !clipboard) return null

    // 先把新 id 算好，粘完就能选中新出来的那几个
    const newIds = new Map<string, string>()
    for (const node of clipboard.nodes) newIds.set(node.id, randomId())
    const rootIds = clipboard.roots
      .map((id) => newIds.get(id))
      .filter((id): id is string => Boolean(id))

    get().execute(createPasteCommand(graph, clipboard, { newIds, center: pasteTarget }))
    return rootIds
  },

  undo() {
    if (!history) return
    flushPendingSelection()
    if (!history.canUndo) return
    const command = history.undoEntry()
    const graph = history.graph
    if (command instanceof SelectionStep) {
      restoreSelection(command.from)
    } else {
      // 回到命令执行前的选中；再清掉可能已不存在的 id，避免 CanvasStage
      // 的事后清理另记一步、把重做栈冲掉
      const snapshot = command ? selectionSnapshots.get(command) : undefined
      if (snapshot) restoreSelection(snapshot.before)
      pruneSelection(graph)
    }
    set({ graph, canUndo: history.canUndo, canRedo: history.canRedo })
    if (!(command instanceof SelectionStep)) scheduleSave(graph)
  },

  redo() {
    if (!history) return
    flushPendingSelection()
    if (!history.canRedo) return
    const command = history.redoEntry()
    const graph = history.graph
    if (command instanceof SelectionStep) {
      restoreSelection(command.to)
    } else {
      const snapshot = command ? selectionSnapshots.get(command) : undefined
      if (snapshot) restoreSelection(snapshot.after)
      pruneSelection(graph)
    }
    set({ graph, canUndo: history.canUndo, canRedo: history.canRedo })
    if (!(command instanceof SelectionStep)) scheduleSave(graph)
  },

  setNotice(notice, tone = 'info') {
    set({ notice: typeof notice === 'string' ? toast(tone, notice, tone === 'error' ? { dismissible: true } : {}) : notice })
  },

  clearNotice() {
    if (get().notice !== null) set({ notice: null })
  }
}))

/* ---------- 选中态也进撤销链 ---------- */

/** 撤销/重做、换画布时改选中不能反过来再记一步。 */
let selectionHistoryMuted = false
/** 上一次记录过的选中集，用来算出 SelectionStep 的 from。 */
let lastSelectionIds: string[] = []
/** 每条编辑命令执行前后的选中集，撤销/重做时一起恢复。 */
const selectionSnapshots = new WeakMap<Command, { before: string[]; after: string[] }>()
/** 刚刚执行的命令：同一拍里的选中变化算它的 after，不另起一步。 */
let associatingSelection: Command | null = null
/**
 * 框选会在一帧里连续改几十次选中，不能每次都记一步。
 * 连续变化先攒在这里，静默一小段时间后合并成一步。
 */
let pendingSelection: { from: string[]; to: string[] } | null = null
let selectionTimer: ReturnType<typeof setTimeout> | null = null
const SELECTION_FLUSH_MS = 180

/** 把攒着的选中变化落成一条历史步骤（编辑/撤销/重做前必须先调）。 */
function flushPendingSelection(): void {
  if (selectionTimer !== null) {
    clearTimeout(selectionTimer)
    selectionTimer = null
  }
  const pending = pendingSelection
  pendingSelection = null
  if (!pending || !history || sameIds(pending.from, pending.to)) return
  history.execute(new SelectionStep(pending.from, pending.to))
  useGraphStore.setState({ canUndo: history.canUndo, canRedo: history.canRedo })
}

/** 换画布 / 导入新图时丢掉还没落栈的选中变化。 */
function clearPendingSelectionRecord(): void {
  if (selectionTimer !== null) {
    clearTimeout(selectionTimer)
    selectionTimer = null
  }
  pendingSelection = null
}

/** 静默设置选中并同步基线。 */
function restoreSelection(ids: string[]): void {
  selectionHistoryMuted = true
  useSelectionStore.getState().set(ids)
  selectionHistoryMuted = false
  lastSelectionIds = [...ids]
}

/** 图变了之后把指向不存在节点的选中剪掉；静默处理，不动历史。 */
function pruneSelection(graph: ProjectGraph): void {
  const current = useSelectionStore.getState().ids
  const alive = current.filter((id) => Boolean(graph.nodes[id]))
  if (alive.length !== current.length) restoreSelection(alive)
}

/**
 * 用户每一次改变选中，都记一条只影响选中态的历史步骤。
 *
 * 和编辑命令共用同一个 HistoryStack，所以「先点选、再拖动」在撤销时是
 * 先退拖动、再退选中，顺序与操作一致。程序化的恢复（撤销/重做/换画布）
 * 通过 selectionHistoryMuted 跳过，不会自己叠步骤。
 */
useSelectionStore.subscribe((state) => {
  if (sameIds(state.ids, lastSelectionIds)) return
  const from = lastSelectionIds
  const to = state.ids
  lastSelectionIds = [...state.ids]
  if (selectionHistoryMuted || !history) return

  // 紧跟在编辑命令后面的选中变化（删除后清空、粘贴后选中新节点）并入那条命令
  if (associatingSelection) {
    const snapshot = selectionSnapshots.get(associatingSelection)
    if (snapshot) snapshot.after = [...state.ids]
    return
  }

  if (!pendingSelection) pendingSelection = { from, to: [...state.ids] }
  else pendingSelection.to = [...state.ids]
  if (selectionTimer !== null) clearTimeout(selectionTimer)
  selectionTimer = setTimeout(() => {
    selectionTimer = null
    flushPendingSelection()
  }, SELECTION_FLUSH_MS)
})
