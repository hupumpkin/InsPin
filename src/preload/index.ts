import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { assetUrlFor, linkedAssetUrlFor, linkedThumbUrlFor, thumbUrlFor } from '../shared/asset-url'
import type { BrowserFavorite, BrowserState } from '../shared/browser'
import type { ProjectGraph } from '../shared/node'
import type { PanelLayout, PanelPatch } from '../shared/panel'
import type {
  SnapshotCreateResult,
  SnapshotDragPayload,
  SnapshotPatch,
  SnapshotRefreshResult,
  SnapshotView
} from '../shared/snapshot'
import type {
  AppDataInfo,
  HealthReport,
  LibraryUsage,
  MaintenanceResult
} from '../shared/maintenance'
import type { AppSettings } from '../shared/settings'
import type {
  ImageSearchCatalogItem,
  ImageSearchCollectLayout,
  ImageSearchProgress,
  ImageSearchStartRequest,
  ImageSearchStartResult
} from '../shared/image-search'
import {
  IpcChannel,
  type BrowserCommand,
  type CanvasLoadResult,
  type AssetsPrunedNotice,
  type CopyImageItem,
  type CopyImagesOptions,
  type CopyImagesResult,
  type CutoutCapability,
  type CutoutTarget,
  type CreateProjectResult,
  type DeleteProjectResult,
  type ImportResult,
  type PasteContainerTarget,
  type ProjectSummary,
  type RenameProjectResult,
  type CaptureCommit,
  type CaptureMode,
  type CaptureStartResult,
  type SmartCollectionPick,
  type RendererErrorPayload,
  type SettingsTab,
  type Viewport,
  type WebDropRequest
} from '../shared/ipc'
import type {
  LibraryDragItem,
  LibraryResult,
  LinkedFolderListing,
  LinkedFolderSummary,
  LocalLibraryState,
  PlaceLibraryItemsRequest,
  TrashLibraryAssetsResult
} from '../shared/local-library'

// 最小权限桥：只暴露渲染进程真正需要的东西，绝不暴露 ipcRenderer 本身。
contextBridge.exposeInMainWorld('insPin', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  /** 用系统默认浏览器打开外部链接 */
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke(IpcChannel.appOpenExternal, url)
  },
  /** 界面上没接住的异常交给主进程记进日志 */
  reportError(payload: RendererErrorPayload): void {
    ipcRenderer.send(IpcChannel.rendererError, {
      message: String(payload.message),
      stack: payload.stack,
      source: payload.source
    })
  },
  projects: {
    /** 列出全部项目，最近改动的在前 */
    list(): Promise<ProjectSummary[]> {
      return ipcRenderer.invoke(IpcChannel.projectsList)
    },
    /** 新建项目；名字不合法时返回 ok:false，不抛异常 */
    create(name: string): Promise<CreateProjectResult> {
      return ipcRenderer.invoke(IpcChannel.projectsCreate, name)
    },
    rename(id: string, name: string): Promise<RenameProjectResult> {
      return ipcRenderer.invoke(IpcChannel.projectsRename, id, name)
    },
    delete(id: string): Promise<DeleteProjectResult> {
      return ipcRenderer.invoke(IpcChannel.projectsDelete, id)
    },
    /** 告诉主进程"当前在用哪个项目"，只用于日志，不等回执 */
    notifySwitched(project: { id: string; name: string }): void {
      ipcRenderer.send(IpcChannel.projectsSwitched, { id: project.id, name: project.name })
    }
  },
  canvas: {
    /** 读出某个项目的整张画布（节点 + 用到的素材信息） */
    load(projectId: string): Promise<CanvasLoadResult> {
      return ipcRenderer.invoke(IpcChannel.canvasLoad, projectId)
    },
    /** 按本地文件路径导入图片（拖入系统文件用这条） */
    importPaths(projectId: string, paths: string[]): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.assetsImportPaths, projectId, paths)
    },
    /** 打开系统文件选择器导入图片 */
    pickFiles(projectId: string): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.assetsPickFiles, projectId)
    },
    /** 把剪贴板里的图片导入（⌘V）；可指定落进哪个自动布局容器。 */
    importClipboard(
      projectId: string,
      center?: { x: number; y: number } | null,
      target?: PasteContainerTarget | null
    ): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.assetsImportClipboard, projectId, center, target)
    },
    /** 把从网页拖进来的图片收进项目（D3.8–D3.11）：只有地址，主进程负责二次下载 */
    importWeb(projectId: string, request: WebDropRequest): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.assetsImportWeb, projectId, request)
    },
    /** 按框选把那张截图裁下来收进项目（D3.16） */
    importCapture(projectId: string, commit: CaptureCommit): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.assetsImportCapture, projectId, commit)
    },
    /** 素材文件名 → 原图地址（自定义协议，不含本机路径） */
    assetUrl(fileName: string): string {
      return assetUrlFor(fileName)
    },
    /** 素材文件名 → 缩略图地址；先加载它、再换原图，就是"渐进加载" */
    thumbUrl(fileName: string): string {
      return thumbUrlFor(fileName)
    },
    /** 记录视图位置（界面侧防抖后调用） */
    saveViewport(projectId: string, viewport: Viewport): Promise<void> {
      return ipcRenderer.invoke(IpcChannel.canvasSaveViewport, projectId, viewport)
    },
    /** 把编辑后的整张画布写回库（界面侧防抖后调用） */
    saveGraph(projectId: string, graph: ProjectGraph): Promise<boolean> {
      return ipcRenderer.invoke(IpcChannel.canvasApplyGraph, projectId, graph)
    },
    /** 取系统拖入文件的真实路径；网页里拖来的 File 没有路径，返回空串 */
    pathOf(file: File): string {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    /** 把选中的素材复制到系统剪贴板，供 Figma / Eagle / Relay 等软件粘贴 */
    copyImages(items: CopyImageItem[], options: CopyImagesOptions): Promise<CopyImagesResult> {
      return ipcRenderer.invoke(IpcChannel.canvasCopyImages, items, options)
    },
    /** 让 Finder 选中这张素材原文件。 */
    revealAsset(fileName: string): Promise<boolean> {
      return ipcRenderer.invoke(IpcChannel.canvasRevealAsset, fileName)
    },
    /** 订阅"原图被外部删了、库里已清理"的通知；返回取消订阅的函数。 */
    onAssetsPruned(listener: (notice: AssetsPrunedNotice) => void): () => void {
      const handler = (_event: unknown, notice: AssetsPrunedNotice): void => listener(notice)
      ipcRenderer.on(IpcChannel.assetsPruned, handler)
      return () => ipcRenderer.removeListener(IpcChannel.assetsPruned, handler)
    }
  },
  localLibrary: {
    getState(): Promise<LocalLibraryState> {
      return ipcRenderer.invoke(IpcChannel.libraryGetState)
    },
    linkFolder(): Promise<LibraryResult<LinkedFolderSummary>> {
      return ipcRenderer.invoke(IpcChannel.libraryLinkFolder)
    },
    unlinkFolder(id: string): Promise<boolean> {
      return ipcRenderer.invoke(IpcChannel.libraryUnlinkFolder, id)
    },
    listFolder(id: string): Promise<LibraryResult<LinkedFolderListing>> {
      return ipcRenderer.invoke(IpcChannel.libraryListFolder, id)
    },
    placeItems(request: PlaceLibraryItemsRequest): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.libraryPlaceItems, request)
    },
    trashAssets(assetIds: string[]): Promise<TrashLibraryAssetsResult> {
      return ipcRenderer.invoke(IpcChannel.libraryTrashAssets, assetIds)
    },
    restoreAssets(assetIds: string[]): Promise<number> {
      return ipcRenderer.invoke(IpcChannel.libraryRestoreAssets, assetIds)
    },
    revealLinkedAsset(folderId: string, relativePath: string): Promise<boolean> {
      return ipcRenderer.invoke(IpcChannel.libraryRevealLinked, folderId, relativePath)
    },
    linkedAssetUrl(folderId: string, relativePath: string): string {
      return linkedAssetUrlFor(folderId, relativePath)
    },
    linkedThumbUrl(folderId: string, relativePath: string): string {
      return linkedThumbUrlFor(folderId, relativePath)
    },
    dragPayload(item: LibraryDragItem): string {
      return JSON.stringify(item)
    }
  },
  /** Apple Vision 单主体抠图；能力探测与执行分开，旧系统不会露出入口。 */
  cutout: {
    capability(): Promise<CutoutCapability> {
      return ipcRenderer.invoke(IpcChannel.cutoutCapability)
    },
    run(projectId: string, targets: CutoutTarget[]): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.cutoutRun, projectId, targets)
    }
  },
  /** 浏览器标签（D3.1–D3.4）。网页本身由主进程的视图渲染，界面只画 chrome。 */
  browser: {
    getState(): Promise<BrowserState> {
      return ipcRenderer.invoke(IpcChannel.browserGetState)
    },
    newTab(url?: string): Promise<BrowserState> {
      return ipcRenderer.invoke(IpcChannel.browserNewTab, url)
    },
    closeTab(id: string): Promise<BrowserState> {
      return ipcRenderer.invoke(IpcChannel.browserCloseTab, id)
    },
    activateTab(id: string): Promise<BrowserState> {
      return ipcRenderer.invoke(IpcChannel.browserActivateTab, id)
    },
    moveTab(id: string, to: number): Promise<BrowserState> {
      return ipcRenderer.invoke(IpcChannel.browserMoveTab, id, to)
    },
    navigate(id: string, url: string): Promise<BrowserState> {
      return ipcRenderer.invoke(IpcChannel.browserNavigate, id, url)
    },
    command(id: string, command: BrowserCommand): Promise<BrowserState> {
      return ipcRenderer.invoke(IpcChannel.browserCommand, id, command)
    },
    /**
     * 改面板：收起/展开、停靠左/右/浮动、拖分栏线后的新宽度（D3.5–D3.7）。
     * 主进程是几何权威，改完把**算好的布局**回给界面。
     */
    setPanel(patch: PanelPatch): Promise<PanelLayout> {
      return ipcRenderer.invoke(IpcChannel.browserSetPanel, patch)
    },
    /** 读一次当前面板布局（界面首帧与主进程对齐用）。 */
    getPanel(): Promise<PanelLayout> {
      return ipcRenderer.invoke(IpcChannel.browserGetPanel)
    },
    /** 收藏当前网页到起始页的推荐站点。 */
    addFavorite(favorite: BrowserFavorite): Promise<boolean> {
      return ipcRenderer.invoke(IpcChannel.browserAddFavorite, favorite)
    },
    /** 取消收藏：从起始页推荐站点里移除这个网址。 */
    removeFavorite(url: string): Promise<boolean> {
      return ipcRenderer.invoke(IpcChannel.browserRemoveFavorite, url)
    },
    /** 起始页推荐站点的网址列表。 */
    getFavoriteUrls(): Promise<string[]> {
      return ipcRenderer.invoke(IpcChannel.browserGetFavoriteUrls)
    },
    /** 拖分栏线的逐帧预览：不等回执，主进程只挪原生视图 */
    previewPanel(width: number): void {
      ipcRenderer.send(IpcChannel.browserPanelPreview, width)
    },
    hidePanelImmediately(): Promise<PanelLayout> {
      return ipcRenderer.invoke(IpcChannel.browserPanelHideImmediate)
    },
    /** 设置这类全窗浮层打开时，临时让原生网页让位；不改变面板开合偏好。 */
    setCovered(covered: boolean): void {
      ipcRenderer.send(IpcChannel.browserSetCovered, covered)
    },
    /** 区域截图：抓一张浏览区并把原生视图藏起来，让界面那层截图露出来框选（D3.16） */
    captureStart(mode: CaptureMode = 'capture'): Promise<CaptureStartResult> {
      return ipcRenderer.invoke(IpcChannel.browserCaptureStart, mode)
    },
    /** 放弃这次框选，把原生视图放回来 */
    captureCancel(): Promise<void> {
      return ipcRenderer.invoke(IpcChannel.browserCaptureCancel)
    },
    onSmartCollectPicked(listener: (pick: SmartCollectionPick) => void): () => void {
      const handler = (_event: unknown, pick: SmartCollectionPick): void => listener(pick)
      ipcRenderer.on(IpcChannel.browserSmartCollectPicked, handler)
      return () => ipcRenderer.removeListener(IpcChannel.browserSmartCollectPicked, handler)
    },
    /** 订阅状态变化；返回取消订阅的函数。 */
    onStateChanged(listener: (state: BrowserState) => void): () => void {
      const handler = (_event: unknown, state: BrowserState): void => listener(state)
      ipcRenderer.on(IpcChannel.browserStateChanged, handler)
      return () => ipcRenderer.removeListener(IpcChannel.browserStateChanged, handler)
    },
    /** 订阅面板布局变化（窗口缩放降级、停靠切换、宽度变化）；返回取消订阅的函数。 */
    onPanelChanged(listener: (layout: PanelLayout) => void): () => void {
      const handler = (_event: unknown, layout: PanelLayout): void => listener(layout)
      ipcRenderer.on(IpcChannel.browserPanelChanged, handler)
      return () => ipcRenderer.removeListener(IpcChannel.browserPanelChanged, handler)
    },
    /** 网页有焦点时按下智能采集快捷键，主进程转给画布处理。 */
    onSmartCollectRequested(listener: () => void): () => void {
      const handler = (): void => listener()
      ipcRenderer.on(IpcChannel.browserSmartCollectRequested, handler)
      return () => ipcRenderer.removeListener(IpcChannel.browserSmartCollectRequested, handler)
    },
    /** 网页里按 Esc 退出了采集，界面要把采集状态清掉。 */
    onCaptureEnded(listener: () => void): () => void {
      const handler = (): void => listener()
      ipcRenderer.on(IpcChannel.browserCaptureEnded, handler)
      return () => ipcRenderer.removeListener(IpcChannel.browserCaptureEnded, handler)
    }
  },
  /** 以图搜图：只接收素材文件名，磁盘路径由主进程解析。 */
  imageSearch: {
    catalog(): Promise<ImageSearchCatalogItem[]> {
      return ipcRenderer.invoke(IpcChannel.imageSearchCatalog)
    },
    start(request: ImageSearchStartRequest): Promise<ImageSearchStartResult> {
      return ipcRenderer.invoke(IpcChannel.imageSearchStart, request)
    },
    cancel(): Promise<void> {
      return ipcRenderer.invoke(IpcChannel.imageSearchCancel)
    },
    /** 主进程推来「搜索走到哪一步」，界面据此换提示文案 */
    onProgress(listener: (progress: ImageSearchProgress) => void): () => void {
      const handler = (_event: unknown, progress: ImageSearchProgress): void => listener(progress)
      ipcRenderer.on(IpcChannel.imageSearchProgress, handler)
      return () => ipcRenderer.removeListener(IpcChannel.imageSearchProgress, handler)
    },
    /** 用户确认「图片会上传到第三方」后调用一次 */
    acceptConsent(): Promise<AppSettings> {
      return ipcRenderer.invoke(IpcChannel.imageSearchAcceptConsent)
    },
    /** 把结果页当前可见的大图批量收进画布 */
    collect(projectId: string, layout?: ImageSearchCollectLayout): Promise<ImportResult> {
      return ipcRenderer.invoke(IpcChannel.imageSearchCollect, projectId, layout)
    }
  },
  /** 设置：程序坞右键菜单 / 应用菜单点进来时，主进程让界面把设置面板打开。 */
  settings: {
    onOpen(listener: (tab: SettingsTab) => void): () => void {
      const handler = (_event: unknown, tab: SettingsTab): void => listener(tab)
      ipcRenderer.on(IpcChannel.settingsOpen, handler)
      return () => ipcRenderer.removeListener(IpcChannel.settingsOpen, handler)
    },
    /** 读一份当前设置（界面首帧对齐用） */
    get(): Promise<AppSettings> {
      return ipcRenderer.invoke(IpcChannel.settingsGet)
    },
    /** 只带要改的项；主进程校验、落盘并把整份设置回推 */
    update(patch: Partial<AppSettings>): Promise<AppSettings> {
      return ipcRenderer.invoke(IpcChannel.settingsUpdate, patch)
    },
    /** 恢复出厂设置 */
    reset(): Promise<AppSettings> {
      return ipcRenderer.invoke(IpcChannel.settingsReset)
    },
    onChanged(listener: (settings: AppSettings) => void): () => void {
      const handler = (_event: unknown, settings: AppSettings): void => listener(settings)
      ipcRenderer.on(IpcChannel.settingsChanged, handler)
      return () => ipcRenderer.removeListener(IpcChannel.settingsChanged, handler)
    }
  },
  /** 「数据与备份」设置页（D6a / D6b.1）。每个动作都回一句能给用户看的话。 */
  data: {
    /** 数据目录与版本 */
    info(): Promise<AppDataInfo> {
      return ipcRenderer.invoke(IpcChannel.dataInfo)
    },
    /** 在访达里打开数据目录 */
    revealRoot(): Promise<void> {
      return ipcRenderer.invoke(IpcChannel.dataRevealRoot)
    },
    /** 一键备份（D6a.1） */
    backup(): Promise<MaintenanceResult> {
      return ipcRenderer.invoke(IpcChannel.dataBackup)
    },
    /** 导出项目（D6a.2） */
    exportProject(projectId: string): Promise<MaintenanceResult> {
      return ipcRenderer.invoke(IpcChannel.dataExportProject, projectId)
    },
    /** 从文件夹导入项目（D6a.2） */
    importProject(): Promise<MaintenanceResult> {
      return ipcRenderer.invoke(IpcChannel.dataImportProject)
    },
    /** 素材体检（D6a.3） */
    healthCheck(): Promise<HealthReport> {
      return ipcRenderer.invoke(IpcChannel.dataHealthCheck)
    },
    /** 清除浏览数据（D6b.1） */
    clearBrowsing(): Promise<MaintenanceResult> {
      return ipcRenderer.invoke(IpcChannel.dataClearBrowsing)
    },
    /** 导出诊断包（D6b.1） */
    exportDiagnostics(): Promise<MaintenanceResult> {
      return ipcRenderer.invoke(IpcChannel.dataExportDiagnostics)
    },
    /** 托管素材占用（原图；不含缩略图） */
    libraryUsage(): Promise<LibraryUsage> {
      return ipcRenderer.invoke(IpcChannel.dataLibraryUsage)
    },
    /** 按当前清理策略整理一次素材 */
    cleanupLibrary(): Promise<MaintenanceResult> {
      return ipcRenderer.invoke(IpcChannel.dataCleanupLibrary)
    }
  },
  /** 主窗口：把选中的对象做成一条参考快照（D5.5）。 */
  snapshots: {
    create(projectId: string, sourceIds: string[]): Promise<SnapshotCreateResult> {
      return ipcRenderer.invoke(IpcChannel.snapshotCreate, projectId, sourceIds)
    }
  },
  /** 参考快照**浮窗自己**用的通道；主窗口不会用到这些。 */
  snapshotWindow: {
    /** 取自己那一条快照（浮窗加载完先拉一次） */
    get(): Promise<SnapshotView | null> {
      return ipcRenderer.invoke(IpcChannel.snapshotGet)
    },
    /** 改透明度 / 缩放 / 锁定 / 穿透 */
    update(patch: SnapshotPatch): Promise<SnapshotView | null> {
      return ipcRenderer.invoke(IpcChannel.snapshotUpdate, patch)
    },
    refresh(): Promise<SnapshotRefreshResult | null> {
      return ipcRenderer.invoke(IpcChannel.snapshotRefresh)
    },
    /** 关掉这一条 */
    close(): Promise<void> {
      return ipcRenderer.invoke(IpcChannel.snapshotClose)
    },
    /** 右键：让主进程弹出独立的钉住设置菜单。 */
    menu(): void {
      ipcRenderer.send(IpcChannel.snapshotMenu)
    },
    /**
     * 指针压到右上角按钮上没有。穿透开着时主进程据此临时放行鼠标，
     * 否则穿透一开，连"关闭 / 解锁"都点不到。
     */
    hoverControls(over: boolean): void {
      ipcRenderer.send(IpcChannel.snapshotHover, over)
    },
    /** 拖动：只报屏幕坐标，挪窗口是主进程的事（逐帧发送，不等回执） */
    drag(payload: SnapshotDragPayload): void {
      ipcRenderer.send(IpcChannel.snapshotDrag, payload)
    },
    /** 素材文件名 → 原图地址（与画布同一套自定义协议） */
    assetUrl(fileName: string): string {
      return assetUrlFor(fileName)
    },
    /** 小尺寸浮窗优先用它，省掉解码原图的内存 */
    thumbUrl(fileName: string): string {
      return thumbUrlFor(fileName)
    },
    /** 主进程推来"这一条变了"（刷新完 / 程序坞切了穿透） */
    onChanged(listener: (view: SnapshotView) => void): () => void {
      const handler = (_event: unknown, view: SnapshotView): void => listener(view)
      ipcRenderer.on(IpcChannel.snapshotChanged, handler)
      return () => ipcRenderer.removeListener(IpcChannel.snapshotChanged, handler)
    },
    /** 主进程推来一句给用户看的话（刷新结果）；返回取消订阅的函数 */
    onNotice(listener: (message: string) => void): () => void {
      const handler = (_event: unknown, message: string): void => listener(message)
      ipcRenderer.on(IpcChannel.snapshotNotice, handler)
      return () => ipcRenderer.removeListener(IpcChannel.snapshotNotice, handler)
    }
  }
})
