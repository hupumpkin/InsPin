import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  IpcChannel,
  type AssetInfo,
  type CanvasLoadResult,
  type ImportMethod,
  type ImportResult,
  type Viewport,
  type WebDropRequest
} from '../shared/ipc'
import { createCanvasElementNode, TEXT_PADDING, type ProjectGraph } from '../shared/node'
import { getAsset } from './assets'
import {
  countRootNodes,
  displaySizeFor,
  importImageFiles,
  importOneImage,
  messageFor,
  placementFor,
  type ImageMeasurer,
  type ImportFailure,
  type ImportedNode,
  type ImportOutcome
} from './import-files'
import { LogEvent } from './logger'
import { loadGraph, saveGraph, upsertNode } from './nodes'
import { updateAssetReferenceClocks } from './asset-retention'
import { getProject, updateViewport } from './projects'
import type { IpcHandlerRegistrar, ProjectLogSink } from './projects-ipc'
import type { ThumbnailService } from './thumbnails-service'
import { importFromWeb, NO_USABLE_ADDRESS } from './web-import'
import type { FetchLike } from './download'
import { isAutoLayoutContainer } from '../shared/auto-layout'
import { createMoveNodesToParentCommand } from '../shared/tree-commands'

/**
 * 画布读取、素材导入（本地文件 D1.4 / 剪贴板 D1.5）的 IPC 通路。
 *
 * 与 `projects-ipc.ts` 同样的分工：这里只做"校边界 + 串流程 + 记日志"，
 * 真正的落盘与建节点在 `import-files.ts`，读画布在 `nodes.ts`。
 */

/** 打开系统文件选择器；注入进来，测试时不用弹真的对话框。 */
export type FilePicker = () => Promise<{ canceled: boolean; paths: string[] }>

/** 从系统剪贴板取一张图；没有图返回 null。（Electron 的 clipboard 由调用方注入） */
export interface ClipboardImage {
  name: string
  bytes: Uint8Array
  width: number
  height: number
}

/** 纯文本从剪贴板进画布时始终使用文本工具的默认外观，不保留来源格式。 */
export interface ClipboardText {
  text: string
}

export type ClipboardContent = ClipboardImage | ClipboardText
export type ClipboardImageReader = () => Promise<ClipboardContent | ClipboardContent[] | null>

/** 剪贴板内容暂时读不出来时的提示。 */
export const NO_CLIPBOARD_CONTENT = '剪贴板里没有可导入的图片、SVG 或文本'

/**
 * 从剪贴板项声明的 MIME 类型里挑一个图片类型。
 * 优先 PNG：它是无损的、我们下游按文件头也一定认。
 */
export function pickImageMimeType(types: string[]): string | null {
  if (types.includes('image/png')) return 'image/png'
  return types.find((type) => type.startsWith('image/')) ?? null
}

/**
 * 剪贴板里的 SVG 在不同应用中有两种形态：规范的 `image/svg+xml`，或直接放在
 * `text/plain` / `text/html` 的原始 `<svg>` 文本。后两者必须交给 SVG 校验再决定，
 * 所以只在这里把它们纳入候选。普通 `text/plain` 会在 SVG 识别失败后回退为默认文本框。
 *
 * 保留矢量优先：有 SVG 文本时先尝试它；如果它不是 SVG，读取方会自然继续到 PNG 等
 * 位图候选，既不丢内容，也不改变现有图片粘贴行为。
 */
export function rankedClipboardAssetTypes(types: string[]): string[] {
  const rank = (type: string): number => {
    if (type === 'image/svg+xml') return 0
    if (type === 'text/uri-list') return 1
    if (type === 'text/plain') return 2
    if (type === 'text/html') return 3
    if (type === 'image/png') return 4
    return 5
  }

  return types
    .filter(
      (type) =>
        type.startsWith('image/') ||
        type === 'text/uri-list' ||
        type === 'text/plain' ||
        type === 'text/html'
    )
    .sort((a, b) => rank(a) - rank(b))
}

export interface CanvasIpcDeps {
  ipc: IpcHandlerRegistrar
  db: DatabaseSync
  assetsDir: string
  measure: ImageMeasurer
  pickFiles: FilePicker
  readClipboardImage: ClipboardImageReader
  /**
   * 取网页图片用的 fetch。**必须是浏览器那个会话的 `fetch`**——
   * 登录态和 referrer 都在它身上，用全局 fetch 会被图床当外部盗链挡掉。
   */
  fetchImpl: FetchLike
  /** 缩略图服务；导入后顺手预热（D1.7）。测试可不传 */
  thumbnails?: ThumbnailService
  /**
   * 读画布前先清掉"原图已被外部删除"的素材与节点。
   * 界面拿到的图里就不该再有只会显示成占位的节点；测试可不传。
   */
  pruneMissing?: () => void
  logger: ProjectLogSink
}

/** 一次最多导入多少个文件，挡住异常输入把主进程拖死。 */
const MAX_FILES_PER_IMPORT = 100

/**
 * 画布里用到的素材信息（按 assetId 索引），只送文件名、不送路径。
 *
 * 给了 `assetsDir` 就顺带判断原图还在不在磁盘上（D6a.3）：界面据此画占位框、
 * 挂"素材缺失"标签。检查放在主进程是因为渲染进程够不着文件系统。
 */
export function collectAssetInfos(
  db: DatabaseSync,
  graph: ProjectGraph,
  assetsDir?: string
): Record<string, AssetInfo> {
  const infos: Record<string, AssetInfo> = {}
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== 'asset') continue
    const assetId = node.props.assetId
    if (infos[assetId]) continue
    const asset = getAsset(db, assetId)
    if (!asset) continue
    infos[assetId] = {
      id: asset.id,
      fileName: asset.fileName,
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      importMethod: asset.importMethod,
      createdAt: asset.createdAt,
      sourceUrl: asset.sourceUrl,
      pageUrl: asset.pageUrl,
      ...(assetsDir && !existsSync(join(assetsDir, asset.fileName)) ? { missing: true } : {})
    }
  }
  return infos
}

export function loadCanvas(
  db: DatabaseSync,
  projectId: unknown,
  assetsDir?: string
): CanvasLoadResult {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { ok: false, message: '没有指定项目' }
  }
  const project = getProject(db, projectId)
  if (!project) {
    return { ok: false, message: '项目不存在' }
  }
  const graph = loadGraph(db, projectId)
  return {
    ok: true,
    graph,
    assets: collectAssetInfos(db, graph, assetsDir),
    viewport: { x: project.viewportX, y: project.viewportY, zoom: project.viewportZoom }
  }
}

/**
 * 把编辑后的整张画布写回库（D2.6–D2.8 的落盘部分）。
 *
 * 用全量写（`saveGraph` 清空再写、单事务）：编辑走的是"命令 → 新图"，渲染侧本来就是
 * 一整份图，整份写回最简单也最不容易出错。节点规模大了再考虑增量写（D6b）。
 */
export function applyGraph(db: DatabaseSync, projectId: unknown, raw: unknown): boolean {
  const checked = requireProject(db, projectId, '没有指定项目')
  if (typeof checked !== 'string') return false
  if (!isGraphLike(raw)) return false

  saveGraph(db, { ...raw, projectId: checked })
  updateAssetReferenceClocks(db)
  return true
}

/** 只做形状校验：渲染侧是我们自己的代码，但边界上仍不该把坏数据写进库。 */
function isGraphLike(raw: unknown): raw is ProjectGraph {
  if (typeof raw !== 'object' || raw === null) return false
  const graph = raw as { rootIds?: unknown; nodes?: unknown }
  return Array.isArray(graph.rootIds) && typeof graph.nodes === 'object' && graph.nodes !== null
}

/** 存一次视图位置（D2.12）。界面上是防抖后调用，不逐帧写库。 */
export function saveViewport(db: DatabaseSync, projectId: unknown, raw: unknown): void {
  const checked = requireProject(db, projectId, '没有指定项目')
  if (typeof checked !== 'string') return

  const viewport = sanitizeViewport(raw)
  if (!viewport) return
  updateViewport(db, checked, viewport)
}

/** 非法数值（NaN / 无穷 / 非对象）一律丢掉，别把库写坏。 */
export function sanitizeViewport(raw: unknown): Viewport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { x, y, zoom } = raw as { x?: unknown; y?: unknown; zoom?: unknown }
  const nums = [x, y, zoom]
  if (!nums.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  const zoomValue = zoom as number
  if (zoomValue <= 0) return null
  return { x: x as number, y: y as number, zoom: zoomValue }
}

/** 只保留字符串路径并限个数，防止异常输入。 */
function sanitizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, MAX_FILES_PER_IMPORT)
}

/** 每次导入都要做的事：写日志、把最新画布读回去给界面。 */
export function finishImport(
  deps: Pick<CanvasIpcDeps, 'db' | 'logger' | 'thumbnails' | 'assetsDir'>,
  projectId: string,
  outcome: ImportOutcome
): ImportResult {
  const { db, logger } = deps

  for (const item of outcome.imported) {
    logger.info(LogEvent.assetImported, {
      projectId,
      assetId: item.asset.id,
      nodeId: item.node.id,
      bytes: item.asset.bytes,
      mime: item.asset.mime,
      width: item.asset.width,
      height: item.asset.height,
      method: item.asset.importMethod,
      deduped: item.deduped
    })
  }
  for (const failure of outcome.errors) {
    logger.error(LogEvent.assetImportFailed, {
      projectId,
      path: failure.path,
      message: failure.message
    })
  }

  // 导入后顺手排队生成缩略图，赶在用户看之前备好（D1.7）
  for (const item of outcome.imported) deps.thumbnails?.prewarm(item.asset.fileName)

  const graph = loadGraph(db, projectId)
  return {
    ok: true,
    graph,
    assets: collectAssetInfos(db, graph, deps.assetsDir),
    importedCount: outcome.imported.length,
    ...(outcome.imported[0]
      ? {
          importedNode: {
            id: outcome.imported[0].node.id,
            x: outcome.imported[0].node.x,
            y: outcome.imported[0].node.y,
            width: outcome.imported[0].node.w,
            height: outcome.imported[0].node.h
          }
        }
      : {}),
    // 完整路径只在上面记进日志；给界面的错误只留文件名
    errors: outcome.errors.map((failure) => ({
      name: failure.name,
      message: failure.message,
      ...(failure.hint ? { hint: failure.hint } : {})
    }))
  }
}

/** 用一个共同的前置校验，避免每条通路各写一遍。 */
function requireProject(db: DatabaseSync, projectId: unknown, hint: string): string | ImportResult {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { ok: false, message: hint }
  }
  if (!getProject(db, projectId)) return { ok: false, message: '这个项目已经不在了' }
  return projectId
}

export async function importPaths(
  deps: Pick<CanvasIpcDeps, 'db' | 'assetsDir' | 'measure' | 'logger' | 'thumbnails'>,
  projectId: unknown,
  rawPaths: unknown
): Promise<ImportResult> {
  const checked = requireProject(deps.db, projectId, '先新建一个项目，再把图片导入进来')
  if (typeof checked !== 'string') return checked

  const paths = sanitizePaths(rawPaths)
  if (paths.length === 0) return { ok: false, message: '没有可导入的文件' }

  return finishImport(deps, checked, await importImageFiles(deps, checked, paths))
}

/** ⌘V：把剪贴板里的图片存进项目。 */
export async function importClipboard(
  deps: Pick<
    CanvasIpcDeps,
    'db' | 'assetsDir' | 'measure' | 'logger' | 'readClipboardImage' | 'thumbnails'
  >,
  projectId: unknown,
  rawCenter?: unknown,
  rawPasteTarget?: unknown
): Promise<ImportResult> {
  const checked = requireProject(
    deps.db,
    projectId,
    '先新建一个项目，再把剪贴板里的图片粘贴进来'
  )
  if (typeof checked !== 'string') return checked

  const content = await deps.readClipboardImage()
  if (!content) return { ok: false, message: NO_CLIPBOARD_CONTENT }
  const center = sanitizeCanvasPoint(rawCenter)
  const contents = Array.isArray(content) ? content : [content]
  const images = contents.filter((item): item is ClipboardImage => !isClipboardText(item))

  if (images.length === 0) {
    const textContent = contents.find(isClipboardText)
    const text = textContent?.text.trim()
    if (!text) return { ok: false, message: NO_CLIPBOARD_CONTENT }
    const index = countRootNodes(deps.db, checked)
    const box = clipboardTextBox(text)
    const width = box.width + TEXT_PADDING * 2
    const height = box.height + TEXT_PADDING * 2
    const at = center
      ? { x: center.x - width / 2, y: center.y - height / 2 }
      : (() => {
          const placement = placementFor(index)
          return { x: placement.x - TEXT_PADDING, y: placement.y - TEXT_PADDING }
        })()
    const node = createCanvasElementNode({
      id: randomUUID(),
      projectId: checked,
      parentId: null,
      name: '文本',
      x: at.x,
      y: at.y,
      w: width,
      h: height,
      element: { kind: 'text', text, color: '#3D414D', fontSize: 16 }
    })
    upsertNode(deps.db, node)
    const graph = loadGraph(deps.db, checked)
    return {
      ok: true,
      graph,
      assets: collectAssetInfos(deps.db, graph, deps.assetsDir),
      importedCount: 0,
      importedTextCount: 1,
      importedNode: { id: node.id, x: node.x, y: node.y, width: node.w, height: node.h },
      errors: []
    }
  }

  const imported = []
  const errors: ImportFailure[] = []
  let index = countRootNodes(deps.db, checked)
  for (const image of images) {
    try {
      imported.push(
        await importOneImage(deps, checked, {
          name: image.name,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          importMethod: 'clipboard',
          index,
          // 多张图一起粘时不叠在同一个中心点上；粘进自动布局容器时坐标本来就不参与排布。
          center: images.length === 1 ? center : null
        })
      )
      index++
    } catch (error) {
      errors.push({ path: image.name, name: image.name, message: messageFor(error) })
    }
  }

  const pasteTarget = sanitizePasteTarget(deps.db, checked, rawPasteTarget)
  if (pasteTarget && imported.length > 0) {
    const graph = loadGraph(deps.db, checked)
    const moved = createMoveNodesToParentCommand(
      imported.map((item) => item.node.id),
      pasteTarget.containerId,
      pasteTarget.index
    ).apply(graph)
    saveGraph(deps.db, moved)
  }

  return finishImport(deps, checked, { imported, errors })
}

/** 粘进自动布局容器时，容器 / 插入位置都来自界面；这里照样校验一遍。 */
function sanitizePasteTarget(
  db: DatabaseSync,
  projectId: string,
  value: unknown
): { containerId: string; index: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const { containerId, index } = value as { containerId?: unknown; index?: unknown }
  if (typeof containerId !== 'string') return null
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  const container = loadGraph(db, projectId).nodes[containerId]
  if (!container || !isAutoLayoutContainer(container)) return null
  return { containerId, index: Math.min(index, container.childIds.length) }
}

/** IPC 输入不可信；只接受有限的、可表示的画布坐标。 */
function sanitizeCanvasPoint(value: unknown): { x: number; y: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y } = value as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function isClipboardText(content: ClipboardContent): content is ClipboardText {
  return 'text' in content
}

/** 与文本工具同为 16px 默认字号；主进程没有字形测量器，宽度按可读的保守估算给。 */
function clipboardTextBox(text: string): { width: number; height: number } {
  const lines = text.split('\n')
  const longest = Math.max(...lines.map((line) => Array.from(line).length), 1)
  return {
    width: Math.min(400, Math.max(80, longest * 16)),
    height: Math.max(16, lines.length * 20)
  }
}

/** 网页拖入的请求：形状不对就当"没读出可用地址"，别让坏数据往里走。 */
export function sanitizeWebDropRequest(raw: unknown): WebDropRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { payload, pageUrl, position } = raw as {
    payload?: unknown
    pageUrl?: unknown
    position?: unknown
  }
  if (typeof payload !== 'object' || payload === null) return null

  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null
  const source = payload as Record<string, unknown>
  const cleaned = {
    textHtml: text(source['textHtml']),
    textUriList: text(source['textUriList']),
    textPlain: text(source['textPlain'])
  }
  if (!cleaned.textHtml && !cleaned.textUriList && !cleaned.textPlain) return null

  const point =
    typeof position === 'object' && position !== null
      ? (position as { x?: unknown; y?: unknown })
      : null
  const at =
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: point.x as number, y: point.y as number }
      : null

  return { payload: cleaned, pageUrl: text(pageUrl), position: at }
}

/**
 * 从网页把图收进画布（D3.8–D3.11）。
 *
 * 与其它导入共用 `finishImport`：日志、缩略图预热、把最新画布读回去给界面，
 * 都走同一条路——界面那边不用为"网页来的图"写第二套处理。
 */
export async function importWeb(
  deps: Pick<
    CanvasIpcDeps,
    'db' | 'assetsDir' | 'measure' | 'logger' | 'thumbnails' | 'fetchImpl'
  >,
  projectId: unknown,
  raw: unknown
): Promise<ImportResult> {
  const checked = requireProject(deps.db, projectId, '先新建一个项目，再把图片拖进来')
  if (typeof checked !== 'string') return checked

  const request = sanitizeWebDropRequest(raw)
  if (!request) return { ok: false, message: NO_USABLE_ADDRESS }

  return finishImport(deps, checked, await importFromWeb(deps, checked, request))
}

/**
 * 把一张**已经拿到的字节**收进项目（目前只有区域截图走这条，D3.16）。
 * 与其它导入共用 `finishImport`：日志、缩略图预热、把最新画布读回去给界面都一样。
 *
 * `center` 是画布视口中心：截图多大只有裁完才知道，所以在这里按实际尺寸把图
 * **正**摆在视口中间，用户一眼就能看到刚截的东西（不给中心就按序号错开摆）。
 */
export async function importCapturedBytes(
  deps: Pick<CanvasIpcDeps, 'db' | 'assetsDir' | 'measure' | 'logger' | 'thumbnails'>,
  projectId: unknown,
  input: {
    bytes: Uint8Array
    width: number
    height: number
    center: { x: number; y: number } | null
    at?: { x: number; y: number } | null
    pageUrl?: string | null
    importMethod?: Extract<ImportMethod, 'capture' | 'collect'>
    name?: string
  }
): Promise<ImportResult> {
  const checked = requireProject(deps.db, projectId, '先新建一个项目，再截图')
  if (typeof checked !== 'string') return checked

  const display = displaySizeFor({ width: input.width, height: input.height })
  const at = input.at ?? (input.center
    ? { x: input.center.x - display.width / 2, y: input.center.y - display.height / 2 }
    : null)

  const imported: ImportedNode[] = []
  const errors: ImportFailure[] = []
  try {
    imported.push(
      await importOneImage(deps, checked, {
        name: input.name ?? '网页截图.png',
        bytes: input.bytes,
        importMethod: input.importMethod ?? 'capture',
        index: countRootNodes(deps.db, checked),
        at,
        sourceUrl: input.pageUrl ?? null,
        pageUrl: input.pageUrl ?? null,
        // 截图**不是原图**，挂在节点上让用户一眼看得出来（D3.16 的"截图副本"）
        badge: 'screenshot'
      })
    )
  } catch (error) {
    errors.push({ path: '', name: '网页截图', message: messageFor(error) })
  }

  return finishImport(deps, checked, { imported, errors })
}

/**
 * 智能采集的原图路径。若下载失败，调用方会立即回退到同一帧视觉截图，
 * 所以这里不把网络失败直接暴露为一次采集失败。
 */
export async function importSmartOriginal(
  deps: Pick<CanvasIpcDeps, 'db' | 'assetsDir' | 'measure' | 'logger' | 'thumbnails' | 'fetchImpl'>,
  projectId: unknown,
  input: {
    url: string
    pageUrl: string | null
    center: { x: number; y: number } | null
    at?: { x: number; y: number } | null
  }
): Promise<ImportResult> {
  const checked = requireProject(deps.db, projectId, '先新建一个项目，再开始智能采集')
  if (typeof checked !== 'string') return checked
  return finishImport(
    deps,
    checked,
    await importFromWeb(
      deps,
      checked,
      { payload: { textPlain: input.url }, pageUrl: input.pageUrl, position: null },
      { importMethod: 'collect', center: input.center, at: input.at }
    )
  )
}

export function registerCanvasIpc(deps: CanvasIpcDeps): void {
  const { ipc, db } = deps

  ipc.handle(IpcChannel.canvasLoad, (_event, projectId) => {
    deps.pruneMissing?.()
    return loadCanvas(db, projectId, deps.assetsDir)
  })

  ipc.handle(IpcChannel.assetsImportPaths, (_event, projectId, paths) =>
    importPaths(deps, projectId, paths)
  )

  ipc.handle(IpcChannel.assetsPickFiles, async (_event, projectId) => {
    const { canceled, paths } = await deps.pickFiles()
    if (canceled || paths.length === 0) return { ok: false, message: '', canceled: true }
    return importPaths(deps, projectId, paths)
  })

  ipc.handle(IpcChannel.assetsImportClipboard, (_event, projectId, center, pasteTarget) =>
    importClipboard(deps, projectId, center, pasteTarget)
  )

  ipc.handle(IpcChannel.assetsImportWeb, (_event, projectId, request) =>
    importWeb(deps, projectId, request)
  )

  ipc.handle(IpcChannel.canvasSaveViewport, (_event, projectId, viewport) =>
    saveViewport(db, projectId, viewport)
  )

  ipc.handle(IpcChannel.canvasApplyGraph, (_event, projectId, graph) =>
    applyGraph(db, projectId, graph)
  )
}
