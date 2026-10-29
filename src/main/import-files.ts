import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createAssetNode, type AssetBadge, type AssetNode } from '../shared/node'
import { AssetRejectedError, saveAsset, type Asset, type ImportMethod } from './assets'
import { dimensionsFromImageHeader } from './image-dimensions'
import { upsertNode } from './nodes'

/**
 * 把图片放进画布（路线图 D1.4 本地文件 / D1.5 剪贴板）。
 *
 * 复用 D1.6 已经做好的落盘能力（哈希去重、按文件头认格式、区分"不是图片/图坏了"），
 * 这里只负责把它们串成"拿到字节 → 落素材 → 建节点 → 存进项目"。
 * 字节来源可以是磁盘上的文件，也可以来自剪贴板。
 *
 * 依赖测量函数与时钟都是为了能在普通 Node 下单测：真正的解码（Electron 的
 * `nativeImage`）由调用方注入。
 */

export interface ImageSize {
  width: number
  height: number
}

/** 读原图像素尺寸；解不出来返回 null（不阻断导入，尺寸留空）。 */
export type ImageMeasurer = (bytes: Uint8Array) => ImageSize | null

export interface ImportDeps {
  db: DatabaseSync
  assetsDir: string
  measure: ImageMeasurer
  now?: () => Date
  newId?: () => string
}

export interface ImportedNode {
  node: AssetNode
  asset: Asset
  /** true = 库里已有同一张图，这次没有重复写文件 */
  deduped: boolean
}

export interface ImportFailure {
  /** 本机完整路径：**只进日志**，不往界面送 */
  path: string
  /** 文件名：给用户看"是哪个文件没进来" */
  name: string
  message: string
  /** 下一步能做什么（D3.14）；本地文件那条路用不上，网页那条路才有 */
  hint?: string
}

export interface ImportOutcome {
  imported: ImportedNode[]
  errors: ImportFailure[]
}

/** 导入后图片的初始显示边长上限；太大铺满屏幕不好看，D2.7 用户可自己缩放。 */
const MAX_DISPLAY_EDGE = 400
/**
 * 量不出像素尺寸时给的兜底显示尺寸。
 *
 * 不能给 0×0：节点会**点不中、选不中**，用户看到画布上有个东西却完全处理不了
 * （2026-10-15 用户手测撞到过：一张能过文件头校验、但解码器解不开的图，
 * 就成了一个选不中的黑方块）。给个能抓、能删的盒子，比"看不见的节点"强得多。
 */
const UNKNOWN_DISPLAY = { width: 240, height: 180 }
const HEADER_FALLBACK_EDGE = 240
const PLACEMENT_START = { x: 120, y: 120 }
const PLACEMENT_STEP = 48
const PLACEMENT_PER_COLUMN = 6

/** 保持比例，把长边压到 MAX_DISPLAY_EDGE 以内；本来就小的不放大。 */
export function displaySizeFor(natural: ImageSize): ImageSize {
  if (natural.width <= 0 || natural.height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, MAX_DISPLAY_EDGE / Math.max(natural.width, natural.height))
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale))
  }
}

/**
 * 解码器没认出、但文件头能认出尺寸时的显示盒子。
 *
 * 小图也至少给 240px 的长边，确保仍能被抓取；大图沿用正常 400px 上限。最重要的是
 * 两个方向始终使用同一缩放系数，不能再回退成固定 4:3。
 */
function displaySizeFromHeader(natural: ImageSize): ImageSize {
  const edge = Math.max(natural.width, natural.height)
  if (edge <= 0) return UNKNOWN_DISPLAY
  const scale = Math.max(HEADER_FALLBACK_EDGE / edge, Math.min(1, MAX_DISPLAY_EDGE / edge))
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale))
  }
}

/** 新导入的图按序号错开摆放，避免叠在一起。 */
export function placementFor(index: number): { x: number; y: number } {
  const column = index % PLACEMENT_PER_COLUMN
  const row = Math.floor(index / PLACEMENT_PER_COLUMN)
  return {
    x: PLACEMENT_START.x + column * PLACEMENT_STEP,
    y: PLACEMENT_START.y + row * PLACEMENT_STEP
  }
}

/**
 * 磁盘/权限这类文件系统错误翻成人话（D6a.4）。
 *
 * 不翻的话用户看到的是 `ENOSPC: no space left on device, write`——既不知道发生了什么，
 * 也不知道能做什么。认不出来返回 null，交给下面走通用兜底。
 */
export function describeFsFailure(error: unknown): string | null {
  const code = (error as { code?: string } | null)?.code
  if (code === 'ENOSPC') return '磁盘空间不够了，这张图没能存下来。腾点空间再试'
  if (code === 'EACCES' || code === 'EPERM') return '没有写入权限，这张图没能存下来'
  if (code === 'EROFS') return '磁盘是只读的，这张图没能存下来'
  if (code === 'ENOENT') return '找不到要读的文件，它可能已经被移走或删掉了'
  return null
}

/** 把异常翻成给用户看的一句话；非预期错误不把底层报错甩出去。 */
export function messageFor(error: unknown): string {
  if (error instanceof AssetRejectedError) return error.message
  const fsMessage = describeFsFailure(error)
  if (fsMessage) return fsMessage
  if (error instanceof Error && error.message.length > 0) return `读取失败：${error.message}`
  return '导入失败'
}

/** 当前顶层节点数，用来给新导入的图挑错开的位置。 */
export function countRootNodes(db: DatabaseSync, projectId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM nodes WHERE project_id = ? AND parent_id IS NULL')
    .get(projectId) as { n: number }
  return Number(row.n)
}

export interface ImportOneInput {
  name: string
  bytes: Uint8Array
  /** 已知像素尺寸就直接给；没给就交给 `measure` 猜 */
  width?: number | null
  height?: number | null
  importMethod: ImportMethod
  /** 主动导入/保存永久保留；画布自动采集使用 temporary。 */
  retentionPolicy?: 'permanent' | 'temporary'
  /** 摆第几个位置（叫法由调用方按"已有顶层节点数 + 本批序号"算） */
  index: number
  /**
   * 直接指定摆在哪（画布世界坐标）。**从网页拖进来的图用这个**——
   * 用户松手的位置就是它该在的位置，按序号错开会让人觉得"没落在我放的地方"。
   */
  at?: { x: number; y: number } | null
  /** 按实际显示尺寸居中摆放；截图 / 智能采集需要这条而非固定错开位置。 */
  center?: { x: number; y: number } | null
  /** 来源信息（只有从网页来的才有）：源页面、实际取回的图片地址 */
  sourceUrl?: string | null
  resourceUrl?: string | null
  pageUrl?: string | null
  /** 不是原图时挂的小标签（低清副本 / 截图副本，D3.13 / D3.16） */
  badge?: AssetBadge
}

/**
 * 把一份**已经拿到字节**的图片存进项目：落素材（哈希去重 + 格式校验）→ 建节点 → 写库。
 * 失败时抛出，由调用方决定怎么收集与提示。
 */
export async function importOneImage(
  deps: ImportDeps,
  projectId: string,
  input: ImportOneInput
): Promise<ImportedNode> {
  const { db, assetsDir, measure } = deps
  const now = deps.now ?? ((): Date => new Date())
  const newId = deps.newId ?? ((): string => randomUUID())

  const known =
    input.width != null && input.height != null && input.width > 0 && input.height > 0
      ? { width: input.width, height: input.height }
      : null
  // 网页图偶有 Electron 解不出尺寸、浏览器却仍能显示的情况。此时从文件头取宽高，
  // 保住原图比例；不能因为解码器的一次空结果把竖图压进固定 4:3 盒子。
  const measured = known ?? measure(input.bytes)
  const header = measured ? null : dimensionsFromImageHeader(input.bytes)
  const natural = measured ?? header

  const { asset, deduped } = await saveAsset(
    db,
    assetsDir,
    {
      bytes: input.bytes,
      importMethod: input.importMethod,
      width: natural?.width ?? null,
      height: natural?.height ?? null,
      sourceUrl: input.sourceUrl ?? null,
      resourceUrl: input.resourceUrl ?? null,
      pageUrl: input.pageUrl ?? null,
      originalName: input.name,
      retentionPolicy:
        input.retentionPolicy ??
        (input.importMethod === 'file' || input.importMethod === 'clipboard' ? 'permanent' : 'temporary')
    },
    { now: now() }
  )

  const display = natural
    ? header
      ? displaySizeFromHeader(header)
      : displaySizeFor(natural)
    : UNKNOWN_DISPLAY
  const at = input.at ?? (input.center
    ? { x: input.center.x - display.width / 2, y: input.center.y - display.height / 2 }
    : placementFor(input.index))
  const node = createAssetNode({
    id: newId(),
    projectId,
    name: input.name,
    x: at.x,
    y: at.y,
    w: display.width,
    h: display.height,
    assetId: asset.id,
    naturalWidth: natural?.width ?? 0,
    naturalHeight: natural?.height ?? 0,
    badge: input.badge
  })
  upsertNode(db, node)

  return { node, asset, deduped }
}

/** 从磁盘上的若干图片文件导入（拖入系统文件 / 文件选择器）。 */
export async function importImageFiles(
  deps: ImportDeps,
  projectId: string,
  paths: string[]
): Promise<ImportOutcome> {
  const imported: ImportedNode[] = []
  const errors: ImportFailure[] = []
  let index = countRootNodes(deps.db, projectId)

  for (const path of paths) {
    try {
      const bytes = new Uint8Array(await readFile(path))
      imported.push(
        await importOneImage(deps, projectId, {
          name: basename(path),
          bytes,
          importMethod: 'file',
          index
        })
      )
      index++
    } catch (error) {
      errors.push({ path, name: basename(path), message: messageFor(error) })
    }
  }

  return { imported, errors }
}
