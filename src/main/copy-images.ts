import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, readFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClipboardItem, type Clipboard, type IpcMain } from 'electron'
import {
  IpcChannel,
  type CopyImageItem,
  type CopyImagesOptions,
  type CopyImagesResult
} from '../shared/ipc'

/**
 * 把画布上选中的素材复制到**系统剪贴板**，供 Figma / Eagle / Relay 等软件粘贴。
 *
 * 关键取舍（实测得出）：
 *   - 系统剪贴板的"图片"格子只能装**一张**位图，多张会被覆盖成一张；
 *   - 但"文件地址列表"能装几百个，且 macOS 会把它伪装成"访达复制了这些文件"。
 * 所以：单选 → 额外给位图（PS 这类只认位图的也能收）；多选 → 只给文件地址。
 *
 * 素材文件名是内容哈希，直接给出去图层名会是一串乱码。用**硬链接**在导出目录里
 * 给每张图起一个画布节点名做文件名：同一个文件、零字节拷贝。
 *
 * 不兼容格式（webp / avif / gif）：Electron 的 nativeImage 解不了 webp/avif，
 * 改用 macOS 自带的 `sips` 转 PNG。开关在「设置 → 通用」。
 */

const ASSET_FILE_NAME = /^[0-9a-f]{16,64}\.[a-z0-9]{1,5}$/i
/** 这些格式所有目标软件都认，直接给原文件（硬链接、零拷贝）。 */
const COMPATIBLE_EXTS = new Set(['png', 'jpg', 'jpeg'])
/** macOS 自带，能读 webp/avif/gif 并写出 png。 */
const SIPS = '/usr/bin/sips'
const CONVERT_CONCURRENCY = 4

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

/** macOS 原生理解的位图格式；其它格式只走文件地址，交给目标软件自己解码。 */
const BITMAP_MIMES = new Set(['image/png', 'image/jpeg'])

export interface CopyImagesDeps {
  clipboard: Clipboard
  assetsDir: string
  /** 临时导出目录：每次复制前清空；硬链接不占额外空间，转好的 PNG 也放这里 */
  exportDir: string
}

export function registerCopyImagesIpc(ipc: IpcMain, deps: CopyImagesDeps): void {
  ipc.handle(IpcChannel.canvasCopyImages, (_event, raw: unknown, options?: unknown) =>
    copyImages(deps, raw, options)
  )
}

interface PlannedFile {
  name: string
  path: string
  sourceExt: string
  convert: boolean
  outputName: string
  outputPath: string
}

export async function copyImages(
  deps: CopyImagesDeps,
  raw: unknown,
  options?: unknown
): Promise<CopyImagesResult> {
  const convertToPng = parseOptions(options).convertToPng
  const items = sanitizeItems(raw)
  const files = items.flatMap((item) => {
    const path = join(deps.assetsDir, item.fileName)
    return existsSync(path) ? [{ name: item.name, path }] : []
  })
  if (files.length === 0) return { ok: false, message: '选中的对象里没有可复制的图片' }

  // 粘贴发生在别的软件里、时间不确定，所以导出目录留到**下一次复制**才清
  await rm(deps.exportDir, { recursive: true, force: true })
  await mkdir(deps.exportDir, { recursive: true })

  const usedNames = new Set<string>()
  // 先同步定好文件名，避免并发任务同时改 usedNames
  const plan: PlannedFile[] = files.map((file) => {
    const sourceExt = extname(file.path).slice(1).toLowerCase()
    const convert = convertToPng && !COMPATIBLE_EXTS.has(sourceExt)
    return {
      name: file.name,
      path: file.path,
      sourceExt,
      convert,
      outputName: uniqueName(file.name, `.${convert ? 'png' : sourceExt}`, usedNames),
      outputPath: ''
    }
  })

  let converted = 0
  await mapWithConcurrency(plan, CONVERT_CONCURRENCY, async (entry) => {
    if (entry.convert) {
      const target = join(deps.exportDir, entry.outputName)
      if (await convertWithSips(entry.path, target)) {
        entry.outputPath = target
        converted += 1
        return
      }
      // sips 解不出来：退回原图（换回原后缀，文件名重新排一个）
      entry.convert = false
      entry.outputName = uniqueName(entry.name, `.${entry.sourceExt}`, usedNames)
    }
    entry.outputPath = join(deps.exportDir, entry.outputName)
    await linkOrCopy(entry.path, entry.outputPath)
  })

  const payload: Record<string, Blob | string> = {
    'text/uri-list': plan.map((entry) => pathToFileURL(entry.outputPath).href).join('\r\n')
  }

  // 单选：再给一份位图，PS 之类只认"粘贴一张图"的软件也能收
  const only = plan.length === 1 ? plan[0] : null
  if (only) {
    const mime = mimeFor(only.outputPath)
    if (BITMAP_MIMES.has(mime)) {
      payload[mime] = new Blob([await readFile(only.outputPath)], { type: mime })
    }
  }

  try {
    await deps.clipboard.write([new ClipboardItem(payload)])
  } catch {
    if (plan.length > 1) {
      return { ok: false, message: '批量复制失败，图片没能放进剪贴板' }
    }
    // 兜底：只写位图（多格式组合写不进去时）
    const mime = mimeFor(plan[0]!.outputPath)
    if (!BITMAP_MIMES.has(mime)) {
      return { ok: false, message: '这张图的格式复制不了，换一张试试' }
    }
    await deps.clipboard.write([
      new ClipboardItem({ [mime]: new Blob([await readFile(plan[0]!.outputPath)], { type: mime }) })
    ])
  }

  return { ok: true, count: plan.length, converted }
}

function parseOptions(raw: unknown): CopyImagesOptions {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  return { convertToPng: value?.['convertToPng'] === true }
}

function sanitizeItems(raw: unknown): CopyImageItem[] {
  if (!Array.isArray(raw)) return []
  const items: CopyImageItem[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const { fileName, name } = value as Record<string, unknown>
    if (typeof fileName !== 'string' || !ASSET_FILE_NAME.test(fileName)) continue
    items.push({ fileName, name: typeof name === 'string' ? name : '' })
  }
  return items
}

/** 硬链接 = 同一个文件换个名字（零字节拷贝）；跨卷等失败时退回真拷贝。 */
async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target)
  } catch {
    await copyFile(source, target)
  }
}

/** 用 sips 把任意可解码格式转成 PNG；失败返回 false，由调用方退回原图。 */
function convertWithSips(input: string, output: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      SIPS,
      ['-s', 'format', 'png', input, '--out', output],
      { timeout: 30_000 },
      (error) => {
        resolve(!error && existsSync(output))
      }
    )
  })
}

/** 小并发池：几十上百张图时不至于一次起几十个 sips 进程。 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      await run(item)
    }
  })
  await Promise.all(workers)
}

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).slice(1).toLowerCase()] ?? 'image/png'
}

/** 节点名 → 安全的文件名；后缀统一用实际输出格式，重名时追加序号。 */
function uniqueName(rawName: string, ext: string, used: Set<string>): string {
  const base =
    String(rawName)
      .replace(/\.[a-z0-9]{1,8}$/i, '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
      .trim()
      .slice(0, 120) || 'image'
  const suffix = ext.toLowerCase()
  let candidate = `${base}${suffix}`
  let index = 2
  while (used.has(candidate)) {
    candidate = `${base}-${index}${suffix}`
    index += 1
  }
  used.add(candidate)
  return candidate
}
