import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportMethod } from '../shared/ipc'
import { describeNonImage, looksIntact, sniffImageFormat } from './mime'

/**
 * 素材落盘（路线图 D1.6）。
 *
 * 三件事：
 *   1. **按内容哈希去重** —— 同一张图存多次也只占一份文件
 *   2. **按文件头判断格式** —— 不信后缀、不信 Content-Type
 *   3. **区分"不是图片"和"图片坏了"** —— 两者要给用户看的提示完全不同
 */

// 类型来源是 `shared/ipc.ts`（界面也要用），这里再导出一次，方便老的导入路径不变
export type { ImportMethod }

export type AssetRejectReason = 'empty' | 'not-image' | 'corrupt'

/** 被拒绝导入时抛出，`reason` 供上层决定给用户看哪种提示。 */
export class AssetRejectedError extends Error {
  readonly reason: AssetRejectReason
  readonly detail: string | null

  constructor(reason: AssetRejectReason, message: string, detail: string | null = null) {
    super(message)
    this.name = 'AssetRejectedError'
    this.reason = reason
    this.detail = detail
  }
}

export interface Asset {
  id: string
  sha256: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  fileName: string
  importMethod: ImportMethod
  sourceUrl: string | null
  resourceUrl: string | null
  pageUrl: string | null
  createdAt: string
  originalName: string | null
  retentionPolicy: 'permanent' | 'temporary'
  unreferencedSince: string | null
  trashedAt: string | null
}

export interface SaveAssetInput {
  bytes: Uint8Array
  importMethod: ImportMethod
  sourceUrl?: string | null
  resourceUrl?: string | null
  pageUrl?: string | null
  /** 原始像素尺寸（能拿到就记，拿不到留空，D1.8 再补） */
  width?: number | null
  height?: number | null
  /** 素材库里展示的友好文件名；落盘文件仍使用内容哈希。 */
  originalName?: string | null
  /** 画布自动收集的素材可在无引用后清理；主动保存到素材库的永久保留。 */
  retentionPolicy?: 'permanent' | 'temporary'
}

export interface SaveAssetResult {
  asset: Asset
  /** true = 库里已有同一张图，没有重复写文件 */
  deduped: boolean
}

export interface Clock {
  id?: string
  now?: Date
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface AssetRow {
  id: string
  sha256: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  file_name: string
  import_method: string
  source_url: string | null
  resource_url: string | null
  page_url: string | null
  created_at: string
  original_name: string | null
  retention_policy: string
  unreferenced_since: string | null
  trashed_at: string | null
}

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    sha256: row.sha256,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    fileName: row.file_name,
    importMethod: row.import_method as ImportMethod,
    sourceUrl: row.source_url,
    resourceUrl: row.resource_url,
    pageUrl: row.page_url,
    createdAt: row.created_at,
    originalName: row.original_name,
    retentionPolicy: row.retention_policy === 'temporary' ? 'temporary' : 'permanent',
    unreferencedSince: row.unreferenced_since,
    trashedAt: row.trashed_at
  }
}

export function findAssetByHash(db: DatabaseSync, sha256: string): Asset | null {
  const row = db.prepare('SELECT * FROM assets WHERE sha256 = ?').get(sha256) as
    | AssetRow
    | undefined
  return row ? toAsset(row) : null
}

export function getAsset(db: DatabaseSync, id: string): Asset | null {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined
  return row ? toAsset(row) : null
}

/** 界面只拿得到素材文件名，主进程据此自己解析磁盘路径。 */
export function getAssetByFileName(db: DatabaseSync, fileName: string): Asset | null {
  const row = db.prepare('SELECT * FROM assets WHERE file_name = ?').get(fileName) as
    | AssetRow
    | undefined
  return row ? toAsset(row) : null
}

export function listAssets(db: DatabaseSync): Asset[] {
  const rows = db
    .prepare('SELECT * FROM assets ORDER BY created_at DESC, id DESC')
    .all() as unknown as AssetRow[]
  return rows.map(toAsset)
}

/**
 * 保存一份素材。内容相同的图只会占一份文件。
 * 失败时抛 `AssetRejectedError`，不会在库里留下任何记录。
 */
export async function saveAsset(
  db: DatabaseSync,
  assetsDir: string,
  input: SaveAssetInput,
  clock: Clock = {}
): Promise<SaveAssetResult> {
  const { bytes } = input

  if (bytes.length === 0) {
    throw new AssetRejectedError('empty', '这个文件是空的，没有内容')
  }

  const format = sniffImageFormat(bytes)
  if (!format) {
    const hint = describeNonImage(bytes)
    throw new AssetRejectedError(
      'not-image',
      hint ? `这不是图片文件（看起来是${hint}）` : '这不是图片文件',
      hint
    )
  }

  if (!looksIntact(bytes, format)) {
    throw new AssetRejectedError('corrupt', '这张图片已损坏，无法完整读取')
  }

  const sha256 = sha256Of(bytes)
  const fileName = `${sha256}.${format.ext}`
  const filePath = join(assetsDir, fileName)

  const existing = findAssetByHash(db, sha256)
  if (existing) {
    // 文件被手动删过就补回来，避免"库里有记录但图打不开"
    if (!existsSync(filePath)) await writeFile(filePath, bytes)
    const retention = input.retentionPolicy ?? 'permanent'
    db.prepare(
      `UPDATE assets
       SET original_name = COALESCE(original_name, ?),
           retention_policy = CASE WHEN ? = 'permanent' THEN 'permanent' ELSE retention_policy END,
           trashed_at = NULL
       WHERE id = ?`
    ).run(input.originalName ?? null, retention, existing.id)
    return { asset: getAsset(db, existing.id) ?? existing, deduped: true }
  }

  // 先落文件再写库：反过来的话，中途失败会留下一条指向空文件的记录
  await writeFile(filePath, bytes)

  const now = (clock.now ?? new Date()).toISOString()
  const id = clock.id ?? sha256.slice(0, 16)

  db.prepare(
    `INSERT INTO assets
       (id, sha256, mime, bytes, width, height, file_name, import_method,
        source_url, resource_url, page_url, created_at, original_name, retention_policy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sha256,
    format.mime,
    bytes.length,
    input.width ?? null,
    input.height ?? null,
    fileName,
    input.importMethod,
    input.sourceUrl ?? null,
    input.resourceUrl ?? null,
    input.pageUrl ?? null,
    now,
    input.originalName ?? null,
    input.retentionPolicy ?? 'permanent'
  )

  const asset = getAsset(db, id)
  if (!asset) throw new Error('素材写入失败')
  return { asset, deduped: false }
}
