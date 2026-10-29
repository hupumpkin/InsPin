import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { BaseWindow } from 'electron'
import {
  clampOpacity,
  clampZoom,
  fitZoomFor,
  snapshotWindowSize,
  type SnapshotContent,
  type SnapshotCreateResult,
  type SnapshotRecord,
  type SnapshotRefreshResult,
  type SnapshotView
} from '../shared/snapshot'
import { IpcChannel } from '../shared/ipc'
import { attachCrashRecovery, type CrashSource } from './crash-recovery'
import { LogEvent, type Logger } from './logger'

/**
 * 参考快照浮窗（路线图 D5.1–D5.7）。
 *
 * 这里管的是**窗口本身**：置顶、鼠标穿透、透明度、缩放、锁定、拖动、重启恢复。
 * 画什么由浮窗自己的渲染进程负责（它拿到的是一份冻结的内容，见 `shared/snapshot.ts`）。
 *
 * 三条来自手测/设计稿的讲究：
 *   1. **要能压住全屏的 Figma**：只 `setAlwaysOnTop` 不够，还得 `setVisibleOnAllWorkspaces(…,
 *      { visibleOnFullScreen: true })`，否则 Figma 一进全屏它就被甩到别的 Space 了；
 *   2. **拖动由主进程执行**：浮窗那边只报"指针在屏幕的哪儿"。不用
 *      `-webkit-app-region: drag` 是因为那块区域收不到右键事件，而右键菜单恰恰是
 *      浮窗唯一的操作入口；
 *   3. **窗口位置/透明度这些状态跟着记录一起落盘**，重启照着摆回来（D5.6）。
 */

export type SnapshotSourceResult =
  | { ok: true; content: SnapshotContent }
  | { ok: false; message: string }

export interface SnapshotManagerDeps {
  logger: Logger
  /** 浮窗用的 preload（与主窗口同一份） */
  preloadPath: string
  /** 开发时的渲染地址；生产走 snapshot.html */
  rendererUrl: string | null
  /** 主进程 bundle 所在目录，用来定位生产的 snapshot.html */
  mainDir: string
  /** 读一次源内容（创建与刷新共用） */
  readSource: (projectId: string, sourceIds: string[]) => SnapshotSourceResult
  /** 记录有变化就存一次（自检时是空操作） */
  persist: (records: SnapshotRecord[]) => void
  newId: () => string
  /** 主窗口；用它的所在显示器决定新浮窗摆哪儿 */
  window: () => BaseWindow | null
  now: () => string
  /** 自检：不恢复、不落盘（`persist` 由调用方决定要不要真写） */
  ephemeral?: boolean
  /** 条数变了（新建 / 关闭）；程序坞菜单要跟着决定显不显示兜底项 */
  onChange?: () => void
}

export interface SnapshotManager {
  create(projectId: unknown, sourceIds: unknown): SnapshotCreateResult
  /** 启动时把上次的快照摆回来 */
  restore(records: SnapshotRecord[]): void
  update(id: string, patch: unknown): SnapshotView | null
  refresh(id: string): SnapshotRefreshResult | null
  close(id: string): void
  view(id: string): SnapshotView | null
  /** webContents → 快照 id（钉住图与其右键菜单都靠它认人） */
  idForWebContents(webContentsId: number): string | null
  /** 浮窗发来的拖动；payload 形状不对就当没发生 */
  drag(id: string, payload: unknown): void
  /**
   * 指针是否停在浮窗右上角那排按钮上。
   *
   * 穿透开着时整扇窗都忽略鼠标，连自己的按钮也点不到；但 `forward: true` 会把
   * **移动**事件转给网页，所以能知道"指针正压在那排按钮上"，这时临时把穿透关掉，
   * 按钮就点得着了，移开再恢复。这样穿透不再是死路（不用非得去摸程序坞）。
   */
  hoverControls(id: string, over: boolean): void
  /** 浮窗右键：在当前指针位置弹操作菜单 */
  popupMenu(id: string): void
  /** 程序坞菜单的兜底：把所有浮窗解锁（锁定 = 钉住 + 穿透，解锁就把鼠标还回来） */
  unlockAll(): void
  /** 自检用：拿到某条快照的原生窗口（核对置顶、可见性、透明度这些只能读回来的属性） */
  windowOf(id: string): BrowserWindow | null
  /** 自检用：右键设置菜单是独立窗口，不能随钉住图缩放。 */
  menuWindowOf(id: string): BrowserWindow | null
  count(): number
  /**
   * 所有浮窗里冻结的素材 id。素材清理必须把它们当成“仍在用”，
   * 否则快照过了保留期就会只剩占位块。
   */
  referencedAssetIds(): string[]
  dispose(): void
}

interface Entry {
  record: SnapshotRecord
  win: BrowserWindow
  /** 右键设置菜单是另一扇固定大小的浮窗，绝不能随着参考图缩放。 */
  menu: BrowserWindow | null
  /** 拖动中记着"指针按在窗口里的哪个位置"，好让窗口跟着指针走 */
  drag: { offsetX: number; offsetY: number } | null
  /**
   * 是**用户**关掉的吗？
   *
   * 只有用户从菜单点"关闭快照"才算。退出应用时窗口也会收到 closed，但那不是
   * "这条快照不要了"——不区分的话，退出会把空列表写回 `snapshots.json`，
   * 下次启动什么也恢复不出来（D5.6 等于没做）。踩过一次，别再合并这两种情况。
   *
   * 用"每条记录各记一个标记"而不是"整个管理器一个标志"，是因为退出时窗口的
   * closed 事件**早于** `will-quit`：等到那时再立旗已经来不及了。
   */
  userClosed: boolean
  /** 指针是否正压在那排按钮上（穿透开着时要临时放行鼠标，见 SnapshotManager.hoverControls） */
  hovering: boolean
}

const CASCADE_STEP = 28
const EDGE_MARGIN = 40

// 设计规范 2.3.9 / 42:2953：221 × 128，pad 8，两行 36 高滑杆 + 28 高按钮行。
const MENU_WIDTH = 221
const MENU_HEIGHT = 128

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function createSnapshotManager(deps: SnapshotManagerDeps): SnapshotManager {
  const entries = new Map<string, Entry>()
  /** 分帧恢复还没开完的窗口；退出时取消，免得在收尾阶段继续建窗 */
  let restoreTimer: ReturnType<typeof setTimeout> | null = null

  const viewOf = (entry: Entry): SnapshotView => ({
    id: entry.record.id,
    content: entry.record.content,
    opacity: entry.record.opacity,
    zoom: entry.record.zoom,
    locked: entry.record.locked
  })

  const records = (): SnapshotRecord[] => [...entries.values()].map((entry) => entry.record)

  const persist = (): void => {
    if (deps.ephemeral) return
    deps.persist(records())
  }

  const sendToEntry = (entry: Entry, channel: string, payload: unknown): void => {
    if (!entry.win.isDestroyed()) entry.win.webContents.send(channel, payload)
    if (entry.menu && !entry.menu.isDestroyed()) entry.menu.webContents.send(channel, payload)
  }

  const push = (entry: Entry): void => {
    sendToEntry(entry, IpcChannel.snapshotChanged, viewOf(entry))
  }

  /** 给浮窗说一句话（刷新成没成）。刷新入口在右键菜单里，所以结果只能这样回去。 */
  const notify = (entry: Entry, message: string): void => {
    sendToEntry(entry, IpcChannel.snapshotNotice, message)
  }

  /** 内容太大时先缩到一个能看的尺寸，别一上来就糊满屏幕。 */
  function initialZoom(content: SnapshotContent): number {
    return fitZoomFor({ width: content.width, height: content.height })
  }

  function displayArea(): Electron.Rectangle {
    const parent = deps.window()
    const display = parent
      ? screen.getDisplayMatching(parent.getBounds())
      : screen.getPrimaryDisplay()
    return display.workArea
  }

  function clampToArea(x: number, y: number, size: { width: number; height: number }): {
    x: number
    y: number
  } {
    const area = displayArea()
    return {
      x: Math.min(Math.max(area.x, x), area.x + Math.max(0, area.width - size.width)),
      y: Math.min(Math.max(area.y, y), area.y + Math.max(0, area.height - size.height))
    }
  }

  function place(entry: Entry): void {
    const size = snapshotWindowSize(entry.record.content, entry.record.zoom)
    const at = clampToArea(entry.record.x, entry.record.y, size)
    entry.record.x = at.x
    entry.record.y = at.y
    entry.win.setPosition(at.x, at.y)
  }

  /**
   * 把"是否忽略鼠标"落到窗口上。
   *
   * **锁定 = 钉住位置 + 鼠标穿透**（用户定的：这两件事当一件）。
   * 只有"锁着、且指针不在按钮上"时才真正忽略——指针压到那排按钮上就放行，
   * 否则一锁定连解锁的按钮都点不到（`forward: true` 保证指针移开时能收到事件）。
   */
  function applyIgnore(entry: Entry): void {
    if (entry.win.isDestroyed()) return
    const ignore = entry.record.locked && !entry.hovering
    entry.win.setIgnoreMouseEvents(ignore, { forward: true })
  }

  function applyGeometry(entry: Entry): void {
    const size = snapshotWindowSize(entry.record.content, entry.record.zoom)
    entry.win.setContentSize(size.width, size.height)
  }

  function loadPage(win: BrowserWindow): void {
    if (deps.rendererUrl) {
      const base = deps.rendererUrl.replace(/\/+$/, '')
      void win.loadURL(`${base}/snapshot.html`)
    } else {
      void win.loadFile(join(deps.mainDir, '../renderer/snapshot.html'))
    }
  }

  function loadMenuPage(win: BrowserWindow): void {
    if (deps.rendererUrl) {
      const base = deps.rendererUrl.replace(/\/+$/, '')
      void win.loadURL(`${base}/snapshot-menu.html`)
    } else {
      void win.loadFile(join(deps.mainDir, '../renderer/snapshot-menu.html'))
    }
  }

  function closeMenu(entry: Entry): void {
    const menu = entry.menu
    entry.menu = null
    if (menu && !menu.isDestroyed()) menu.close()
  }

  function openMenu(entry: Entry): void {
    closeMenu(entry)
    const cursor = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(cursor).workArea
    const x = Math.max(area.x, Math.min(cursor.x + 8, area.x + area.width - MENU_WIDTH))
    const y = Math.max(area.y, Math.min(cursor.y + 8, area.y + area.height - MENU_HEIGHT))
    const menu = new BrowserWindow({
      width: MENU_WIDTH,
      height: MENU_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    entry.menu = menu
    menu.setAlwaysOnTop(true, 'screen-saver')
    menu.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    menu.once('ready-to-show', () => menu.show())
    menu.on('blur', () => closeMenu(entry))
    menu.on('closed', () => {
      if (entry.menu === menu) entry.menu = null
    })
    loadMenuPage(menu)
  }

  function openWindow(record: SnapshotRecord): Entry {
    const size = snapshotWindowSize(record.content, record.zoom)
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: record.x,
      y: record.y,
      frame: false,
      transparent: true,
      // 透明 PNG 要真的透：留白的话，图的透明区域会被这层白挡掉
      backgroundColor: '#00000000',
      hasShadow: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    // 全屏的 Figma 是另一个 Space：不显式声明，浮窗会被甩走（验收里"Figma 前台时仍可见"）
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setFullScreenable(false)
    win.setOpacity(record.opacity)
    // 浮窗的渲染进程崩了就把这一页重新载回来（内容冻在主进程里，重载不会丢东西）
    attachCrashRecovery(win.webContents as unknown as CrashSource, {
      label: '参考快照',
      logger: deps.logger,
      reload: () => {
        if (!win.isDestroyed()) loadPage(win)
      }
    })

    const entry: Entry = { record, win, menu: null, drag: null, userClosed: false, hovering: false }
    entries.set(record.id, entry)
    applyIgnore(entry)

    win.once('ready-to-show', () => {
      place(entry)
      // 不抢焦点：用户多半正待在别的应用里（Figma）
      win.showInactive()
    })

    win.on('closed', () => {
      const gone = entries.get(record.id)
      if (gone?.win !== win) return
      closeMenu(gone)
      entries.delete(record.id)
      // 退出应用时窗口也会走到这里，但那不是"这条快照不要了"（见 Entry.userClosed）
      if (!gone.userClosed) return
      deps.logger.info(LogEvent.snapshotClosed, { snapshotId: record.id })
      persist()
      deps.onChange?.()
    })

    loadPage(win)
    return entry
  }

  function create(projectId: unknown, sourceIds: unknown): SnapshotCreateResult {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return { ok: false, message: '先选一个项目' }
    }
    const ids = Array.isArray(sourceIds)
      ? sourceIds.filter((id): id is string => typeof id === 'string')
      : []
    if (ids.length === 0) {
      return { ok: false, message: '先选中要放进快照的对象' }
    }

    const source = deps.readSource(projectId, ids)
    if (!source.ok) {
      deps.logger.error(LogEvent.snapshotCreateFailed, { projectId, count: ids.length, message: source.message })
      return { ok: false, message: source.message }
    }

    const size = snapshotWindowSize(source.content, 1)
    const at = clampToArea(
      displayArea().x + displayArea().width - size.width - EDGE_MARGIN,
      displayArea().y + EDGE_MARGIN + (entries.size % 8) * CASCADE_STEP,
      size
    )

    const record: SnapshotRecord = {
      id: deps.newId(),
      projectId,
      sourceIds: ids,
      content: source.content,
      x: at.x,
      y: at.y,
      opacity: 1,
      zoom: initialZoom(source.content),
      locked: false,
      createdAt: deps.now()
    }

    openWindow(record)
    deps.logger.info(LogEvent.snapshotCreated, {
      snapshotId: record.id,
      projectId,
      count: ids.length,
      width: record.content.width,
      height: record.content.height,
      missing: record.content.missing.length
    })
    persist()
    deps.onChange?.()
    return { ok: true, id: record.id }
  }

  function restore(list: SnapshotRecord[]): void {
    const pending = list.filter((record) => !entries.has(record.id))
    if (pending.length === 0) return

    // 分帧创建：一次恢复几十扇窗会在同一个事件循环里连续建窗口 + 起渲染进程，
    // 启动那一下会明显卡住。先开第一扇，后面的每个事件循环补一扇。
    const openAt = (index: number): void => {
      restoreTimer = null
      const record = pending[index]
      if (!record) return
      // 分帧期间可能又有同样的记录被打开（例如用户在启动瞬间点了恢复）
      if (!entries.has(record.id)) {
        openWindow(record)
        deps.logger.info(LogEvent.snapshotRestored, {
          snapshotId: record.id,
          missing: record.content.missing.length
        })
      }
      if (index + 1 < pending.length) restoreTimer = setTimeout(() => openAt(index + 1), 0)
    }
    openAt(0)
    deps.onChange?.()
  }

  const manager: SnapshotManager = {
    create,
    restore,

    update(id, patch) {
      const entry = entries.get(id)
      if (!entry || typeof patch !== 'object' || patch === null) return null
      const input = patch as Record<string, unknown>

      if (typeof input['opacity'] === 'number') {
        entry.record.opacity = clampOpacity(input['opacity'])
        if (!entry.win.isDestroyed()) entry.win.setOpacity(entry.record.opacity)
      }
      if (typeof input['zoom'] === 'number') {
        // 缩放要围绕快照当前的视觉中心，而不是只改右下角尺寸。否则贴在屏幕边缘的
        // 快照每拖一格滑杆就会被 clampToArea 推走，用户看到的就是“比例乱飘”。
        const previousSize = snapshotWindowSize(entry.record.content, entry.record.zoom)
        const center = {
          x: entry.record.x + previousSize.width / 2,
          y: entry.record.y + previousSize.height / 2
        }
        entry.record.zoom = clampZoom(input['zoom'])
        const nextSize = snapshotWindowSize(entry.record.content, entry.record.zoom)
        entry.record.x = Math.round(center.x - nextSize.width / 2)
        entry.record.y = Math.round(center.y - nextSize.height / 2)
        applyGeometry(entry)
        place(entry)
      }
      if (typeof input['locked'] === 'boolean') {
        entry.record.locked = input['locked']
        applyIgnore(entry)
      }
      push(entry)
      persist()
      return viewOf(entry)
    },

    refresh(id) {
      const entry = entries.get(id)
      if (!entry) return null
      const projectId = entry.record.projectId
      if (!projectId) return { ok: false, message: '这条快照没有关联的项目，刷新不了' }

      const source = deps.readSource(projectId, entry.record.sourceIds)
      if (!source.ok) {
        // 保留原来那张：刷新失败不该让用户连旧的参考都看没了
        notify(entry, `没能刷新：${source.message}`)
        return { ok: false, message: source.message }
      }

      entry.record.content = source.content
      applyGeometry(entry)
      place(entry)
      push(entry)
      persist()
      notify(entry, '已刷新')
      deps.logger.info(LogEvent.snapshotRefreshed, {
        snapshotId: id,
        width: source.content.width,
        height: source.content.height,
        missing: source.content.missing.length
      })
      return { ok: true, view: viewOf(entry) }
    },

    close(id) {
      const entry = entries.get(id)
      if (!entry) return
      // 先立旗：closed 回调据此知道这是用户关的，该把这条从盘里去掉（见 Entry.userClosed）
      entry.userClosed = true
      closeMenu(entry)
      if (entry.win.isDestroyed()) {
        entries.delete(id)
        persist()
        deps.onChange?.()
        return
      }
      entry.win.close()
    },

    view(id) {
      const entry = entries.get(id)
      return entry ? viewOf(entry) : null
    },

    idForWebContents(webContentsId) {
      for (const [id, entry] of entries) {
        if (!entry.win.isDestroyed() && entry.win.webContents.id === webContentsId) return id
        if (entry.menu && !entry.menu.isDestroyed() && entry.menu.webContents.id === webContentsId) return id
      }
      return null
    },

    drag(id, payload) {
      const entry = entries.get(id)
      if (!entry || entry.record.locked || typeof payload !== 'object' || payload === null) return
      const input = payload as Record<string, unknown>
      const phase = input['phase']

      if (phase === 'start') {
        entry.drag = {
          offsetX: numberOr(input['offsetX'], 0),
          offsetY: numberOr(input['offsetY'], 0)
        }
        return
      }
      if (phase === 'move' && entry.drag) {
        const x = Math.round(numberOr(input['screenX'], entry.record.x) - entry.drag.offsetX)
        const y = Math.round(numberOr(input['screenY'], entry.record.y) - entry.drag.offsetY)
        entry.record.x = x
        entry.record.y = y
        if (!entry.win.isDestroyed()) entry.win.setPosition(x, y)
        return
      }
      if (phase === 'end') {
        if (entry.drag) {
          entry.drag = null
          persist()
        }
      }
    },

    hoverControls(id, over) {
      const entry = entries.get(id)
      if (!entry) return
      if (entry.hovering === over) return
      entry.hovering = over
      applyIgnore(entry)
    },

    popupMenu(id) {
      const entry = entries.get(id)
      if (!entry || entry.win.isDestroyed()) return
      openMenu(entry)
    },

    unlockAll() {
      for (const entry of entries.values()) {
        entry.record.locked = false
        applyIgnore(entry)
        push(entry)
      }
      persist()
    },

    windowOf(id) {
      const entry = entries.get(id)
      return entry && !entry.win.isDestroyed() ? entry.win : null
    },

    menuWindowOf(id) {
      const menu = entries.get(id)?.menu
      return menu && !menu.isDestroyed() ? menu : null
    },

    count() {
      return entries.size
    },

    referencedAssetIds() {
      const ids = new Set<string>()
      for (const entry of entries.values()) {
        for (const id of Object.keys(entry.record.content.assets)) ids.add(id)
        for (const layer of entry.record.content.layers) {
          if (layer.assetId) ids.add(layer.assetId)
        }
      }
      return [...ids]
    },

    dispose() {
      if (restoreTimer !== null) {
        clearTimeout(restoreTimer)
        restoreTimer = null
      }
      // 这里只销毁窗口、**不落盘**：条目都没被标成 userClosed，closed 回调不会写盘，
      // 记录因此原样留在 snapshots.json 里，下次启动照着摆回来
      for (const entry of entries.values()) {
        closeMenu(entry)
        if (!entry.win.isDestroyed()) entry.win.destroy()
      }
      entries.clear()
    }
  }

  return manager
}
