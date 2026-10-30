import type { CaptureCandidate } from './capture-candidates'
import type { ProjectGraph } from './node'

/** 主进程与渲染进程之间的通道名，两边共用同一份，避免手写字符串写错。 */
export const IpcChannel = {
  /** 渲染进程把未捕获的异常报告给主进程写进日志 */
  rendererError: 'ins-pin:renderer-error',
  /** 用系统默认浏览器打开外部链接（下载类场景不走内置浏览器） */
  appOpenExternal: 'ins-pin:app-open-external',
  /** 列出全部项目（最近改动的在前） */
  projectsList: 'ins-pin:projects-list',
  /** 新建项目 */
  projectsCreate: 'ins-pin:projects-create',
  /** 修改项目名 */
  projectsRename: 'ins-pin:projects-rename',
  /** 删除项目；若删的是最后一个，会立即补回一个空的默认项目 */
  projectsDelete: 'ins-pin:projects-delete',
  /** 通知主进程"当前正在用哪个项目"，只用于写日志，不需要回执 */
  projectsSwitched: 'ins-pin:project-switched',
  /** 读出某个项目的整张画布（节点 + 用到的素材信息） */
  canvasLoad: 'ins-pin:canvas-load',
  /** 按给定的本地文件路径导入图片 */
  assetsImportPaths: 'ins-pin:assets-import-paths',
  /** 打开系统文件选择器导入图片 */
  assetsPickFiles: 'ins-pin:assets-pick-files',
  /** 把剪贴板里的图片导入（⌘V） */
  assetsImportClipboard: 'ins-pin:assets-import-clipboard',
  /** 把从网页拖进来的图片收进项目（D3.8–D3.11）：一般只有地址，要二次下载 */
  assetsImportWeb: 'ins-pin:assets-import-web',
  /** 本地素材侧栏：读取托管素材、回收站和已链接文件夹。 */
  libraryGetState: 'ins-pin:library-get-state',
  /** 选择一个 Finder 文件夹并以只读方式链接。 */
  libraryLinkFolder: 'ins-pin:library-link-folder',
  /** 取消一个外部文件夹链接；不会删除 Finder 中的任何文件。 */
  libraryUnlinkFolder: 'ins-pin:library-unlink-folder',
  /** 读取一个外部文件夹里的图片列表。 */
  libraryListFolder: 'ins-pin:library-list-folder',
  /** 把托管素材或外部文件夹素材放进当前画布（支持一次多张）。 */
  libraryPlaceItems: 'ins-pin:library-place-items',
  /** 把托管素材批量移入 InsPin 回收站。 */
  libraryTrashAssets: 'ins-pin:library-trash-assets',
  /** 从回收站批量还原到 InsPin 素材；还原后重新进入 3 天无引用计时。 */
  libraryRestoreAssets: 'ins-pin:library-restore-assets',
  /** 在 Finder 中定位一个外部文件夹里的图片（只接受已登记的文件夹 + 相对路径）。 */
  libraryRevealLinked: 'ins-pin:library-reveal-linked',
  /**
   * 主进程 → 界面：原图在 Finder 里被删了，对应素材、缩略图与画布节点已一并清掉。
   * 界面据此刷新素材侧栏；列在 `projectIds` 里的项目还要重新读一次画布。
   */
  assetsPruned: 'ins-pin:assets-pruned',
  /** 区域截图（D3.16）：开始框选（抓一张浏览区、把原生视图藏起来） */
  browserCaptureStart: 'ins-pin:browser-capture-start',
  /** 区域截图：放弃这次框选，把原生视图放回来 */
  browserCaptureCancel: 'ins-pin:browser-capture-cancel',
  /** 智能采集进行中：在冻结 / 不冻结之间切换，保持同一次采集会话。 */
  browserCaptureSwitch: 'ins-pin:browser-capture-switch',
  /** 智能采集非冻结模式：通知网页开始/停止监听用户点击。 */
  browserSmartCollectMode: 'ins-pin:browser-smart-collect-mode',
  /** 网页预加载层 → 主进程：用户在智能采集模式中点击了当前位置。 */
  browserSmartCollectClick: 'ins-pin:browser-smart-collect-click',
  /** 主进程 → 网页预加载层：哪些动作绑到了鼠标中键（网页里也要能触发）。 */
  browserMouseShortcutConfig: 'ins-pin:browser-mouse-shortcut-config',
  /** 网页预加载层 → 主进程：网页里按下了已绑定的鼠标中键。 */
  browserMouseShortcut: 'ins-pin:browser-mouse-shortcut',
  /** 主进程 → 网页预加载层：非冻结采集时，页面里的压暗/高亮是否重新显示（截图瞬间要藏起来）。 */
  browserLiveOverlay: 'ins-pin:browser-live-overlay',
  /** 主进程 → 界面：网页里按 Esc 退出了采集，界面要把采集状态清掉。 */
  browserCaptureEnded: 'ins-pin:browser-capture-ended',
  /** 主进程 → 画布：已命中的网页候选，交给既有导入链路落图。 */
  browserSmartCollectPicked: 'ins-pin:browser-smart-collect-picked',
  /** 区域截图：按框选裁下来并收进项目 */
  assetsImportCapture: 'ins-pin:assets-import-capture',
  /** 记录画布视图位置（平移与缩放），供下次打开恢复 */
  canvasSaveViewport: 'ins-pin:canvas-save-viewport',
  /** 把编辑后的整张画布写回数据库（界面上防抖后调用） */
  canvasApplyGraph: 'ins-pin:canvas-apply-graph',
  /** 把选中的素材复制到系统剪贴板，供 Figma / Eagle 等软件粘贴（批量走文件列表） */
  canvasCopyImages: 'ins-pin:canvas-copy-images',
  /** 在 Finder 中定位一张本地素材（只接受素材哈希文件名）。 */
  canvasRevealAsset: 'ins-pin:canvas-reveal-asset',
  /** 以图搜图：可用引擎列表 */
  imageSearchCatalog: 'ins-pin:image-search-catalog',
  /** 以图搜图：开始一次搜索 */
  imageSearchStart: 'ins-pin:image-search-start',
  /** 以图搜图：取消当前搜索 */
  imageSearchCancel: 'ins-pin:image-search-cancel',
  /** 以图搜图：主进程 → 界面，搜索进行到哪一步 */
  imageSearchProgress: 'ins-pin:image-search-progress',
  /** 以图搜图：用户确认「图片会上传到第三方」 */
  imageSearchAcceptConsent: 'ins-pin:image-search-accept-consent',
  /** Apple Vision 抠图：系统与随包组件是否可用。 */
  cutoutCapability: 'ins-pin:cutout-capability',
  /** Apple Vision 抠图：对当前单选图片执行主体分割。 */
  cutoutRun: 'ins-pin:cutout-run',
  /** 读当前浏览器标签状态（D3.1–D3.4） */
  browserGetState: 'ins-pin:browser-get-state',
  /** 新开一个标签 */
  browserNewTab: 'ins-pin:browser-new-tab',
  /** 关掉一个标签 */
  browserCloseTab: 'ins-pin:browser-close-tab',
  /** 切到某个标签 */
  browserActivateTab: 'ins-pin:browser-activate-tab',
  /** 拖动调整标签顺序 */
  browserMoveTab: 'ins-pin:browser-move-tab',
  /** 在标签里打开一个地址 */
  browserNavigate: 'ins-pin:browser-navigate',
  /** 后退 / 前进 / 刷新 / 停止 */
  browserCommand: 'ins-pin:browser-command',
  /** 改面板：收起/展开、停靠左/右/浮动、拖分栏线后的新宽度（D3.5–D3.7） */
  browserSetPanel: 'ins-pin:browser-set-panel',
  /**
   * 拖分栏线时的**逐帧预览**：只挪原生视图、不回推、不落盘。
   * 拖完松手才走 browserSetPanel 正式提交——否则每帧写一次磁盘。
   */
  browserPanelPreview: 'ins-pin:browser-panel-preview',
  /** 打开文件夹侧栏前立刻隐藏原生浏览器视图，避免两张侧栏短暂叠在一起。 */
  browserPanelHideImmediate: 'ins-pin:browser-panel-hide-immediate',
  /** 全窗浮层（设置）打开时临时藏起原生网页，关闭后恢复；不改面板偏好。 */
  browserSetCovered: 'ins-pin:browser-set-covered',
  /** 读一次当前面板布局（界面首帧要对齐主进程） */
  browserGetPanel: 'ins-pin:browser-get-panel',
  /** 把当前网页收藏到起始页的推荐站点（保存网址、标题、favicon）。 */
  browserAddFavorite: 'ins-pin:browser-add-favorite',
  /** 从起始页推荐站点里移除一个网址（取消收藏）。 */
  browserRemoveFavorite: 'ins-pin:browser-remove-favorite',
  /** 读当前起始页推荐站点的网址列表（收藏按钮据此显示已收藏状态）。 */
  browserGetFavoriteUrls: 'ins-pin:browser-get-favorite-urls',
  /** 主进程 → 界面：标签状态变了（标题、加载态、地址、增删） */
  browserStateChanged: 'ins-pin:browser-state-changed',
  /** 主进程 → 界面：网页聚焦时按下了智能采集快捷键 */
  browserSmartCollectRequested: 'ins-pin:browser-smart-collect-requested',
  /** 主进程 → 界面：网页聚焦时按下了「切换锁定 / 滚动屏幕」快捷键 */
  browserToggleCollectModeRequested: 'ins-pin:browser-toggle-collect-mode-requested',
  /** 主进程 → 界面：面板布局变了（窗口缩放降级、停靠切换、宽度变化） */
  browserPanelChanged: 'ins-pin:browser-panel-changed',
  /** 主进程 → 界面：打开设置面板（程序坞右键 / 应用菜单都走这条） */
  settingsOpen: 'ins-pin:settings-open',
  /** 读一份当前设置（渲染层首帧对齐用） */
  settingsGet: 'ins-pin:settings-get',
  /** 改设置：只带要改的项，主进程校验、落盘并回推 */
  settingsUpdate: 'ins-pin:settings-update',
  /** 恢复出厂设置 */
  settingsReset: 'ins-pin:settings-reset',
  /** 主进程 → 界面：设置变了（菜单改键、多窗口同步） */
  settingsChanged: 'ins-pin:settings-changed',

  /* ---------- 参考快照（D5） ---------- */
  /** 主窗口 → 主进程：按当前选中的对象创建一条快照（返回新快照 id） */
  snapshotCreate: 'ins-pin:snapshot-create',
  /** 浮窗 → 主进程：取自己那一条（浮窗加载完先拉一次） */
  snapshotGet: 'ins-pin:snapshot-get',
  /** 浮窗 → 主进程：改透明度 / 缩放 / 锁定 / 穿透 */
  snapshotUpdate: 'ins-pin:snapshot-update',
  /** 钉住浮窗 → 主进程：按原始选中对象刷新冻结内容。 */
  snapshotRefresh: 'ins-pin:snapshot-refresh',
  /** 浮窗 → 主进程：关掉这一条 */
  snapshotClose: 'ins-pin:snapshot-close',
  /** 主进程 → 浮窗：给用户看一眼的一句话（刷新成功 / 刷新失败的原因） */
  snapshotNotice: 'ins-pin:snapshot-notice',
  /** 浮窗 → 主进程：右键了，弹独立、固定尺寸的钉住设置菜单。 */
  snapshotMenu: 'ins-pin:snapshot-menu',
  /**
   * 浮窗 → 主进程：指针压到右上角按钮上没有。
   * 穿透开着时用它临时放行鼠标，让"关闭 / 解锁"点得着（详见 `main/snapshots.ts`）。
   */
  snapshotHover: 'ins-pin:snapshot-hover',
  /** 浮窗 → 主进程：拖动（`on`，逐帧只发屏幕坐标，不等回执） */
  snapshotDrag: 'ins-pin:snapshot-drag',
  /** 主进程 → 浮窗：这一条变了（刷新后、程序坞切换穿透、缩放后） */
  snapshotChanged: 'ins-pin:snapshot-changed',

  /* ---------- 数据与备份（D6a / D6b.1） ---------- */
  /** 设置页要的本机信息（数据目录、版本） */
  dataInfo: 'ins-pin:data-info',
  /** 在访达里打开数据目录 */
  dataRevealRoot: 'ins-pin:data-reveal-root',
  /** 一键备份：选一个位置，产出一个自带 db + 素材的备份文件夹（D6a.1） */
  dataBackup: 'ins-pin:data-backup',
  /** 导出某个项目（D6a.2） */
  dataExportProject: 'ins-pin:data-export-project',
  /** 从文件夹导入一个项目（D6a.2） */
  dataImportProject: 'ins-pin:data-import-project',
  /** 素材体检：找出文件已经不在磁盘上的素材（D6a.3） */
  dataHealthCheck: 'ins-pin:data-health-check',
  /** 清除浏览数据：登录态、缓存、标签（D6b.1） */
  dataClearBrowsing: 'ins-pin:data-clear-browsing',
  /** 导出诊断包（D6b.1；主菜单里也有一份） */
  dataExportDiagnostics: 'ins-pin:data-export-diagnostics',
  /** 素材占用统计（托管素材 + 回收站） */
  dataLibraryUsage: 'ins-pin:data-library-usage',
  /** 按当前清理策略立刻整理一次素材 */
  dataCleanupLibrary: 'ins-pin:data-cleanup-library'
} as const

/** 地址栏那些一次性动作。 */
export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop'

/** 渲染进程上报的异常内容（只允许纯数据，主进程会截断超长文本）。 */
export interface RendererErrorPayload {
  message: string
  stack?: string
  source?: string
}

/**
 * 界面上要用到的项目信息。
 *
 * 只带界面真正需要的字段（不带画布视图位置等主进程内部状态），
 * 这样 `shared/` 不需要反向依赖 `main/`。主进程的 `Project` 结构上满足它。
 */
export interface ProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

/**
 * 新建项目的结果。
 *
 * 用结果对象而不是让异常穿过 IPC：名字为空、过长、写库失败都能变成
 * 一句给用户看的话，而不是渲染侧一个未处理的 rejection。
 */
export type CreateProjectResult =
  | { ok: true; project: ProjectSummary }
  | { ok: false; message: string }

export type RenameProjectResult =
  | { ok: true; project: ProjectSummary }
  | { ok: false; message: string }

export type DeleteProjectResult =
  | { ok: true; replacement: ProjectSummary | null }
  | { ok: false; message: string }

/** 素材是怎么进到项目里的（D1.8 对象检查器要显示"来源方式"）。 */
export type ImportMethod = 'drag' | 'pin' | 'clipboard' | 'capture' | 'collect' | 'file'

/**
 * 画布上要显示一张图，需要知道它的文件落在哪。
 *
 * 素材文件名就是内容哈希（`<sha256>.<ext>`），界面用 `insPin.assetUrl(fileName)`
 * 拼出地址交给 `<img>`。只送文件名，**不把本机绝对路径暴露给界面**。
 *
 * `createdAt` / `importMethod` / `sourceUrl` / `pageUrl` 是 D1.8 检查器要的来源信息；
 * 本地文件与剪贴板这两条通路没有网页地址，`sourceUrl` / `pageUrl` 为 null（未来从
 * 网页拖入才会填上）。
 */
/** 网页里能用鼠标中键触发的动作（只放主进程自己能执行的那些）。 */
export type BrowserMouseAction = 'smartCollect' | 'newTab'

export interface BrowserMouseShortcut {
  /** 与 `shared/shortcuts` 同一套存储格式，例如 `MouseMiddle` */
  accelerator: string
  action: BrowserMouseAction
}

/** 原图被外部删除后的清理通知。 */
export interface AssetsPrunedNotice {
  /** 节点被清掉的项目；当前画布在里面时才需要重新读取。 */
  projectIds: string[]
}

export interface AssetInfo {
  id: string
  fileName: string
  mime: string
  width: number | null
  height: number | null
  /** 原图字节数，检查器里显示文件大小 */
  bytes: number
  importMethod: ImportMethod
  /** 素材第一次落盘的时间（ISO 字符串） */
  createdAt: string
  sourceUrl: string | null
  pageUrl: string | null
  /**
   * 原图文件已经不在磁盘上了（D6a.3）。
   *
   * 主进程算好带过来，界面据此画占位框、挂"素材缺失"标签——渲染进程够不着文件系统，
   * 不给这个标志的话，用户只会看到画布上凭空少了一块，谁也说不清为什么。
   */
  missing?: boolean
}

/**
 * 从网页拖进来的那一份数据（D3.8）。
 *
 * `payload` 就是 `dataTransfer` 里的三种文本，**解析顺序的讲究见 `shared/drop.ts`**；
 * `position` 是落点（画布世界坐标），拿不到就 null、由主进程按序号错开。
 */
export interface WebDropRequest {
  payload: {
    textHtml?: string | null
    textUriList?: string | null
    textPlain?: string | null
  }
  pageUrl: string | null
  position: { x: number; y: number } | null
}

/**
 * 「复制到其他软件」要复制的一张素材。
 *
 * 只送文件名（内容哈希）和给出去时显示的友好名；主进程据此找到磁盘上的原图。
 * 剪贴板上放的是**文件地址**而不是图片字节，所以几百张也只是一小段文本。
 */
export interface CopyImageItem {
  fileName: string
  /** 画布上的节点名，作为粘贴后在目标软件里显示的图层名 / 素材名 */
  name: string
}

/** 复制到其他软件时的选项。 */
export interface CopyImagesOptions {
  /** 把 webp / avif / gif 转成 PNG 再放进剪贴板（设置里的开关） */
  convertToPng: boolean
}

export type CopyImagesResult =
  | { ok: true; count: number; converted: number }
  | { ok: false; message: string }

/** 一键抠图的单个输入；协议保留数组形状，当前主进程仍强制只接收一张。 */
export interface CutoutTarget {
  nodeId: string
  assetId: string
  /** 结果在画布世界坐标中的左上角；null 时按默认位置摆放。 */
  at: { x: number; y: number } | null
}

export interface CutoutCapability {
  available: boolean
  reason?: string
}

/** 窗口坐标里的一个矩形（区域截图用）。 */
export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 开始区域截图时给界面的东西（D3.16）。
 *
 * `dataUrl` 是**抓下来的浏览区**——界面要把它显示在原来的位置上让用户框选。
 * 之所以必须绕这一圈：网页是原生视图，永远盖在界面之上，界面上画不出盖住它的选框。
 * 所以流程是"抓一张 → 藏掉原生视图 → 显示这张图来框选 → 按框裁原图"。
 */
export type CaptureStartResult =
  | {
      ok: true
      dataUrl: string
      /** 截取区在窗口里的位置（CSS 像素），界面据此把图摆回原位 */
      box: WindowRect
      /** 截图前从网页结构里采到的可吸附外壳；不包含网页文本、链接或任何内容。 */
      candidates: CaptureCandidate[]
      mode: CaptureMode
      /** 智能采集直接运行在网页中，页面不会被截图覆盖。 */
      live?: boolean
    }
  | { ok: false; message: string }

/**
 * 提交一次截图：选框用**窗口坐标**给，`center` 是画布当前视口的中心（世界坐标）。
 *
 * 落点给的是"中心"而不是"左上角"：截图多大要裁完才知道，
 * 让主进程按实际尺寸把图**正**摆在视口中间，用户一眼就能看到刚截的东西。
 */
export interface CaptureCommit {
  selection: WindowRect
  center: { x: number; y: number } | null
  /** 智能采集候选的内部 id；只有主进程能把它映射回临时原图地址。 */
  candidateId?: string | null
  /** 连续采集时复用同一帧冻结画面，直到用户主动退出。 */
  continuous?: boolean
}

/** 非冻结智能采集从网页传回的命中结果；仍由画布进程调用既有导入接口。 */
export interface SmartCollectionPick {
  selection: WindowRect
  /** 高亮框没有对应候选时（例如按钮内层的小面）为 null，只按框截取。 */
  candidateId: string | null
}

/** 智能采集连续落图时由主进程给出的确定落点；普通截图仍只传视口中心。 */
export interface CapturePlacement {
  at: { x: number; y: number } | null
  center: { x: number; y: number } | null
}

export type CaptureMode = 'capture' | 'collect'

/** 设置面板的五页；右下角入口、程序坞右键、应用菜单都指向同一套分类。 */
export type SettingsTab = 'general' | 'about' | 'shortcuts' | 'data'

/** 画布视图：平移偏移与缩放倍率（D2.12 恢复视图用）。 */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** 读画布的结果：整张图 + 里面用到的素材信息（按 assetId 索引）+ 上次的视图位置。 */
export type CanvasLoadResult =
  | { ok: true; graph: ProjectGraph; assets: Record<string, AssetInfo>; viewport: Viewport }
  | { ok: false; message: string }

/**
 * 单个文件导入失败的原因（给用户看的一句话）。
 *
 * 只带文件名，**不带本机完整路径**——界面不需要知道文件在哪，也没必要把它显示出来。
 */
export interface ImportFailure {
  name: string
  message: string
  /** 下一步能做什么（D3.14：发生了什么 → 为什么 → 可以怎么做） */
  hint?: string
}

/** 粘贴时落进哪个自动布局容器、插到第几个。 */
export interface PasteContainerTarget {
  containerId: string
  index: number
}

/**
 * 导入结果。整批失败（比如没有项目）用 `ok:false`；
 * 个别文件失败不影响其他文件，放在 `errors` 里。
 */
export type ImportResult =
  | {
      ok: true
      graph: ProjectGraph
      assets: Record<string, AssetInfo>
      importedCount: number
      /** 剪贴板普通文本以默认样式落进画布时的数量。 */
      importedTextCount?: number
      errors: ImportFailure[]
      /** 智能采集最终收下的是原图还是视觉截图，供界面给出准确反馈。 */
      collectionKind?: 'original' | 'screenshot'
      /** 本次新建节点的实际盒子；连续采集用它接续排布与跟随镜头。 */
      importedNode?: { id: string; x: number; y: number; width: number; height: number }
    }
  | { ok: false; message: string; canceled?: boolean }
