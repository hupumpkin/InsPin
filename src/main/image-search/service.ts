import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { clipboard, ClipboardItem } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import {
  IMAGE_SEARCH_LABELS,
  type ImageSearchEngineId,
  type ImageSearchFailureReason,
  type ImageSearchStage,
  type ImageSearchStartRequest,
  type ImageSearchStartResult
} from '../../shared/image-search'
import { isFullCrop } from '../../shared/crop'
import { getAssetByFileName } from '../assets'
import { needsTranscode, transcodeToPng } from '../image-transcode'
import { cropToPng } from './crop'
import { adapterFor, type ImageSearchAdapter } from './engines'
import { needsClipboardPngConversion } from './formats'
import { ImageSearchError, injectImage, preparePasteSurface } from './inject'

const run = promisify(execFile)

/** 浏览器和站点都能直接收的格式 */
const INJECTABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])

export interface ImageSearchLogger {
  info(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface ImageSearchServiceDeps {
  db: DatabaseSync
  assetsDir: string
  /** 展开左侧浏览器面板（结果页要看得见） */
  openPanel: () => void
  /** 新开一个标签，返回标签 id 和它的 webContents */
  openTab: (url: string) => { tabId: string; webContents: Electron.WebContents } | null
  /** 标签打开后标记为搜索结果页，界面据此露出「收下结果」 */
  markSearchTab?: (tabId: string, engineId: ImageSearchEngineId) => void
  /** 是否已经完成过一次隐私确认 */
  hasConsent: () => boolean
  /** 搜索推进阶段，用来给界面换提示文案 */
  onStage?: (engineId: ImageSearchEngineId, stage: ImageSearchStage) => void
  logger: ImageSearchLogger
}

interface RunToken {
  cancelled: boolean
}

const MESSAGES: Record<ImageSearchFailureReason, (engine: string) => string> = {
  'no-asset': () => '这张图不在当前项目里',
  'asset-missing': () => '这张图的源文件不在了，先在素材体检里处理',
  'unsupported-format': () => '这种格式暂时不能搜，支持 JPG / PNG / WebP / GIF / HEIC',
  network: (engine) => `连不上 ${engine}，检查网络后再试`,
  'login-required': (engine) => `${engine} 需要先登录，已在侧栏打开登录页`,
  captcha: (engine) => `${engine} 要求人机验证，请在侧栏完成后再试`,
  'engine-changed': (engine) => `${engine} 页面改版了，这个引擎暂时不可用`,
  timeout: () => '等了 30 秒没有出结果，可以在侧栏手动完成',
  cancelled: () => '已取消',
  'debugger-busy': () => '开发者工具占用了调试端口，关掉后再试',
  'clipboard-failed': () => '图片没能复制到剪贴板，换一张试试',
  'paste-failed': () => '自动粘贴没成功，请在侧栏手动按 ⌘V',
  'crop-failed': () => '这一块截不出来，换一张试试',
  'consent-required': () => '第一次使用需要先确认会上传图片到第三方',
  unknown: () => '搜索失败了，可以在侧栏手动完成'
}

function failure(
  engine: string,
  reason: ImageSearchFailureReason,
  tabId?: string
): ImageSearchStartResult {
  return { ok: false, reason, message: MESSAGES[reason](engine), ...(tabId ? { tabId } : {}) }
}

async function prepareFile(
  assetPath: string,
  adapter: ImageSearchAdapter
): Promise<{ path: string; tempDir: string | null }> {
  const ext = extname(assetPath).toLowerCase()
  const mustConvert =
    needsTranscode(assetPath) ||
    (adapter.convertNonBitmapToPng === true && (ext === '.webp' || ext === '.avif'))
  if (mustConvert) {
    const dir = await mkdtemp(join(tmpdir(), 'inspin-image-search-'))
    try {
      const bytes = await transcodeToPng(assetPath)
      const target = join(dir, 'search.png')
      await writeFile(target, bytes)
      return { path: target, tempDir: dir }
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new ImageSearchError('unsupported-format', '这张图转换不了，换一张试试')
    }
  }
  if (!INJECTABLE_EXTENSIONS.has(ext)) {
    throw new ImageSearchError('unsupported-format', '这种格式暂时不能搜')
  }
  return { path: assetPath, tempDir: null }
}

/** 把图片放进系统剪贴板，供用户自己按 ⌘V。 */
async function copyToClipboard(assetPath: string): Promise<void> {
  let pngPath = assetPath
  let tempDir: string | null = null
  if (needsClipboardPngConversion(assetPath)) {
    tempDir = await mkdtemp(join(tmpdir(), 'inspin-image-search-clip-'))
    pngPath = join(tempDir, 'clipboard.png')
    try {
      await run('/usr/bin/sips', ['-s', 'format', 'png', assetPath, '--out', pngPath], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      })
    } catch {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new ImageSearchError('clipboard-failed', '图片没能复制到剪贴板')
    }
  }
  try {
    const bytes = await readFile(pngPath)
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  } catch {
    throw new ImageSearchError('clipboard-failed', '图片没能复制到剪贴板')
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

export class ImageSearchService {
  private current: RunToken | null = null

  constructor(private readonly deps: ImageSearchServiceDeps) {}

  /** 同一时间只允许一个搜索；开始新的会取消旧的。 */
  cancel(): void {
    if (this.current) this.current.cancelled = true
    this.current = null
  }

  async start(request: ImageSearchStartRequest): Promise<ImageSearchStartResult> {
    const adapter = adapterFor(request.engineId)
    if (!adapter) return failure('这个引擎', 'unknown')

    if (!this.deps.hasConsent()) return failure(adapter.label, 'consent-required')

    const asset = getAssetByFileName(this.deps.db, request.assetFileName)
    if (!asset) return failure(adapter.label, 'no-asset')

    const assetPath = join(this.deps.assetsDir, asset.fileName)
    if (!existsSync(assetPath)) return failure(adapter.label, 'asset-missing')

    this.cancel()
    const token: RunToken = { cancelled: false }
    this.current = token
    const startedAt = Date.now()
    const mode = request.mode ?? 'auto'

    const stage = (next: ImageSearchStage): void => this.deps.onStage?.(adapter.id, next)

    stage('opening')
    this.deps.openPanel()
    const tab = this.deps.openTab(adapter.startUrl)
    if (!tab) return failure(adapter.label, 'unknown')
    this.deps.markSearchTab?.(tab.tabId, adapter.id)

    const tempDirs: string[] = []
    /** 局部搜索时这里是裁出来的临时 PNG，否则就是原素材 */
    let sourcePath = assetPath
    try {
      stage('resolving')
      if (request.crop && !isFullCrop(request.crop)) {
        const prepared = await prepareFile(assetPath, adapter)
        if (prepared.tempDir) tempDirs.push(prepared.tempDir)
        // 素材导入时量过宽高，有就直接用，省掉一次 sips 读尺寸
        const knownSize =
          asset.width && asset.height ? { width: asset.width, height: asset.height } : null
        const cropped = await cropToPng(prepared.path, request.crop, knownSize)
        tempDirs.push(cropped.tempDir)
        sourcePath = cropped.path
      }

      if (mode === 'paste') {
        await preparePasteSurface(tab.webContents, adapter, { isCancelled: () => token.cancelled })
        await copyToClipboard(sourcePath)
        this.deps.logger.info('imageSearch.done', {
          engine: adapter.id,
          mode: 'paste',
          ...(sourcePath !== assetPath ? { cropped: true } : {}),
          ms: Date.now() - startedAt
        })
        return { ok: true, tabId: tab.tabId, mode: 'paste' }
      }

      let injectPath = sourcePath
      if (sourcePath === assetPath) {
        const prepared = await prepareFile(assetPath, adapter)
        if (prepared.tempDir) tempDirs.push(prepared.tempDir)
        injectPath = prepared.path
      }
      stage('injecting')
      await injectImage(tab.webContents, adapter, injectPath, {
        isCancelled: () => token.cancelled,
        onStage: (next) => stage(next)
      })
      this.deps.logger.info('imageSearch.done', {
        engine: adapter.id,
        mode: 'inject',
        ...(sourcePath !== assetPath ? { cropped: true } : {}),
        ms: Date.now() - startedAt
      })
      return { ok: true, tabId: tab.tabId, mode: 'inject' }
    } catch (error) {
      const reason: ImageSearchFailureReason =
        error instanceof ImageSearchError ? error.reason : 'unknown'
      this.deps.logger.error('imageSearch.failed', {
        engine: adapter.id,
        reason,
        ms: Date.now() - startedAt
      })
      if (token.cancelled || reason === 'cancelled') return failure(adapter.label, 'cancelled', tab.tabId)

      // 页面结构对不上或等不到结果：退回「复制图片 + 用户自己按 ⌘V」
      if (reason === 'engine-changed' || reason === 'timeout') {
        try {
          await preparePasteSurface(tab.webContents, adapter, { isCancelled: () => token.cancelled })
          await copyToClipboard(sourcePath)
          return { ok: true, tabId: tab.tabId, mode: 'paste' }
        } catch {
          return failure(adapter.label, reason, tab.tabId)
        }
      }
      return failure(adapter.label, reason, tab.tabId)
    } finally {
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
      if (this.current === token) this.current = null
    }
  }
}
