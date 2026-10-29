import type {
  BrowserCommand,
  CanvasLoadResult,
  AssetsPrunedNotice,
  CopyImageItem,
  CopyImagesOptions,
  CopyImagesResult,
  CutoutCapability,
  CutoutTarget,
  CreateProjectResult,
  DeleteProjectResult,
  ImportResult,
  PasteContainerTarget,
  ProjectSummary,
  RenameProjectResult,
  CaptureCommit,
  CaptureMode,
  CaptureStartResult,
  SmartCollectionPick,
  RendererErrorPayload,
  SettingsTab,
  Viewport,
  WebDropRequest
} from '../../shared/ipc'
import type { BrowserFavorite, BrowserState } from '../../shared/browser'
import type { ProjectGraph } from '../../shared/node'
import type { PanelLayout, PanelPatch } from '../../shared/panel'
import type {
  SnapshotCreateResult,
  SnapshotDragPayload,
  SnapshotPatch,
  SnapshotRefreshResult,
  SnapshotView
} from '../../shared/snapshot'
import type {
  AppDataInfo,
  HealthReport,
  LibraryUsage,
  MaintenanceResult
} from '../../shared/maintenance'
import type { AppSettings } from '../../shared/settings'
import type {
  ImageSearchCatalogItem,
  ImageSearchCollectLayout,
  ImageSearchProgress,
  ImageSearchStartRequest,
  ImageSearchStartResult
} from '../../shared/image-search'
import type {
  LibraryDragItem,
  LibraryResult,
  LinkedFolderListing,
  LinkedFolderSummary,
  LocalLibraryState,
  PlaceLibraryItemsRequest,
  TrashLibraryAssetsResult
} from '../../shared/local-library'

export interface InsPinApi {
  versions: {
    electron: string
    chrome: string
    node: string
  }
  /** 用系统默认浏览器打开外部链接 */
  openExternal(url: string): Promise<void>
  reportError(payload: RendererErrorPayload): void
  projects: {
    list(): Promise<ProjectSummary[]>
    create(name: string): Promise<CreateProjectResult>
    rename(id: string, name: string): Promise<RenameProjectResult>
    delete(id: string): Promise<DeleteProjectResult>
    notifySwitched(project: { id: string; name: string }): void
  }
  canvas: {
    load(projectId: string): Promise<CanvasLoadResult>
    importPaths(projectId: string, paths: string[]): Promise<ImportResult>
    pickFiles(projectId: string): Promise<ImportResult>
    importClipboard(
      projectId: string,
      center?: { x: number; y: number } | null,
      target?: PasteContainerTarget | null
    ): Promise<ImportResult>
    importWeb(projectId: string, request: WebDropRequest): Promise<ImportResult>
    importCapture(projectId: string, commit: CaptureCommit): Promise<ImportResult>
    assetUrl(fileName: string): string
    thumbUrl(fileName: string): string
    saveViewport(projectId: string, viewport: Viewport): Promise<void>
    saveGraph(projectId: string, graph: ProjectGraph): Promise<boolean>
    pathOf(file: File): string
    /** 把选中的素材复制到系统剪贴板（供别的软件粘贴） */
    copyImages(items: CopyImageItem[], options: CopyImagesOptions): Promise<CopyImagesResult>
    revealAsset(fileName: string): Promise<boolean>
    /** 原图被外部删了、库里已清理；侧栏刷新，相关项目重读画布 */
    onAssetsPruned(listener: (notice: AssetsPrunedNotice) => void): () => void
  }
  localLibrary: {
    getState(): Promise<LocalLibraryState>
    linkFolder(): Promise<LibraryResult<LinkedFolderSummary>>
    unlinkFolder(id: string): Promise<boolean>
    listFolder(id: string): Promise<LibraryResult<LinkedFolderListing>>
    placeItems(request: PlaceLibraryItemsRequest): Promise<ImportResult>
    trashAssets(assetIds: string[]): Promise<TrashLibraryAssetsResult>
    restoreAssets(assetIds: string[]): Promise<number>
    revealLinkedAsset(folderId: string, relativePath: string): Promise<boolean>
    linkedAssetUrl(folderId: string, relativePath: string): string
    linkedThumbUrl(folderId: string, relativePath: string): string
    dragPayload(item: LibraryDragItem): string
  }
  cutout: {
    capability(): Promise<CutoutCapability>
    run(projectId: string, targets: CutoutTarget[]): Promise<ImportResult>
  }
  browser: {
    getState(): Promise<BrowserState>
    newTab(url?: string): Promise<BrowserState>
    closeTab(id: string): Promise<BrowserState>
    activateTab(id: string): Promise<BrowserState>
    moveTab(id: string, to: number): Promise<BrowserState>
    navigate(id: string, url: string): Promise<BrowserState>
    command(id: string, command: BrowserCommand): Promise<BrowserState>
    setPanel(patch: PanelPatch): Promise<PanelLayout>
    getPanel(): Promise<PanelLayout>
    /** 收藏当前网页到起始页的推荐站点 */
    addFavorite(favorite: BrowserFavorite): Promise<boolean>
    /** 取消收藏：从起始页推荐站点里移除这个网址 */
    removeFavorite(url: string): Promise<boolean>
    /** 起始页推荐站点的网址列表 */
    getFavoriteUrls(): Promise<string[]>
    previewPanel(width: number): void
    hidePanelImmediately(): Promise<PanelLayout>
    setCovered(covered: boolean): void
    captureStart(mode?: CaptureMode): Promise<CaptureStartResult>
    captureCancel(): Promise<void>
    onSmartCollectPicked(listener: (pick: SmartCollectionPick) => void): () => void
    onStateChanged(listener: (state: BrowserState) => void): () => void
    onPanelChanged(listener: (layout: PanelLayout) => void): () => void
    onSmartCollectRequested(listener: () => void): () => void
    /** 网页里按 Esc 退出了采集，界面要把采集状态清掉 */
    onCaptureEnded(listener: () => void): () => void
  }
  /** 以图搜图：只接收素材文件名，磁盘路径由主进程解析 */
  imageSearch: {
    catalog(): Promise<ImageSearchCatalogItem[]>
    start(request: ImageSearchStartRequest): Promise<ImageSearchStartResult>
    cancel(): Promise<void>
    /** 主进程推来「搜索走到哪一步」；返回取消订阅 */
    onProgress(listener: (progress: ImageSearchProgress) => void): () => void
    acceptConsent(): Promise<AppSettings>
    collect(projectId: string, layout?: ImageSearchCollectLayout): Promise<ImportResult>
  }
  settings: {
    /** 程序坞右键 / 应用菜单点了设置：主进程推过来，界面把面板打开 */
    onOpen(listener: (tab: SettingsTab) => void): () => void
    /** 读一份当前设置（首帧对齐用） */
    get(): Promise<AppSettings>
    /** 只带要改的项；主进程校验、落盘并回推 */
    update(patch: Partial<AppSettings>): Promise<AppSettings>
    /** 恢复出厂设置 */
    reset(): Promise<AppSettings>
    /** 主进程推来"设置变了"（快捷键、清理策略等） */
    onChanged(listener: (settings: AppSettings) => void): () => void
  }
  snapshots: {
    /** 把当前选中的对象做成一条参考快照（D5.5） */
    create(projectId: string, sourceIds: string[]): Promise<SnapshotCreateResult>
  }
  /** 「数据与备份」设置页（D6a / D6b.1） */
  data: {
    info(): Promise<AppDataInfo>
    revealRoot(): Promise<void>
    backup(): Promise<MaintenanceResult>
    exportProject(projectId: string): Promise<MaintenanceResult>
    importProject(): Promise<MaintenanceResult>
    healthCheck(): Promise<HealthReport>
    clearBrowsing(): Promise<MaintenanceResult>
    exportDiagnostics(): Promise<MaintenanceResult>
    libraryUsage(): Promise<LibraryUsage>
    cleanupLibrary(): Promise<MaintenanceResult>
  }
  /** 参考快照**浮窗**用的通道 */
  snapshotWindow: {
    get(): Promise<SnapshotView | null>
    update(patch: SnapshotPatch): Promise<SnapshotView | null>
    /** 在钉住窗口里重新读取原画布的对象内容。 */
    refresh(): Promise<SnapshotRefreshResult | null>
    close(): Promise<void>
    menu(): void
    hoverControls(over: boolean): void
    drag(payload: SnapshotDragPayload): void
    assetUrl(fileName: string): string
    /** 小尺寸浮窗用的缩略图地址 */
    thumbUrl(fileName: string): string
    onChanged(listener: (view: SnapshotView) => void): () => void
    onNotice(listener: (message: string) => void): () => void
  }
}

declare global {
  interface Window {
    insPin?: InsPinApi
  }
}
