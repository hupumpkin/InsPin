import {
  app,
  BaseWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
  WebContentsView
} from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { registerAssetScheme, serveAssets } from './asset-protocol'
import { BrowserTabs } from './browser-tabs'
import { loadBrowserTabs, saveBrowserTabs } from './browser-tabs-store'
import { CaptureSession } from './capture'
import { collectCaptureCandidates, type CaptureCandidateCollection } from './capture-candidates'
import { preferredCaptureCandidate, type CaptureCandidate } from '../shared/capture-candidates'
import {
  collectAssetInfos,
  importCapturedBytes,
  importSmartOriginal,
  registerCanvasIpc,
  rankedClipboardAssetTypes,
  type ClipboardContent
} from './canvas-ipc'
import { sniffImageFormat } from './mime'
import { registerCopyImagesIpc } from './copy-images'
import { registerCutoutIpc } from './cutout'
import { catalogFor } from './image-search/engines'
import { ImageSearchService } from './image-search/service'
import { parseImageSearchRequest } from '../shared/image-search'
import type { FetchLike } from './download'
import { resizePathWithNativeImage, resizeWithNativeImage } from './image-resize'
import { createThumbnailService } from './thumbnails-service'
import { openDatabase, schemaVersion } from './db'
import { installErrorHandlers } from './errors'
import type { ImageMeasurer } from './import-files'
import {
  IpcChannel,
  type BrowserCommand,
  type BrowserMouseShortcut,
  type CaptureCommit,
  type CaptureMode,
  type CaptureStartResult
} from '../shared/ipc'
import { serializeTabs } from '../shared/browser'
import {
  applyPanelPatch,
  clampPanelWidth,
  DEFAULT_PANEL_PREFS,
  PANEL_CARD_GUTTER,
  resolvePanelLayout,
  type PanelLayout,
  type PanelPrefs
} from '../shared/panel'
import { attachCrashRecovery, type CrashSource } from './crash-recovery'
import { registerDataIpc } from './data-ipc'
import { Logger, LogEvent, logFileName, pruneOldLogs } from './logger'
import { currentRelease, RELEASE_CHANNEL } from '../shared/release'
import { hardenThirdPartySession, installIpcSenderGuard } from './web-security'
import { buildDockMenu, installAppMenu, runDiagnosticsExport, type SettingsTab } from './menu'
import { isMouseAccelerator, matchesAccelerator } from '../shared/shortcuts'
import { loadGraph } from './nodes'
import { pruneMissingAssets, type PruneResult } from './assets-prune'
import { loadPanelPrefs, savePanelPrefs } from './panel-prefs-store'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  type AppSettings
} from '../shared/settings'
import { loadSettings, saveSettings } from './settings-store'
import { ensureDataDirs, resolveDataPaths } from './paths'
import { registerProjectIpc } from './projects-ipc'
import { ensureDefaultProject } from './projects'
import { buildScene } from '../shared/scene'
import { collectSnapshotContent, type SnapshotRecord } from '../shared/snapshot'
import { createSnapshotManager, type SnapshotManager, type SnapshotSourceResult } from './snapshots'
import { loadSnapshots, saveSnapshots } from './snapshots-store'
import {
  formatSmokeReport,
  logSmokeResult,
  runCaptureSmokeChecks,
  runPanelSmokeChecks,
  runSmokeTest,
  runSnapshotSmokeChecks,
  waitForIdle
} from './smoke'
import { startStartPageServer, type StartPageServer } from './start-page'
import {
  cleanupLibraryNow,
  getLocalLibraryState,
  libraryUsage,
  linkFolder,
  listLinkedFolderAssets,
  placeLibraryItems,
  reconcileLibrary,
  resolveLinkedAssetPathAsync,
  restoreManagedAssets,
  trashManagedAssets,
  unlinkFolder
} from './local-library'
import {
  isLibraryDragItem,
  type LibraryDragItem,
  type PlaceLibraryItemsRequest
} from '../shared/local-library'

const isDev = !app.isPackaged
const rendererUrl = process.env['ELECTRON_RENDERER_URL']
/** 自动自检模式：跑完检查就退出，供 `npm run smoke` 使用 */
const SMOKE = process.argv.includes('--smoke')

// 开发版跑的是 Electron 自带的可执行文件。统一应用名，便于日志和系统提示；
// 菜单栏标题仍由 Electron bundle 决定，正式包由 Info.plist 决定。
if (!app.isPackaged) app.setName('InsPin')

/** 浏览器区域的会话分区；`persist:` 前缀才会把登录态落盘 */
const BROWSER_PARTITION = 'persist:inspin-browser'

// 内部版与正式版必须落在不同的数据目录，否则同名数据库会互相覆盖。
// 测试包通过 INSPIN_USER_DATA_DIR 显式指定目录；正式安装包按渠道名落盘。
// 必须早于 resolveDataPaths()，否则数据库和浏览器会话已经取到了旧目录。
const isolatedUserData = process.env['INSPIN_USER_DATA_DIR']
if (isolatedUserData) {
  app.setPath('userData', isolatedUserData)
} else if (app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), currentRelease.dataDirectoryName))
}

// 日志要尽早可用，这样连"启动阶段就崩"也能留下证据
const dataPaths = resolveDataPaths(app.getPath('userData'))
ensureDataDirs(dataPaths)
pruneOldLogs(dataPaths.logs)
// 浏览器 Cookie、localStorage 等一律落在 sessions/ 下，和素材、数据库互不干扰
app.setPath('sessionData', dataPaths.sessions)

// 自定义素材协议必须在 app ready 之前声明，`<img>` 才愿意从它加载
registerAssetScheme()

const logger = new Logger(dataPaths.logs, logFileName(new Date()))

// 必须在注册任何 IPC handler 之前装好：第三方网页发出的请求会在这里被挡掉
installIpcSenderGuard(ipcMain, {
  rendererUrl: isDev && rendererUrl ? rendererUrl : null,
  webPageChannels: new Set([IpcChannel.browserSmartCollectClick, IpcChannel.browserMouseShortcut])
})

// 更新链接一类的下载场景交给系统浏览器，内置浏览器的下载体验不够好。
ipcMain.handle(IpcChannel.appOpenExternal, async (_event, raw: unknown) => {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) return
  await shell.openExternal(raw)
})

installErrorHandlers(logger)

/**
 * 数据库：文件不存在会自动创建，结构自动升到最新版本。
 *
 * **自检一律用内存库**：`npm run smoke` 会真的走一遍导入流程，写进用户的真实项目
 * 就是污染（已经栽过两次：留下选不中的 0×0 节点、留下几张没人要的"网页截图"）。
 * 内存库还有个好处——自检结果不再取决于用户当前有几个项目。
 */
/**
 * 打开数据库；打不开就**说清楚再退出**，而不是让应用"点了没反应"。
 *
 * 会走到这里的只有两种：结构升级中途失败，或者库文件本身坏了。迁移是整条事务的，
 * 失败时已经回滚——**数据没丢，是升级没完成**，所以文案要这么讲，并让用户把日志发来。
 */
function openDatabaseOrExit(file: string): DatabaseSync {
  try {
    return openDatabase(file)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(LogEvent.mainUncaught, { description: '数据库打开失败', message: detail })
    dialog.showErrorBox(
      'InsPin 打不开数据',
      [
        '项目数据这次没能读出来，应用先停下了。',
        '',
        '你的图片和项目还在原来的位置，没有被删改——多半是数据库升级没走完，',
        '或者文件被别的程序占着。',
        '',
        `数据目录：${dataPaths.root}`,
        `日志目录：${dataPaths.logs}`,
        `原因：${detail}`
      ].join('\n')
    )
    app.exit(1)
    throw error
  }
}

const db = openDatabaseOrExit(SMOKE ? ':memory:' : dataPaths.databaseFile)
// 新安装及“删掉最后一个项目”后的下次启动，都有一张可直接拖图的默认画布。
ensureDefaultProject(db)

/**
 * 原图被用户在 Finder 里删掉后，把残留的素材记录、缩略图缓存和画布节点一起清掉。
 * 不做的话侧栏还显示预览、画布留一块“素材缺失”的占位，用户只能手动一块块删。
 */
function pruneMissing(): PruneResult {
  return pruneMissingAssets({
    db,
    assetsDir: dataPaths.assets,
    thumbnailsDir: dataPaths.thumbnails
  })
}

/** 清理结果推给界面：侧栏刷新，被清空节点的项目重读画布。 */
function notifyAssetsPruned(result: PruneResult): void {
  if (result.removedAssetIds.length === 0) return
  canvasView?.webContents.send(IpcChannel.assetsPruned, { projectIds: result.projectIds })
}

/** 切回应用时的体检：延后一拍并限制频率——别每次 focus 都同步扫一遍 */
const FOCUS_PRUNE_DELAY_MS = 800
const FOCUS_PRUNE_COOLDOWN_MS = 5000
let pruneSoonTimer: ReturnType<typeof setTimeout> | null = null
let lastPruneAt = 0

function pruneMissingSoon(): void {
  if (pruneSoonTimer !== null) return
  if (Date.now() - lastPruneAt < FOCUS_PRUNE_COOLDOWN_MS) return
  pruneSoonTimer = setTimeout(() => {
    pruneSoonTimer = null
    lastPruneAt = Date.now()
    notifyAssetsPruned(pruneMissing())
  }, FOCUS_PRUNE_DELAY_MS)
}

// 启动时先清一次：应用关闭期间被删掉的原图，不该在第一次打开画布时又冒出来
pruneMissing()
lastPruneAt = Date.now()

// 项目切换界面依赖的 IPC 通路；尽早注册，界面第一次调用时就已经在等它
registerProjectIpc({ ipc: ipcMain, db, logger })

/** 用 Electron 的解码器读原图像素尺寸；解不出来（少见格式）就留空，不阻断导入。 */
const measureImage: ImageMeasurer = (bytes) => {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  return width > 0 && height > 0 ? { width, height } : null
}

/** 系统文件选择器，只筛常见图片格式；真正的格式校验仍以文件头为准。 */
async function pickImageFiles(): Promise<{ canceled: boolean; paths: string[] }> {
  const result = await dialog.showOpenDialog({
    title: '导入图片',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  return { canceled: result.canceled, paths: result.filePaths }
}

/**
 * 读系统剪贴板里的一张图。
 *
 * 用主进程的 clipboard 而不是界面侧的 paste 事件数据：截图、网页里复制的图、各应用
 * 复制的内容在剪贴板上可能是不同格式（PNG / JPEG / TIFF / SVG…）。SVG 常会以
 * `text/plain` 或 `text/html` 提供原始标签，而不是 `image/svg+xml`。
 *
 * 原生解码器能解的（PNG/JPEG/GIF…）统一重编码成 PNG，下游只用面对一种干净输入；
 * 解不了的（SVG / WebP / AVIF）**原样保留字节**，交给文件头识别与导入流程——
 * 画布本身能渲染它们，不该因为解码器不支持就丢掉。
 *
 * 注意 Electron 44 的 clipboard 是 `read() → ClipboardItem.getType() → Blob` 这套
 * 异步 API（老的同步 `readImage()` 已经不在了）。
 */
async function readClipboardImage(): Promise<ClipboardContent | ClipboardContent[] | null> {
  const items = await clipboard.read()
  const images: ClipboardContent[] = []
  let plainText: string | null = null

  for (const item of items) {
    for (const type of rankedClipboardAssetTypes(item.types)) {
      try {
        const value = (await item.getType(type)) as unknown
        const bytes =
          typeof value === 'string'
            ? new TextEncoder().encode(value)
            : new Uint8Array(await (value as Blob).arrayBuffer())
        if (bytes.length === 0) continue

        if (type === 'text/uri-list') {
          // Finder 里一次复制多个文件时，图片本身以文件地址列表出现。
          const list = new TextDecoder('utf-8').decode(bytes)
          for (const line of list.split(/\r?\n/)) {
            const value = line.trim()
            if (!value || value.startsWith('#') || !value.startsWith('file://')) continue
            try {
              const path = fileURLToPath(value)
              const fileBytes = new Uint8Array(await readFile(path))
              if (!sniffImageFormat(fileBytes)) continue
              images.push({ name: basename(path), bytes: fileBytes, width: 0, height: 0 })
            } catch {
              // 单个文件读不出来不影响其余文件
            }
          }
          break
        }

        if (type === 'text/plain' || type === 'text/html') {
          const format = sniffImageFormat(bytes)
          if (format) {
            images.push({ name: `剪贴板图片.${format.ext}`, bytes, width: 0, height: 0 })
            break
          }
          // 富文本只用来发现根 SVG；普通文字只读 plain text，格式完全由文本工具接管。
          if (type === 'text/plain') plainText ??= new TextDecoder('utf-8').decode(bytes)
          continue
        }

        const image = nativeImage.createFromBuffer(Buffer.from(bytes))
        if (!image.isEmpty()) {
          const { width, height } = image.getSize()
          if (width <= 0 || height <= 0) continue
          images.push({ name: '剪贴板图片.png', bytes: new Uint8Array(image.toPNG()), width, height })
          break
        }

        const format = sniffImageFormat(bytes)
        if (!format) continue
        // 尺寸留 0：导入时再用文件头解析（SVG / WebP / AVIF 各有一套读法）
        images.push({ name: `剪贴板图片.${format.ext}`, bytes, width: 0, height: 0 })
        break
      } catch {
        // 这个类型读不出来，换下一个
      }
    }
  }

  if (images.length > 0) return images
  if (plainText?.trim()) return { text: plainText }
  return null
}

// 系统缩略图是方的：托管素材的原图像素尺寸在库里，用它把比例还原。
// 文件名是内容哈希，尺寸不会变，所以进程内缓存一份就够。
const assetSizeStmt = db.prepare('SELECT width, height FROM assets WHERE file_name = ?')
const assetSizeCache = new Map<string, { width: number; height: number }>()
function sourceSizeOf(fileName: string): { width: number; height: number } | undefined {
  const cached = assetSizeCache.get(fileName)
  if (cached) return cached
  const row = assetSizeStmt.get(fileName) as
    | { width: number | null; height: number | null }
    | undefined
  if (!row?.width || !row.height) return undefined
  const size = { width: row.width, height: row.height }
  assetSizeCache.set(fileName, size)
  return size
}

// 缩略图：导入后预热，界面上请求时按需兜底（D1.7）
const thumbnails = createThumbnailService({
  assetsDir: dataPaths.assets,
  thumbnailsDir: dataPaths.thumbnails,
  resize: async (bytes, maxEdge) => resizeWithNativeImage(bytes, maxEdge),
  // 字节解不了的格式按路径走系统解码器；带上原图尺寸好把方图还原成正确比例
  resizePath: (sourcePath, maxEdge, naturalSize) =>
    resizePathWithNativeImage(sourcePath, maxEdge, naturalSize),
  sourceSize: sourceSizeOf
})

/**
 * 读一次参考快照要画的源内容（D5.5 创建 / D5.7 刷新共用）。
 *
 * 把画布上的选中对象摊平成"盒子 + 素材信息"；素材文件不在磁盘上时记进 `missing`，
 * 浮窗那边画成可理解的占位（D5.6）。素材全在本地，所以断网、关网页都不影响它显示。
 */
function readSnapshotSource(projectId: string, sourceIds: string[]): SnapshotSourceResult {
  const graph = loadGraph(db, projectId)
  const items = buildScene(graph)
  // 带上 assetsDir：素材已经不在磁盘上的，`info.missing` 会是 true，浮窗据此画占位
  const assets = collectAssetInfos(db, graph, dataPaths.assets)
  const content = collectSnapshotContent(
    items,
    sourceIds,
    (assetId) => assets[assetId] ?? null,
    (assetId) => !assets[assetId] || assets[assetId]?.missing === true
  )
  if (!content) return { ok: false, message: '这些对象现在不在画布上了，回去重新选一下' }
  return { ok: true, content }
}

/**
 * 取网页图片用的 fetch：**必须挂在浏览器那个会话上**。
 * 登录态、Cookie、referrer 策略都在它身上；换成全局 fetch，图床会把我们当外部盗链挡掉。
 */
const browserFetch: FetchLike = (url, init) =>
  session.fromPartition(BROWSER_PARTITION).fetch(url, init)

// 画布读取 + 素材导入（D1.4 本地文件 / D1.5 剪贴板 / D3.8 网页拖入）
const canvasIpcDeps = {
  ipc: ipcMain,
  db,
  assetsDir: dataPaths.assets,
  measure: measureImage,
  pickFiles: pickImageFiles,
  readClipboardImage,
  fetchImpl: browserFetch,
  thumbnails,
  pruneMissing: () => void pruneMissing(),
  logger
}
registerCanvasIpc(canvasIpcDeps)

const localLibraryDeps = {
  db,
  assetsDir: dataPaths.assets,
  thumbnailsDir: dataPaths.thumbnails,
  measure: measureImage,
  // 只被参考快照用到的素材也算“在用”，否则 33 天后会被清理、浮窗变占位块
  snapshotAssetIds: () => snapshotManager?.referencedAssetIds() ?? [],
  cleanup: () => applicationSettings.assetCleanup
}

ipcMain.handle(IpcChannel.libraryGetState, () => {
  notifyAssetsPruned(pruneMissing())
  return getLocalLibraryState(localLibraryDeps)
})
ipcMain.handle(IpcChannel.libraryLinkFolder, async () => {
  const path = await pickDirectory({ title: '连接本地图片文件夹', buttonLabel: '连接文件夹' })
  if (!path) return { ok: false, message: '', canceled: true }
  return { ok: true, value: linkFolder(db, path) }
})
ipcMain.handle(IpcChannel.libraryUnlinkFolder, (_event, rawId: unknown) => {
  if (typeof rawId !== 'string') return false
  return unlinkFolder(db, rawId, dataPaths.thumbnails)
})
ipcMain.handle(IpcChannel.libraryListFolder, async (_event, rawId: unknown) => {
  if (typeof rawId !== 'string') return { ok: false, message: '文件夹参数无效' }
  try {
    return { ok: true, value: await listLinkedFolderAssets(db, rawId) }
  } catch {
    return { ok: false, message: '无法读取这个文件夹，请检查访问权限' }
  }
})
ipcMain.handle(IpcChannel.libraryPlaceItems, async (_event, raw: unknown) => {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '素材参数无效' }
  const request = raw as Partial<PlaceLibraryItemsRequest>
  const at = request.at
  const items = request.items
  if (
    typeof request.projectId !== 'string' ||
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every(isLibraryDragItem) ||
    !at ||
    typeof at.x !== 'number' ||
    typeof at.y !== 'number' ||
    !Number.isFinite(at.x) ||
    !Number.isFinite(at.y)
  ) {
    return { ok: false, message: '素材参数无效' }
  }
  try {
    return await placeLibraryItems(localLibraryDeps, request.projectId, items as LibraryDragItem[], at)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '素材导入失败' }
  }
})
ipcMain.handle(IpcChannel.libraryTrashAssets, (_event, rawIds: unknown) => {
  if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === 'string')) {
    return { trashed: 0, blocked: 0 }
  }
  return trashManagedAssets(
    db,
    rawIds,
    new Date(),
    new Set(snapshotManager?.referencedAssetIds() ?? [])
  )
})
ipcMain.handle(IpcChannel.libraryRestoreAssets, (_event, rawIds: unknown) => {
  if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === 'string')) return 0
  return restoreManagedAssets(db, rawIds)
})
ipcMain.handle(IpcChannel.libraryRevealLinked, async (_event, rawFolderId: unknown, rawRelativePath: unknown) => {
  if (typeof rawFolderId !== 'string' || typeof rawRelativePath !== 'string') return false
  const path = await resolveLinkedAssetPathAsync(db, rawFolderId, rawRelativePath)
  if (!path) return false
  shell.showItemInFolder(path)
  return true
})

// 把选中的素材复制到系统剪贴板，供 Figma / Eagle 等软件粘贴（批量走文件地址列表）
registerCopyImagesIpc(ipcMain, {
  clipboard,
  assetsDir: dataPaths.assets,
  exportDir: join(dataPaths.root, 'exports')
})

// “本地”按钮只接收素材内容哈希文件名，禁止用 IPC 传任意本机路径。
ipcMain.handle(IpcChannel.canvasRevealAsset, (_event, rawFileName: unknown): boolean => {
  if (typeof rawFileName !== 'string' || !/^[0-9a-f]{16,64}\.[a-z0-9]{1,5}$/i.test(rawFileName)) return false
  const filePath = join(dataPaths.assets, rawFileName)
  if (!existsSync(filePath)) return false
  shell.showItemInFolder(filePath)
  return true
})

// Apple Vision 的小工具不把 Swift 依赖带进 Electron：开发时取源码构建物，打包后取 resources。
registerCutoutIpc({
  ipc: ipcMain,
  db,
  assetsDir: dataPaths.assets,
  measure: measureImage,
  logger,
  thumbnails,
  helperPath: app.isPackaged
    ? join(process.resourcesPath, 'subject-lift')
    : join(__dirname, '../../native/SubjectLift/subject-lift')
})

let appWindow: BaseWindow | null = null
let canvasView: WebContentsView | null = null
let startPage: StartPageServer | null = null
let browserTabs: BrowserTabs | null = null

/** 浏览器 chrome 两行的高度（标签栏 72px + 地址栏 48px）。 */
const BROWSER_CHROME_HEIGHT = 120
const BROWSER_TABS_FILE = join(dataPaths.sessions, 'browser-tabs.json')
const PANEL_PREFS_FILE = join(dataPaths.sessions, 'browser-panel.json')
const SNAPSHOTS_FILE = join(dataPaths.sessions, 'snapshots.json')
/** 设置放在数据根目录：清除浏览数据不会把它一起清掉。 */
const SETTINGS_FILE = join(dataPaths.root, 'settings.json')
/** 起始页自定义的网站列表；同样不随"清除浏览数据"消失。 */
const START_SOURCES_FILE = join(dataPaths.root, 'start-page-sources.json')
/** 面板滑入/滑出时长，与界面 CSS 的 --motion-panel 一致（设计稿 260ms） */
const PANEL_SLIDE_MS = 260

/** 一份设置，界面、素材清理都用它；启动时从 settings.json 读回。 */
let applicationSettings: AppSettings = normalizeSettings(null)

/**
 * 网页里的鼠标中键该触发哪些动作。
 *
 * 只列出主进程自己就能执行的两个：网页是原生视图，事件不经过界面层，
 * 把动作转回渲染进程还要多绕一圈来回。其余动作在 InsPin 自己的界面里触发。
 */
function browserMouseShortcuts(): BrowserMouseShortcut[] {
  const shortcuts = applicationSettings.shortcuts
  const list: BrowserMouseShortcut[] = []
  if (isMouseAccelerator(shortcuts.smartCollect)) {
    list.push({ accelerator: shortcuts.smartCollect!, action: 'smartCollect' })
  }
  if (isMouseAccelerator(shortcuts.newTab)) {
    list.push({ accelerator: shortcuts.newTab!, action: 'newTab' })
  }
  return list
}

/** 面板偏好（用户意愿）与由此算出的布局（实际几何）。主进程是唯一权威。 */
let panelPrefs: PanelPrefs = { ...DEFAULT_PANEL_PREFS }
let panelLayout: PanelLayout = resolvePanelLayout({ windowWidth: 1500, prefs: panelPrefs })
/**
 * 滑入进度 0–1：0 = 完全在窗外，1 = 完全就位。
 * 网页是**原生视图**，没法用 CSS 过渡，只能由主进程自己按帧挪位置——
 * 不然会看到"chrome 滑进来了、网页却已经杵在那儿"的割裂感。
 */
let panelSlide = 1
let panelSlideTimer: NodeJS.Timeout | null = null

/** 区域截图（D3.16）当前这一次的现场；不影响面板本身的布局状态。 */
const captureSession = new CaptureSession()

/** 设计稿的滑入缓动 cubic-bezier(.2,.8,.2,1)，与 tokens.css 的 --ease-panel 一致。 */
function easePanel(t: number): number {
  const [x1, y1, x2, y2] = [0.2, 0.8, 0.2, 1]
  // 三次贝塞尔按参数方程数值求解，够用即可（只跑 260ms）
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    const x = 3 * (1 - mid) ** 2 * mid * x1 + 3 * (1 - mid) * mid ** 2 * x2 + mid ** 3
    if (x < t) lo = mid
    else hi = mid
  }
  const u = (lo + hi) / 2
  return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3
}

/**
 * 左侧模式是被画布逐步揭开的底层浏览器：左边固定，只增长可见宽度；地址栏和网页
 * 会随可见区域自然重排/裁切。右侧和浮动模式仍保留原先整卡平移的行为。
 */
function browserContentBounds(): Electron.Rectangle {
  const { width, height } = appWindow?.getContentBounds() ?? { width: 1, height: 1 }
  const panelWidth = panelLayout.open ? panelLayout.width : panelLayout.openWidth
  if (panelLayout.dock === 'left') {
    return {
      x: 0,
      y: BROWSER_CHROME_HEIGHT,
      width: Math.max(1, Math.round(panelWidth * panelSlide)),
      height: Math.max(1, height - BROWSER_CHROME_HEIGHT)
    }
  }
  const travel = panelWidth + PANEL_CARD_GUTTER
  const x = Math.round(width - travel * panelSlide)
  return {
    x,
    y: BROWSER_CHROME_HEIGHT + PANEL_CARD_GUTTER,
    width: Math.max(1, panelWidth),
    height: Math.max(1, height - BROWSER_CHROME_HEIGHT - 2 * PANEL_CARD_GUTTER)
  }
}

/**
 * 面板的有效可见性：展开中、或收起动画还没走完，都得让网页视图露着。
 *
 * 例外是**区域截图框选中**（D3.16）：那时必须把原生视图藏起来，
 * 界面那层"抓下来的截图"才露得出来让用户框选。这一条是这里唯一的真话来源，
 * 所以放它自己判断，别的入口不用各自记得"截图时要藏"。
 */
/** 设置这类全窗浮层盖住整个应用时，原生网页必须让位，否则蒙层盖不住它。 */
let overlayCoversBrowser = false

function syncPanelVisibility(): void {
  if (captureSession.hidesBrowser || overlayCoversBrowser) {
    browserTabs?.setPanelVisible(false)
    return
  }
  browserTabs?.setPanelVisible(panelLayout.open || panelSlide > 0)
}

/** 非冻结智能采集只拦截网页里的点击，网页的滚动始终保留给用户。 */
let liveCollectionPage: Electron.WebContents | null = null
let liveCollectionClickPending = false

/**
 * 整页跳转/刷新后，网页里的采集浮层会随旧文档一起消失，继续挂着只会让用户
 * "点了没反应"。单页应用的路由变化（did-navigate-in-page）不在这里处理，
 * 那种情况下浮层还在。
 */
function onLivePageNavigated(): void {
  endCaptureSession(true)
}

function stopLiveCollection(): void {
  const page = liveCollectionPage
  liveCollectionPage = null
  if (!page || page.isDestroyed()) return
  page.removeListener('did-navigate', onLivePageNavigated)
  page.send(IpcChannel.browserSmartCollectMode, false)
}

function startLiveCollection(page: Electron.WebContents): void {
  stopLiveCollection()
  if (page.isDestroyed()) return
  liveCollectionPage = page
  page.on('did-navigate', onLivePageNavigated)
  page.send(IpcChannel.browserSmartCollectMode, true)
  // 滚动模式让网页重新拿到焦点，用户才能继续滚动、快捷键也走网页侧的转发
  page.focus()
}

/**
 * 锁定模式会藏起网页视图。焦点必须交回画布，否则按键落不到任何窗口，
 * 「切换锁定 / 滚动屏幕」就只剩单向可用。
 */
function focusCanvas(): void {
  canvasView?.webContents.focus()
}

/**
 * 等页面把注入的压暗/高亮真正画掉（两帧），再把页面截下来；
 * 页面卡住或不允许执行脚本时最多等 80ms，不能因此卡住切换。
 */
function waitForPagePaint(page: Electron.WebContents): Promise<void> {
  const painted = page
    .executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
    )
    .then(() => undefined)
    .catch(() => undefined)
  return Promise.race([painted, new Promise<void>((resolve) => setTimeout(resolve, 80))])
}

/** 网页里回报的高亮框（网页视口 CSS 像素）；老版本 preload 不带它。 */
interface LiveTargetRect {
  x: number
  y: number
  width: number
  height: number
}

function liveTargetRect(value: unknown): LiveTargetRect | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const x = raw['x']
  const y = raw['y']
  const width = raw['width']
  const height = raw['height']
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }
  return { x, y, width, height }
}

/**
 * 非冻结采集点击时，优先收下页面高亮框对应的那个候选，
 * 让"看到什么框就截什么"成立；页面在点击瞬间重排时再退回按点命中。
 */
function liveSelectionAt(
  collection: CaptureCandidateCollection,
  box: Electron.Rectangle,
  point: { x: number; y: number },
  target: LiveTargetRect | null
): { selection: Electron.Rectangle; candidateId: string | null } | null {
  const scaleX = box.width / Math.max(1, collection.viewportWidth)
  const scaleY = box.height / Math.max(1, collection.viewportHeight)

  if (target) {
    const want = {
      x: box.x + target.x * scaleX,
      y: box.y + target.y * scaleY,
      width: target.width * scaleX,
      height: target.height * scaleY
    }
    let best: CaptureCandidate | null = null
    let bestOverlap = 0
    for (const candidate of collection.candidates) {
      const left = Math.max(candidate.x, want.x)
      const top = Math.max(candidate.y, want.y)
      const right = Math.min(candidate.x + candidate.width, want.x + want.width)
      const bottom = Math.min(candidate.y + candidate.height, want.y + want.height)
      const overlap = Math.max(0, right - left) * Math.max(0, bottom - top)
      if (overlap <= 0) continue
      const union = candidate.width * candidate.height + want.width * want.height - overlap
      const iou = union > 0 ? overlap / union : 0
      if (iou > bestOverlap) {
        bestOverlap = iou
        best = candidate
      }
    }
    if (best && bestOverlap >= 0.6) {
      return {
        selection: { x: best.x, y: best.y, width: best.width, height: best.height },
        candidateId: best.id
      }
    }
    // 高亮框不在候选表里（例如按钮内层带底色的小块）：照着用户看到的框截，
    // 不再按点位猜一个外层卡片。
    const left = Math.min(Math.max(want.x, box.x), box.x + box.width)
    const top = Math.min(Math.max(want.y, box.y), box.y + box.height)
    const right = Math.min(Math.max(want.x + want.width, box.x), box.x + box.width)
    const bottom = Math.min(Math.max(want.y + want.height, box.y), box.y + box.height)
    if (right - left < 32 || bottom - top < 32) return null
    return {
      selection: { x: left, y: top, width: right - left, height: bottom - top },
      candidateId: null
    }
  }

  const candidate = preferredCaptureCandidate(collection.candidates, {
    x: box.x + point.x * scaleX,
    y: box.y + point.y * scaleY
  })
  return candidate
    ? {
        selection: { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height },
        candidateId: candidate.id
      }
    : null
}

/**
 * 结束一次采集：退出页面拦截、丢掉暂存截图、把网页视图恢复回来。
 * `notifyRenderer` 用于网页里按 Esc 的情况——界面层不知道这次退出，需要通知它清状态。
 */
function endCaptureSession(notifyRenderer = false): void {
  if (captureSession.active) logger.info(LogEvent.captureCancelled, {})
  stopLiveCollection()
  captureSession.cancel()
  syncPanelVisibility()
  if (notifyRenderer) canvasView?.webContents.send(IpcChannel.browserCaptureEnded)
}

function collectLiveSmartCandidate(sender: Electron.WebContents, raw: unknown): void {
  if (liveCollectionClickPending || sender !== liveCollectionPage || captureSession.hidesBrowser) return
  if (typeof raw !== 'object' || raw === null) return
  const point = raw as { x?: unknown; y?: unknown; rect?: unknown }
  if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
  const x = point.x
  const y = point.y
  if (x < 0 || y < 0) return
  const target = liveTargetRect(point.rect)

  liveCollectionClickPending = true
  void (async () => {
    try {
      const active = browserTabs?.activeWebContents()
      if (active !== sender || !captureSession.active) return
      const bounds = browserContentBounds()
      const [collection, image] = await Promise.all([
        collectCaptureCandidates(sender, bounds),
        sender.capturePage()
      ])
      if (!captureSession.refresh(image, bounds, collection, sender.getURL() || null)) return
      const picked = liveSelectionAt(collection, bounds, { x, y }, target)
      if (!picked) return
      canvasView?.webContents.send(IpcChannel.browserSmartCollectPicked, picked)
    } catch (error) {
      logger.error(LogEvent.browserLoadFailed, {
        description: '智能采集读取当前页面失败',
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      liveCollectionClickPending = false
      // 截完把页面里的压暗/高亮放回来；已经退出采集（换页 / Esc）就不要再显示
      if (liveCollectionPage === sender && !sender.isDestroyed()) {
        sender.send(IpcChannel.browserLiveOverlay, true)
      }
    }
  })()
}

function layout(): void {
  if (!appWindow) return
  const { width, height } = appWindow.getContentBounds()
  // **画布视图铺满整个窗口**：浏览器那块由界面自己让出来（一个 React 应用管全部 chrome）
  canvasView?.setBounds({ x: 0, y: 0, width, height })
  // 网页是原生视图，盖在画布视图之上，只占"chrome 以下、面板那一条"那块
  browserTabs?.setBounds(browserContentBounds())
}

/** 把算好的布局推给界面（界面据此摆 chrome、画分栏线、平移工具栏）。 */
function pushPanelLayout(): void {
  canvasView?.webContents.send(IpcChannel.browserPanelChanged, panelLayout)
}

function stopPanelSlide(): void {
  if (panelSlideTimer) {
    clearInterval(panelSlideTimer)
    panelSlideTimer = null
  }
}

/** 展开/收起时让原生网页视图跟 chrome 一起滑（只在开合时跑，缩放窗口是瞬时的）。 */
/**
 * 等面板滑入结束再取图。⌘1 在面板刚打开时就会触发采集，若立刻按
 * `browserContentBounds()` 取区域，宽度还是 1px，截出来的图会被判太小。
 */
function waitForPanelSlide(): Promise<void> {
  if (panelSlide >= 1 || !panelLayout.open) return Promise.resolve()
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (panelSlide >= 1 || !panelLayout.open || Date.now() - startedAt > PANEL_SLIDE_MS + 200) {
        clearInterval(timer)
        resolve()
      }
    }, 16)
  })
}

function animatePanelSlide(): void {
  stopPanelSlide()
  const from = panelSlide
  const to = panelLayout.open ? 1 : 0
  if (from === to) {
    layout()
    syncPanelVisibility()
    return
  }
  const startedAt = Date.now()
  panelSlideTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - startedAt) / PANEL_SLIDE_MS)
    panelSlide = from + (to - from) * easePanel(t)
    layout()
    if (t >= 1) {
      stopPanelSlide()
      panelSlide = to
      layout()
      syncPanelVisibility()
    }
  }, 16)
  syncPanelVisibility()
}

/**
 * 重新算一遍布局并落到视图上。
 *
 * `animate` 只在用户开/合面板时为 true；窗口缩放时走瞬时（跟着窗口一起变才自然）。
 * 窗口太窄导致的自动收起也算"形态变化"，但那是缩放的副产品，一并瞬时处理。
 */
function applyPanel({ animate }: { animate: boolean }): void {
  if (!appWindow) return
  const { width } = appWindow.getContentBounds()
  const next = resolvePanelLayout({ windowWidth: width, prefs: panelPrefs })
  const openedChanged = next.open !== panelLayout.open
  panelLayout = next
  // 面板收起后网页视图被藏起来，采集却还挂着，用户会觉得"点了没反应"。
  // 收起即结束本次采集，界面那边同步清掉采集态。
  if (!next.open && captureSession.active) endCaptureSession(true)
  if (animate && openedChanged) animatePanelSlide()
  else {
    // 瞬时对齐：正在滑的话先掐掉，否则缩放窗口会把滑到一半的动画拽回去
    stopPanelSlide()
    panelSlide = next.open ? 1 : 0
    layout()
    syncPanelVisibility()
  }
  pushPanelLayout()
}

function persistPanelPrefs(): void {
  void savePanelPrefs(PANEL_PREFS_FILE, panelPrefs)
}

/**
 * 拖分栏线时的逐帧预览：**只**把网页视图挪到新宽度，不碰偏好、不落盘、不回推，
 * 也不重排画布视图（它铺满整窗、这几帧根本没变，重设一次就可能让 Pixi 白重排一轮）。
 * 拖完松手才由 `updatePanel({ ratio })` 正式提交。
 */
function previewPanelWidth(width: number): void {
  if (!appWindow || !panelLayout.open) return
  const { width: windowWidth } = appWindow.getContentBounds()
  const clamped = clampPanelWidth(width, windowWidth)
  panelLayout = { ...panelLayout, width: clamped, openWidth: clamped }
  browserTabs?.setBounds(browserContentBounds())
}

/**
 * 切换到文件夹侧栏时，原生网页必须立即退出，而不是跟着浏览器 chrome 滑 260ms。
 * 否则 WebContentsView 会压在新的空侧栏之上，短时间里会同时看到两套内容。
 */
function hideBrowserPanelImmediately(): PanelLayout {
  if (!panelPrefs.open) return panelLayout
  panelPrefs = { ...panelPrefs, open: false }
  persistPanelPrefs()
  applyPanel({ animate: false })
  return panelLayout
}

/** 界面（或自检）改面板设置的唯一入口：并偏好 → 补标签 → 落盘 → 重算并滑。 */
function updatePanel(patch: unknown): PanelLayout {
  const next = applyPanelPatch(panelPrefs, patch)
  const willOpen = next.open && !panelPrefs.open
  panelPrefs = next
  // 重新打开一个被关空的面板：补一张起始页，别让用户对着一片空白
  if (willOpen && browserTabs && browserTabs.getState().tabs.length === 0) browserTabs.ensureTab()
  persistPanelPrefs()
  applyPanel({ animate: true })
  return panelLayout
}

/** 载入画布那一页；首次打开与渲染进程崩溃后恢复都走这里。 */
function loadCanvasPage(): void {
  if (!canvasView) return
  if (isDev && rendererUrl) void canvasView.webContents.loadURL(rendererUrl)
  else void canvasView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
}

function createViews(): void {
  canvasView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  appWindow?.contentView.addChildView(canvasView)

  // 界面这一块崩了（不是退出，是渲染进程挂了）就自动拉起来一次；
  // 连着崩超过上限会停手，只留日志——见 crash-recovery.ts 里的说明
  attachCrashRecovery(canvasView.webContents as unknown as CrashSource, {
    label: '画布',
    logger,
    reload: loadCanvasPage
  })
}

function createWindow(): void {
  appWindow = new BaseWindow({
    width: 1500,
    height: 940,
    // 窗口可以一路压到很小：D3.7 让面板先收到 420、再自动收起，画布始终有事可做，
    // 所以不再用 minWidth 把窗口卡住，只留一个"还能用"的下限。
    minWidth: 720,
    minHeight: 640,
    title: 'InsPin',
    backgroundColor: '#F5F4F7'
  })

  createViews()

  // 缩放窗口要让面板跟着降级/恢复（D3.7），所以重算的不只是画布尺寸
  appWindow.on('resize', () => applyPanel({ animate: false }))
  // 用户去 Finder 删完图再点回 InsPin：回来一会儿后清掉，不等下次读画布。
  // 延后 + 限频，避免"刚切回窗口"这一下被同步的文件体检占住。
  appWindow.on('focus', () => pruneMissingSoon())
  appWindow.on('closed', () => {
    if (pruneSoonTimer !== null) {
      clearTimeout(pruneSoonTimer)
      pruneSoonTimer = null
    }
    appWindow = null
    canvasView = null
  })

  loadCanvasPage()

  layout()
  logger.info(LogEvent.windowCreated, { width: 1500, height: 940 })
}

/** 以图搜图的 IPC 通路。 */
function registerImageSearchIpc(service: ImageSearchService, acceptConsent: () => Promise<unknown>): void {
  ipcMain.handle(IpcChannel.imageSearchCatalog, () => catalogFor())
  ipcMain.handle(IpcChannel.imageSearchStart, async (_event, raw: unknown) => {
    const request = parseImageSearchRequest(raw)
    if (!request) return { ok: false, reason: 'unknown', message: '搜索请求不完整' }
    return service.start(request)
  })
  ipcMain.handle(IpcChannel.imageSearchCancel, () => {
    service.cancel()
  })
  ipcMain.handle(IpcChannel.imageSearchAcceptConsent, () => acceptConsent())
}

/** 浏览器标签的 IPC 通路（D3.1–D3.4）。 */
function registerBrowserIpc(tabs: BrowserTabs): void {
  ipcMain.handle(IpcChannel.browserGetState, () => tabs.getState())
  ipcMain.handle(IpcChannel.browserNewTab, (_event, url?: string) => tabs.newTab(url))
  ipcMain.handle(IpcChannel.browserCloseTab, (_event, id: string) => tabs.closeTab(id))
  ipcMain.handle(IpcChannel.browserActivateTab, (_event, id: string) => tabs.activateTab(id))
  ipcMain.handle(IpcChannel.browserMoveTab, (_event, id: string, to: number) => tabs.moveTab(id, to))
  ipcMain.handle(IpcChannel.browserNavigate, (_event, id: string, url: string) => tabs.navigate(id, url))
  ipcMain.handle(IpcChannel.browserCommand, (_event, id: string, command: BrowserCommand) =>
    tabs.command(id, command)
  )
  ipcMain.handle(IpcChannel.browserGetPanel, () => panelLayout)
  ipcMain.handle(IpcChannel.browserAddFavorite, (_event, favorite: unknown) => {
    if (!startPage) return false
    const payload = favorite as { url?: unknown; title?: unknown; favicon?: unknown } | null
    if (typeof payload?.url !== 'string') return false
    return startPage.addSource({
      url: payload.url,
      title: typeof payload.title === 'string' ? payload.title : '',
      favicon: typeof payload.favicon === 'string' ? payload.favicon : null
    })
  })
  ipcMain.handle(IpcChannel.browserRemoveFavorite, (_event, url: unknown) => {
    if (!startPage || typeof url !== 'string') return false
    return startPage.removeSource(url)
  })
  ipcMain.handle(IpcChannel.browserGetFavoriteUrls, () => startPage?.listSourceUrls() ?? [])
  ipcMain.handle(IpcChannel.browserSetPanel, (_event, patch: unknown) => updatePanel(patch))
  // 拖分栏线：每帧一次、只要结果不候回执（用 on 而不是 handle，省一次往返）
  ipcMain.on(IpcChannel.browserPanelPreview, (_event, width: unknown) => {
    // 预览是浏览器分栏唯一的高频路径；不要在主进程再套一层 timer。渲染端的
    // pointermove 到这里已经是最新位置，立刻 setBounds 才能让原生网页与 chrome
    // 同一拍跟手。它不写偏好、不广播布局，也不会触发画布重排。
    if (typeof width === 'number' && Number.isFinite(width)) previewPanelWidth(width)
  })
  ipcMain.handle(IpcChannel.browserPanelHideImmediate, () => hideBrowserPanelImmediately())
  ipcMain.on(IpcChannel.browserSetCovered, (_event, covered: unknown) => {
    overlayCoversBrowser = covered === true
    syncPanelVisibility()
  })
}

/** 参考快照浮窗（D5）。主窗口一就绪就建好，之后创建/恢复都走它。 */
let snapshotManager: SnapshotManager | null = null

/** 参考快照的 IPC 通路。创建来自主窗口，其余来自浮窗自己（按 webContents 认人）。 */
function registerSnapshotIpc(manager: SnapshotManager): void {
  ipcMain.handle(IpcChannel.snapshotCreate, (_event, projectId: unknown, sourceIds: unknown) =>
    manager.create(projectId, sourceIds)
  )

  const idOf = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): string | null =>
    manager.idForWebContents(event.sender.id)

  ipcMain.handle(IpcChannel.snapshotGet, (event) => {
    const id = idOf(event)
    return id ? manager.view(id) : null
  })

  ipcMain.handle(IpcChannel.snapshotUpdate, (event, patch: unknown) => {
    const id = idOf(event)
    return id ? manager.update(id, patch) : null
  })

  ipcMain.handle(IpcChannel.snapshotRefresh, (event) => {
    const id = idOf(event)
    return id ? manager.refresh(id) : null
  })

  ipcMain.handle(IpcChannel.snapshotClose, (event) => {
    const id = idOf(event)
    if (id) manager.close(id)
  })

  // 右键弹系统菜单、拖动都是"只做不候回执"的（用 on 省一次往返）
  ipcMain.on(IpcChannel.snapshotMenu, (event) => {
    const id = idOf(event)
    if (id) manager.popupMenu(id)
  })

  ipcMain.on(IpcChannel.snapshotHover, (event, over: unknown) => {
    const id = idOf(event)
    if (id) manager.hoverControls(id, over === true)
  })

  ipcMain.on(IpcChannel.snapshotDrag, (event, payload: unknown) => {
    const id = idOf(event)
    if (id) manager.drag(id, payload)
  })
}

/**
 * 区域截图（D3.16）。抓下来的图一直留在 `captureSession` 里、中途不重抓——
 * 冻结采集时原生视图会藏起来，在被隐藏的视图上 `capturePage()` 会挂住不返回。
 */
function registerCaptureIpc(): void {
  ipcMain.handle(IpcChannel.browserCaptureStart, async (_event, rawMode: unknown): Promise<CaptureStartResult> => {
    const view = browserTabs?.activeView()
    if (!view || !panelLayout.open) return { ok: false, message: '先打开浏览器面板' }
    // 面板可能正在滑入（快捷键刚把它打开），等可见区域稳定后再截
    await waitForPanelSlide()
    if (captureSession.hidesBrowser) return { ok: false, message: '正在截图，请稍候' }
    const mode: CaptureMode = rawMode === 'collect' ? 'collect' : 'capture'
    const freezePage = mode !== 'collect' || applicationSettings.freezeSmartCollection
    const bounds = browserContentBounds()
    // 只有智能采集读取页面结构；普通截图保持原有的即时自由框选体验。
    const candidatesPromise: Promise<CaptureCandidateCollection> =
      mode === 'collect'
        ? collectCaptureCandidates(view.webContents, bounds)
        : Promise.resolve({
            candidates: [],
            originalUrls: new Map(),
            sourceUrls: new Map(),
            viewportWidth: 1,
            viewportHeight: 1
          })
    let image: Electron.NativeImage
    try {
      image = await view.webContents.capturePage()
    } catch (error) {
      logger.error(LogEvent.browserLoadFailed, {
        description: '截取浏览区失败',
        message: error instanceof Error ? error.message : String(error)
      })
      return { ok: false, message: '没能截到这个页面' }
    }
    const collection = await candidatesPromise
    const pageUrl = view.webContents.getURL() || null
    const result = captureSession.begin(image, bounds, collection, pageUrl, mode, freezePage)
    if (result.ok) {
      const size = image.getSize()
      logger.info(LogEvent.captureStarted, {
        box: bounds,
        imageWidth: size.width,
        imageHeight: size.height,
        bytes: image.toPNG().length,
        candidateCount: collection.candidates.length,
        mode
      })
      // 冻结模式沿用原来的截图覆盖层；非冻结智能采集留着网页，可继续滚动。
      if (freezePage) {
        syncPanelVisibility()
        focusCanvas()
      } else {
        startLiveCollection(view.webContents)
      }
    } else {
      logger.error(LogEvent.captureDiscarded, { reason: result.message, box: bounds })
    }
    return result
  })

  ipcMain.handle(IpcChannel.browserCaptureCancel, () => endCaptureSession())

  /**
   * 智能采集中切换「滚动屏幕 / 锁定屏幕」。
   *
   * 两个方向的代价差别很大：
   *   - 切到滚动：不需要抓图，点选时本来就会现抓，翻标记、露出网页即可；
   *   - 切到锁定：网页是露着的，可以截；但必须先等注入的压暗层画掉，
   *     否则会被截进素材。候选结构在等待期间并行采样，不占关键路径。
   * 切换只换 pending 这一帧，连续采集的排布锚点保持不动。
   */
  ipcMain.handle(
    IpcChannel.browserCaptureSwitch,
    async (_event, raw: unknown): Promise<CaptureStartResult> => {
      const freezePage = raw === true
      const view = browserTabs?.activeView()
      if (!view || !panelLayout.open) return { ok: false, message: '先打开浏览器面板' }
      if (!captureSession.active || captureSession.mode !== 'collect') {
        return { ok: false, message: '采集已经结束' }
      }
      if (captureSession.hidesBrowser === freezePage) {
        return { ok: false, message: '已经是这个模式了' }
      }
      if (liveCollectionClickPending) return { ok: false, message: '正在收下这张，稍等一下' }

      // 滚动屏幕：轻量路径，不做任何抓图。
      if (!freezePage) {
        const live = captureSession.switchToLive()
        if (!live) return { ok: false, message: '切换没有成功，请重新进入采集' }
        browserTabs?.setPanelVisible(panelLayout.open || panelSlide > 0)
        syncPanelVisibility()
        startLiveCollection(view.webContents)
        logger.info(LogEvent.captureStarted, { switched: true, freezePage: false })
        return live
      }

      // 锁定屏幕：等遮罩画掉再截；候选采样与等待并行。
      stopLiveCollection()
      const bounds = browserContentBounds()
      const pageUrl = view.webContents.getURL() || null
      let image: Electron.NativeImage
      let collection: CaptureCandidateCollection
      try {
        const [nextCollection, nextImage] = await Promise.all([
          collectCaptureCandidates(view.webContents, bounds),
          (async () => {
            await waitForPagePaint(view.webContents)
            return view.webContents.capturePage()
          })()
        ])
        collection = nextCollection
        image = nextImage
      } catch (error) {
        logger.error(LogEvent.browserLoadFailed, {
          description: '切换采集模式时截取页面失败',
          message: error instanceof Error ? error.message : String(error)
        })
        // 截图中途用户可能已经退出采集；只有会话还在时才把网页模式接回去。
        if (captureSession.active) startLiveCollection(view.webContents)
        syncPanelVisibility()
        return { ok: false, message: '没能截到这个页面' }
      }

      const result = captureSession.switchMode(image, bounds, collection, pageUrl, true)
      if (!result) {
        if (captureSession.active) startLiveCollection(view.webContents)
        syncPanelVisibility()
        return { ok: false, message: '切换没有成功，请重新进入采集' }
      }
      syncPanelVisibility()
      focusCanvas()
      logger.info(LogEvent.captureStarted, {
        switched: true,
        freezePage: true,
        candidateCount: collection.candidates.length
      })
      return result
    }
  )

  ipcMain.on(IpcChannel.browserSmartCollectClick, (event, point: unknown) => {
    collectLiveSmartCandidate(event.sender, point)
  })

  ipcMain.handle(IpcChannel.assetsImportCapture, async (_event, projectId, raw: unknown) => {
    const commit = sanitizeCaptureCommit(raw)
    const pageUrl = captureSession.pageUrl
    const originalUrl = captureSession.originalUrlFor(commit?.candidateId)
    const sourceUrl = captureSession.sourceUrlFor(commit?.candidateId) ?? pageUrl
    const continuous = commit?.continuous === true
    const placement = continuous && commit?.candidateId
      ? captureSession.collectionPlacement(commit.center)
      : { at: null, center: commit?.center ?? null }
    const cropped = commit ? captureSession.crop(commit.selection, continuous) : null
    if (!commit) {
      stopLiveCollection()
      captureSession.cancel()
    }
    // 连续采集保留当前模式；单次采集立刻退出，别留下失效的网页点击拦截。
    if (!continuous) {
      stopLiveCollection()
      syncPanelVisibility()
    }
    if (!cropped) {
      logger.error(LogEvent.captureDiscarded, {
        reason: commit ? '框选太小或没有可裁的图' : '提交的形状不合法',
        selection: commit?.selection ?? raw
      })
      return { ok: false, message: '框选的范围太小了，再框大一点' }
    }
    const deps = { db, assetsDir: dataPaths.assets, measure: measureImage, logger, thumbnails }
    if (originalUrl) {
      const original = await importSmartOriginal(
        { ...deps, fetchImpl: browserFetch },
        projectId,
        { url: originalUrl, pageUrl: sourceUrl, center: placement.center, at: placement.at }
      )
      if (original.ok && original.importedCount > 0) {
        if (continuous) captureSession.rememberCollectionNode(original.importedNode)
        return { ...original, collectionKind: 'original' }
      }
    }

    const fallback = await importCapturedBytes(
      deps,
      projectId,
      {
        bytes: cropped.bytes,
        width: cropped.width,
        height: cropped.height,
        center: placement.center,
        at: placement.at,
        pageUrl: sourceUrl,
        importMethod: commit?.candidateId ? 'collect' : 'capture',
        name: commit?.candidateId ? '智能采集截图.png' : '网页截图.png'
      }
    )
    if (continuous && fallback.ok && fallback.importedCount > 0) {
      captureSession.rememberCollectionNode(fallback.importedNode)
    }
    return commit?.candidateId && fallback.ok ? { ...fallback, collectionKind: 'screenshot' } : fallback
  })
}

/** 截图提交的形状校验：形状不对就当没框，别让坏数据走到裁剪那一步。 */
export function sanitizeCaptureCommit(raw: unknown): CaptureCommit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { selection, center, candidateId, continuous } = raw as {
    selection?: unknown
    center?: unknown
    candidateId?: unknown
    continuous?: unknown
  }
  if (typeof selection !== 'object' || selection === null) return null
  const box = selection as Record<string, unknown>
  const numbers = [box['x'], box['y'], box['width'], box['height']]
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  if ((box['width'] as number) <= 0 || (box['height'] as number) <= 0) return null

  const point =
    typeof center === 'object' && center !== null ? (center as { x?: unknown; y?: unknown }) : null
  const candidate = typeof candidateId === 'string' && candidateId.length > 0 && candidateId.length <= 128 ? candidateId : null
  return {
    selection: {
      x: box['x'] as number,
      y: box['y'] as number,
      width: box['width'] as number,
      height: box['height'] as number
    },
    center:
      point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: point.x as number, y: point.y as number }
        : null,
    candidateId: candidate,
    continuous: continuous === true
  }
}

logger.info(LogEvent.appStart, {
  appVersion: app.getVersion(),
  channel: RELEASE_CHANNEL,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  dataRoot: dataPaths.root
})
logger.info(LogEvent.dbOpened, {
  file: dataPaths.databaseFile,
  schemaVersion: schemaVersion(db)
})
if (isDev) console.log('[ins-pin] 数据目录:', dataPaths.root)

/**
 * 开发版和测试包直接跑 Electron 运行时，程序坞默认显示 Electron 图标。
 * 这里从构建目录读品牌图标替换；正式安装包由 electron-builder 写进 bundle。
 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return
  const candidates = [
    join(__dirname, '../../build/icon.png'), // 开发仓库：out/main → ins-pin/build
    join(__dirname, '../../icon.png') // 测试包：InsPin/out/main → InsPin/icon.png
  ]
  const iconPath = candidates.find((path) => existsSync(path))
  if (!iconPath) return
  const icon = nativeImage.createFromPath(iconPath)
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

app.whenReady().then(async () => {
  // 第三方网页的摄像头/麦克风/定位等权限一律默认拒绝（登录、播放等不受影响）
  hardenThirdPartySession(session.fromPartition(BROWSER_PARTITION))

  // 协议处理器只能在 ready 之后挂上
  serveAssets({
    assetsDir: dataPaths.assets,
    thumbnails,
    resolveLinkedAsset: (folderId, relativePath) =>
      resolveLinkedAssetPathAsync(db, folderId, relativePath)
  })

  startPage = await startStartPageServer({ sourcesFile: START_SOURCES_FILE }).catch((error: unknown) => {
    logger.error(LogEvent.browserLoadFailed, {
      description: '起始页服务启动失败',
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  })
  if (startPage) logger.info(LogEvent.startPageReady, { url: startPage.url })

  // 设置入口：程序坞右键、应用菜单都汇到这一个口子，界面那边统一开设置面板
  const openSettings = (tab: SettingsTab): void => {
    canvasView?.webContents.send(IpcChannel.settingsOpen, tab)
  }
  installAppMenu({ logger, logDir: dataPaths.logs, dataRoot: dataPaths.root, openSettings })

  // 程序坞右键菜单（用户要的入口）；非 macOS 没有 dock，跳过。
  // 有快照浮窗时才多出"关穿透 / 解锁"两项——穿透开着的浮窗点不到自己，
  // 这是关掉它唯一的兜底出口（D5.3）。条数变了就重摆一次菜单。
  const refreshDockMenu = (): void => {
    app.dock?.setMenu(
      buildDockMenu({
        open: openSettings,
        snapshots: {
          count: snapshotManager?.count() ?? 0,
          unlockAll: () => snapshotManager?.unlockAll()
        }
      })
    )
  }

  snapshotManager = createSnapshotManager({
    logger,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: isDev && rendererUrl ? rendererUrl : null,
    mainDir: __dirname,
    readSource: readSnapshotSource,
    persist: (records: SnapshotRecord[]) => {
      if (SMOKE) return
      void saveSnapshots(SNAPSHOTS_FILE, records)
    },
    newId: () => randomUUID(),
    window: () => appWindow,
    now: () => new Date().toISOString(),
    ephemeral: SMOKE,
    onChange: refreshDockMenu
  })
  refreshDockMenu()

  // 面板停在哪一侧、拖了多宽——上次怎么用的就怎么回来（自检时一律用默认值，
  // 否则上一轮拖过的宽度会让自检结果不确定）
  panelPrefs = SMOKE ? { ...DEFAULT_PANEL_PREFS } : await loadPanelPrefs(PANEL_PREFS_FILE)

  // 设置也先读回来：快捷键要赶在界面首次渲染前就位，素材清理策略也要立刻生效。
  applicationSettings = SMOKE ? normalizeSettings(null) : await loadSettings(SETTINGS_FILE)
  // 启动时浏览器开不开由设置决定，不再沿用"上次关掉"的状态。
  panelPrefs = { ...panelPrefs, open: applicationSettings.openBrowserOnLaunch }

  const publishSettings = (): void => {
    canvasView?.webContents.send(IpcChannel.settingsChanged, applicationSettings)
    // 改键后网页里的中键也要跟着换，不然要等下一次刷新页面
    browserTabs?.syncMouseShortcuts()
  }
  ipcMain.handle(IpcChannel.settingsGet, () => applicationSettings)
  ipcMain.handle(IpcChannel.settingsUpdate, async (_event, patch: unknown) => {
    applicationSettings = mergeSettings(applicationSettings, patch)
    if (!SMOKE) {
      try {
        await saveSettings(SETTINGS_FILE, applicationSettings)
      } catch (error) {
        logger.error(LogEvent.mainUncaught, {
          description: '设置保存失败',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    publishSettings()
    return applicationSettings
  })
  ipcMain.handle(IpcChannel.settingsReset, async () => {
    applicationSettings = normalizeSettings(DEFAULT_SETTINGS)
    if (!SMOKE) {
      try {
        await saveSettings(SETTINGS_FILE, applicationSettings)
      } catch (error) {
        logger.error(LogEvent.mainUncaught, {
          description: '设置保存失败',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    publishSettings()
    return applicationSettings
  })

  // 浏览器标签：先恢复上次的（或开一个起始页），再把视图挂到窗口上
  browserTabs = new BrowserTabs({
    window: () => appWindow,
    partition: BROWSER_PARTITION,
    browserPreloadPath: join(__dirname, '../preload/browser.js'),
    startPageUrl: () => startPage?.url ?? null,
    contentBounds: browserContentBounds,
    // 自检一律从干净的起始页开始，而且**不写回**：否则跑一次 `npm run smoke`
    // 就会把用户真实的标签页覆盖成起始页，自检结果也会随"上次浏览到哪儿"而变。
    restore: () => (SMOKE ? Promise.resolve(null) : loadBrowserTabs(BROWSER_TABS_FILE)),
    persist: (state) => {
      if (SMOKE) return
      void saveBrowserTabs(BROWSER_TABS_FILE, serializeTabs(state))
    },
    newId: () => randomUUID(),
    logger,
    mouseShortcuts: browserMouseShortcuts,
    handleShortcut: (input, webContents) => {
      // 非冻结采集时焦点在网页里：Esc 只有这里收得到，必须在这里退出
      if (input.key === 'Escape' && liveCollectionPage === webContents) {
        endCaptureSession(true)
        return true
      }
      const key = {
        key: input.key,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        metaKey: input.meta
      }
      // 网页有焦点时键盘事件到不了画布，智能采集在这里转一手
      if (matchesAccelerator(key, applicationSettings.shortcuts.smartCollect)) {
        canvasView?.webContents.send(IpcChannel.browserSmartCollectRequested)
        return true
      }
      // 采集进行中才接管"切换锁定 / 滚动屏幕"，否则把组合还给网页
      if (
        matchesAccelerator(key, applicationSettings.shortcuts.toggleCollectMode) &&
        captureSession.active &&
        captureSession.mode === 'collect'
      ) {
        canvasView?.webContents.send(IpcChannel.browserToggleCollectModeRequested)
        return true
      }
      if (!matchesAccelerator(key, applicationSettings.shortcuts.newTab)) return false
      void browserTabs?.newTab()
      return true
    }
  })
  registerBrowserIpc(browserTabs)
  const imageSearchService = new ImageSearchService({
    db,
    assetsDir: dataPaths.assets,
    openPanel: () => {
      updatePanel({ open: true })
    },
    openTab: (url) => browserTabs?.openSearchTab(url) ?? null,
    markSearchTab: (tabId, engineId) => browserTabs?.markSearchTab(tabId, engineId),
    hasConsent: () => applicationSettings.imageSearchConsent,
    onStage: (engineId, stage) => {
      canvasView?.webContents.send(IpcChannel.imageSearchProgress, { engineId, stage })
    },
    logger
  })
  registerImageSearchIpc(imageSearchService, async () => {
    applicationSettings = mergeSettings(applicationSettings, { imageSearchConsent: true })
    if (!SMOKE) {
      try {
        await saveSettings(SETTINGS_FILE, applicationSettings)
      } catch (error) {
        logger.error(LogEvent.mainUncaught, {
          description: '设置保存失败',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    publishSettings()
    return applicationSettings
  })
  // 网页预加载层转来的中键动作：只认我们自己开的标签页，也只执行白名单里的两个
  ipcMain.on(IpcChannel.browserMouseShortcut, (event, rawAction: unknown) => {
    if (!browserTabs?.owns(event.sender)) return
    if (rawAction === 'smartCollect') {
      canvasView?.webContents.send(IpcChannel.browserSmartCollectRequested)
    } else if (rawAction === 'newTab') {
      void browserTabs.newTab()
    }
  })
  registerCaptureIpc()
  await browserTabs.init()

  createWindow()
  // 测试包是脚本拉起的，程序不会自动抢到前台；显式显示 Dock 图标并聚焦，
  // 避免"有时候有图标、有时候没有"以及窗口开在别的应用后面。
  if (!SMOKE && process.platform === 'darwin') {
    applyDockIcon()
    app.dock?.show()
    app.focus({ steal: true })
  }
  browserTabs.attach()
  // 首帧就把面板几何摆好（窗口真实宽度此时才知道，不能沿用模块级的 1500 估值）
  applyPanel({ animate: false })
  // 状态一变就推给界面（标题、加载态、前进后退可用性…）
  let lastActiveTabId = browserTabs.getState().activeId
  browserTabs.subscribe((state) => {
    // 采集绑在当前网页上：切走标签后，页面里的高亮和点击拦截都留在旧标签，
    // 新标签不会有任何反应。直接结束这次采集，界面同步清掉采集态。
    if (state.activeId !== lastActiveTabId) {
      lastActiveTabId = state.activeId
      if (captureSession.active) endCaptureSession(true)
    }
    canvasView?.webContents.send(IpcChannel.browserStateChanged, state)
  })

  // 「数据与备份」设置页背后的通路（D6a.1–D6a.3 + D6b.1）
  registerDataIpc({
    ipc: ipcMain,
    db,
    dataRoot: dataPaths.root,
    assetsDir: dataPaths.assets,
    logger,
    appVersion: app.getVersion(),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    pickDirectory,
    pickArchive: (options) => pickDirectory({ title: options.title, buttonLabel: '选这个' }),
    exportDiagnostics: () => runDiagnosticsExport({ logger, logDir: dataPaths.logs, dataRoot: dataPaths.root }),
    clearBrowsingData: async () => {
      // 只清浏览器那半边：素材、项目、数据库都不碰
      const browserSession = session.fromPartition(BROWSER_PARTITION)
      await browserSession.clearStorageData()
      await browserSession.clearCache()
      browserTabs?.resetToStartPage()
    },
    reveal: (path) => {
      void shell.openPath(path)
    },
    libraryUsage: () => libraryUsage(db),
    cleanupLibrary: () => cleanupLibraryNow(localLibraryDeps)
  })

  registerSnapshotIpc(snapshotManager)
  // 上次的快照摆回来（D5.6）：内容已经冻结在记录里，不需要源项目也在
  if (!SMOKE) snapshotManager.restore(await loadSnapshots(SNAPSHOTS_FILE))

  // 补算离线期间经过的 3 天/30 天。放在快照恢复之后：只被快照用到的素材
  // 也算“在用”。不挡在窗口出现之前，素材多时这段扫表不该拖慢启动。
  void reconcileLibrary(localLibraryDeps).catch((error: unknown) => {
    logger.error(LogEvent.mainUncaught, {
      description: '素材保留策略校准失败',
      message: error instanceof Error ? error.message : String(error)
    })
  })

  if (SMOKE) await runSmoke()
})

/** 让用户挑一个文件夹（备份 / 导出的去处）；取消返回 null。 */
async function pickDirectory(options: { title: string; buttonLabel: string }): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: options.title,
    buttonLabel: options.buttonLabel,
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null)
}

/**
 * 自检用的种子数据：一个项目 + 一张图，图指向**一条不存在的素材**。
 *
 * 自检跑在内存库上（见文件开头），所以这里直接写库不会有任何副作用；
 * 故意指向不存在的素材，是为了顺带验证 D5.6 的"源素材缺失"占位那条路。
 */
function seedSnapshotProject(): { projectId: string; nodeId: string } {
  const projectId = 'smoke-project'
  const nodeId = 'smoke-node'
  const now = new Date().toISOString()
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    projectId,
    '自检项目',
    now,
    now
  )
  db.prepare(
    `INSERT INTO nodes
       (id, project_id, parent_id, ordinal, type, name, visible, locked, x, y, w, h, rotation, props)
     VALUES (?, ?, NULL, 0, 'asset', '自检图片', 1, 0, 0, 0, 200, 120, 0, ?)`
  ).run(
    nodeId,
    projectId,
    JSON.stringify({ assetId: 'smoke-missing-asset', naturalWidth: 200, naturalHeight: 120 })
  )
  return { projectId, nodeId }
}

async function runSmoke(): Promise<void> {
  const canvas = canvasView
  const activeTab = browserTabs?.activeWebContents()
  const browser = browserTabs?.activeView()
  if (!appWindow || !canvas || !browser || !activeTab || !startPage) {
    console.error('自检无法开始：视图未就绪')
    await logger.close()
    app.exit(1)
    return
  }

  await Promise.all([waitForIdle(canvas), waitForIdle(browser)])

  const { width, height } = appWindow.getContentBounds()
  const checks = await runSmokeTest({
    contentWidth: width,
    contentHeight: height,
    browserBounds: browser.getBounds(),
    canvasBounds: canvas.getBounds(),
    panel: panelLayout,
    chromeHeight: BROWSER_CHROME_HEIGHT,
    panelGutter: PANEL_CARD_GUTTER,
    canvasView: canvas,
    browserView: browser,
    startPageUrl: startPage.url,
    logger
  })

  // 面板几何（D3.5–D3.7）：真的切停靠、缩窗口，核对原生视图跟没跟上
  checks.push(
    ...(await runPanelSmokeChecks({
      update: (patch) => updatePanel(patch),
      browserBounds: () => browserTabs?.activeView()?.getBounds() ?? null,
      panelGutter: PANEL_CARD_GUTTER,
      windowWidth: () => appWindow?.getContentBounds().width ?? 0,
      resizeWindow: (w, h) => appWindow?.setContentSize(w, h),
      settle: () => new Promise((resolve) => setTimeout(resolve, 350)),
      originalSize: { width, height },
      canvasView: canvas
    }))
  )

  // 参考快照（D5）：造一条真的快照，核对浮窗的置顶/可见性与各项开关
  if (snapshotManager) {
    const manager = snapshotManager
    checks.push(
      ...(await runSnapshotSmokeChecks({
        seed: seedSnapshotProject,
        create: (projectId, sourceIds) => manager.create(projectId, sourceIds),
        view: (id) => manager.view(id),
        update: (id, patch) => manager.update(id, patch),
        openMenu: (id) => manager.popupMenu(id),
        move: (id, x, y) => {
          manager.drag(id, { phase: 'start', offsetX: 0, offsetY: 0 })
          manager.drag(id, { phase: 'move', screenX: x, screenY: y })
          manager.drag(id, { phase: 'end' })
        },
        close: (id) => manager.close(id),
        inspect: (id) => {
          const win = manager.windowOf(id)
          if (!win) return null
          const [w, h] = win.getContentSize()
          const [x, y] = win.getPosition()
          return {
            visible: win.isVisible(),
            alwaysOnTop: win.isAlwaysOnTop(),
            onAllWorkspaces: win.isVisibleOnAllWorkspaces(),
            opacity: win.getOpacity(),
            position: { x: x ?? 0, y: y ?? 0 },
            size: { width: w ?? 0, height: h ?? 0 }
          }
        },
        inspectMenu: (id) => {
          const menu = manager.menuWindowOf(id)
          if (!menu) return null
          const [w, h] = menu.getContentSize()
          const [x, y] = menu.getPosition()
          return {
            visible: menu.isVisible(),
            position: { x: x ?? 0, y: y ?? 0 },
            size: { width: w ?? 0, height: h ?? 0 }
          }
        },
        dragMenuZoom: async (id, values) => {
          const menu = manager.menuWindowOf(id)
          if (!menu || menu.isDestroyed()) return false
          return menu.webContents.executeJavaScript(`
            (async () => {
              const range = document.querySelector('input[type="range"][aria-label^="缩放"]')
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
              if (!(range instanceof HTMLInputElement) || !setter) return false
              for (const value of ${JSON.stringify(values)}) {
                setter.call(range, String(value))
                range.dispatchEvent(new Event('input', { bubbles: true }))
                await new Promise((resolve) => setTimeout(resolve, 24))
              }
              return true
            })()
          `) as Promise<boolean>
        },
        settle: () => new Promise((resolve) => setTimeout(resolve, 50))
      }))
    )
  }

  // 采集生命周期：切标签 / 收面板 / 刷网页都必须结束采集，不能留下"点了没反应"
  checks.push(
    ...(await runCaptureSmokeChecks({
      canvasView: canvas,
      browserView: browser,
      captureActive: () => captureSession.active,
      settle: () => new Promise((resolve) => setTimeout(resolve, 350))
    }))
  )

  logSmokeResult(checks, logger)
  console.log(`\n${formatSmokeReport(checks)}\n`)

  const failed = checks.some((check) => !check.ok)
  await logger.close()
  app.exit(failed ? 1 : 0)
}

app.on('window-all-closed', () => app.quit())

let quitFlushed = false
app.on('will-quit', (event) => {
  if (quitFlushed) return
  quitFlushed = true
  event.preventDefault()
  stopPanelSlide()
  snapshotManager?.dispose()
  browserTabs?.dispose()
  startPage?.close()
  db.close()
  logger.info(LogEvent.appQuit)
  void logger.close().then(() => app.quit())
})
