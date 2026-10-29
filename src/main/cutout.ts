import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isCutoutMime } from '../shared/cutout'
import { IpcChannel, type CutoutCapability, type CutoutTarget, type ImportResult } from '../shared/ipc'
import { getAsset } from './assets'
import { finishImport } from './canvas-ipc'
import { countRootNodes, importOneImage, type ImageMeasurer, type ImportFailure, type ImportedNode } from './import-files'
import { loadGraph } from './nodes'
import { getProject } from './projects'
import type { IpcHandlerRegistrar, ProjectLogSink } from './projects-ipc'
import type { ThumbnailService } from './thumbnails-service'

/**
 * Apple Vision 一键抠图（macOS 14+）。原图不动，结果作为新 PNG 放回原图右侧。
 * 原生 Vision 被封装为 Swift 小工具，主进程只处理校验、临时文件与项目导入。
 */
const SIPS = '/usr/bin/sips'
const HELPER_TIMEOUT_MS = 120_000
const MAX_TARGETS = 1
const DIRECT_INPUT_MIMES = new Set(['image/png', 'image/jpeg', 'image/heic', 'image/heif'])
const ASSET_FILE_NAME = /^[0-9a-f]{16,64}\.[a-z0-9]{1,5}$/i

export type SubjectLiftRunner = (helperPath: string, inputPath: string, outputPath: string) => Promise<void>

export interface CutoutDeps {
  db: DatabaseSync
  assetsDir: string
  measure: ImageMeasurer
  logger: ProjectLogSink
  thumbnails?: ThumbnailService
  helperPath: string
  runSubjectLift?: SubjectLiftRunner
  /** 只给测试注入；生产环境从 Electron 的系统版本读取。 */
  systemVersion?: string
  /** 只给测试注入；生产环境读取 Electron 当前架构。 */
  architecture?: string
}

export interface CutoutIpcDeps extends CutoutDeps {
  ipc: IpcHandlerRegistrar
}

export function cutoutCapability(
  helperPath: string,
  systemVersion: string = currentSystemVersion(),
  architecture: string = process.arch
): CutoutCapability {
  if (architecture !== 'arm64') {
    return { available: false, reason: '抠图当前仅支持 Apple 芯片 Mac' }
  }
  const major = Number.parseInt(systemVersion.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major < 14) {
    return { available: false, reason: '抠图需要 macOS 14 或更高版本' }
  }
  if (!existsSync(helperPath)) {
    return { available: false, reason: '抠图组件没有安装完整，请重新安装 InsPin' }
  }
  try {
    accessSync(helperPath, constants.X_OK)
  } catch {
    return { available: false, reason: '抠图组件无法运行，请重新安装 InsPin' }
  }
  return { available: true }
}

function currentSystemVersion(): string {
  const getter = (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion
  return typeof getter === 'function' ? getter() : ''
}

export function registerCutoutIpc(deps: CutoutIpcDeps): void {
  deps.ipc.handle(IpcChannel.cutoutCapability, () => cutoutCapability(deps.helperPath))
  deps.ipc.handle(IpcChannel.cutoutRun, (_event, projectId, targets) => runCutout(deps, projectId, targets))
}

export async function runCutout(
  deps: CutoutDeps,
  projectId: unknown,
  rawTargets: unknown
): Promise<ImportResult> {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { ok: false, message: '请先新建一个项目，再抠图' }
  }
  if (!getProject(deps.db, projectId)) return { ok: false, message: '项目不存在' }

  const targets = sanitizeCutoutTargets(rawTargets)
  if (targets.length === 0) return { ok: false, message: '请选择一张图片再抠图' }
  const capability = cutoutCapability(deps.helperPath, deps.systemVersion, deps.architecture)
  if (!capability.available) return { ok: false, message: capability.reason ?? '这台电脑暂时不能抠图' }

  const graph = loadGraph(deps.db, projectId)
  const imported: ImportedNode[] = []
  const errors: ImportFailure[] = []
  let index = countRootNodes(deps.db, projectId)

  for (const target of targets) {
    const node = graph.nodes[target.nodeId]
    if (!node || node.type !== 'asset' || node.props.assetId !== target.assetId) {
      errors.push({ path: '', name: '图片', message: '这张图已经不在画布上了' })
      continue
    }
    const asset = getAsset(deps.db, target.assetId)
    if (!asset) {
      errors.push({ path: '', name: node.name, message: '找不到这张图的素材' })
      continue
    }
    if (!ASSET_FILE_NAME.test(asset.fileName)) {
      errors.push({ path: '', name: node.name, message: '素材文件名不合法' })
      continue
    }
    if (!isCutoutMime(asset.mime)) {
      errors.push({ path: '', name: node.name, message: '这种格式暂时不能抠图' })
      continue
    }

    const sourcePath = join(deps.assetsDir, asset.fileName)
    if (!existsSync(sourcePath)) {
      errors.push({ path: sourcePath, name: node.name, message: '原图文件已经不在磁盘上了' })
      continue
    }

    const workDir = await mkdtemp(join(tmpdir(), 'inspin-cutout-'))
    try {
      const inputPath = DIRECT_INPUT_MIMES.has(asset.mime) ? sourcePath : join(workDir, 'input.png')
      if (inputPath !== sourcePath) await convertToPng(sourcePath, inputPath)
      const outputPath = join(workDir, 'cutout.png')
      await (deps.runSubjectLift ?? runSubjectLift)(deps.helperPath, inputPath, outputPath)
      if (!existsSync(outputPath)) throw new Error('抠图没有生成结果')
      const bytes = new Uint8Array(await readFile(outputPath))
      imported.push(
        await importOneImage(deps, projectId, {
          name: cutoutName(node.name),
          bytes,
          importMethod: 'file',
          index,
          at: target.at,
          // 衍生图仍属于同一份网页灵感：对象面板里继续能回到原页面与原始资源。
          sourceUrl: asset.sourceUrl,
          resourceUrl: asset.resourceUrl,
          pageUrl: asset.pageUrl
        })
      )
      index += 1
    } catch (error) {
      errors.push({ path: sourcePath, name: node.name, message: describeCutoutError(error) })
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  if (imported.length === 0) {
    return { ok: false, message: errors[0]?.message ?? '抠图没有成功，换一张图再试' }
  }
  return finishImport(deps, projectId, { imported, errors })
}

/** IPC 入参只接受一张，防止绕过 UI 把主进程塞进长时间批处理。 */
export function sanitizeCutoutTargets(raw: unknown): CutoutTarget[] {
  if (!Array.isArray(raw) || raw.length !== MAX_TARGETS) return []
  const value = raw[0]
  if (!value || typeof value !== 'object') return []
  const { nodeId, assetId, at } = value as Record<string, unknown>
  if (typeof nodeId !== 'string' || nodeId.length === 0) return []
  if (typeof assetId !== 'string' || assetId.length === 0) return []
  const point =
    at && typeof at === 'object' && Number.isFinite((at as { x?: unknown }).x) && Number.isFinite((at as { y?: unknown }).y)
      ? { x: (at as { x: number }).x, y: (at as { y: number }).y }
      : null
  return [{ nodeId, assetId, at: point }]
}

export function cutoutName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, '').trim() || '图片'
  return `${base}-抠图.png`
}

function describeCutoutError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('没有识别到')) return '这张图没有识别到明显主体，换一张试试'
  return message || '抠图没有成功，换一张图再试'
}

function runSubjectLift(helperPath: string, inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(helperPath, ['--input', inputPath, '--output', outputPath], { timeout: HELPER_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) return resolve()
      reject(new Error(helperMessage(stdout) ?? helperMessage(stderr) ?? '抠图进程没有正常返回'))
    })
  })
}

function helperMessage(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(text) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message
    } catch {
      // 忽略非 JSON 的工具输出，继续找下一行。
    }
  }
  return null
}

function convertToPng(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(SIPS, ['-s', 'format', 'png', inputPath, '--out', outputPath], { timeout: 60_000 }, (error) => {
      if (error) reject(new Error('这张图的格式暂时转不了，换一张试试'))
      else resolve()
    })
  })
}
