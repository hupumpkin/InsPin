import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readdir, readFile, realpath, rm, stat, unlink } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportFailure, ImportResult } from '../shared/ipc'
import type {
  LibraryDragItem,
  LinkedFolderAsset,
  LinkedFolderListing,
  LinkedFolderSummary,
  LocalLibraryState,
  ManagedLibraryAsset,
  TrashLibraryAssetsResult
} from '../shared/local-library'
import { createAssetNode } from '../shared/node'
import { thumbnailNameFor } from '../shared/asset-url'
import { cleanupWindowMs, DEFAULT_ASSET_CLEANUP, type AssetCleanupSettings } from '../shared/settings'
import type { LibraryUsage } from '../shared/maintenance'
import { getAsset, listAssets, type Asset } from './assets'
import { collectAssetInfos } from './canvas-ipc'
import { displaySizeFor, importOneImage, type ImageMeasurer } from './import-files'
import { loadGraph, upsertNode } from './nodes'
import { linkedThumbnailDir } from './thumbnails-service'
import { needsTranscode, transcodeToPng } from './image-transcode'

/** 默认策略（设置还没接上时的兜底；与设置页里的默认值一致）。 */
export const UNUSED_GRACE_MS = DEFAULT_ASSET_CLEANUP.graceDays * 24 * 60 * 60 * 1000
export const TRASH_RETENTION_MS = DEFAULT_ASSET_CLEANUP.trashDays * 24 * 60 * 60 * 1000

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  // 浏览器不认，但系统解码器认得：缩略图走 createThumbnailFromPath，
  // 放进画布时用 sips 转成 PNG。
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

interface LinkedFolderRow {
  id: string
  name: string
  path: string
  created_at: string
}

export interface LocalLibraryDeps {
  db: DatabaseSync
  assetsDir: string
  thumbnailsDir: string
  measure: ImageMeasurer
  /** 参考快照里冻结的素材 id：它们也算“在用”，不能按无引用清理。 */
  snapshotAssetIds?: () => Iterable<string>
  /** 当前的素材清理策略；不传时用默认值。 */
  cleanup?: () => AssetCleanupSettings
  now?: () => Date
}

/** 一次整理的结果，用来告诉用户"动了什么、释放了多少"。 */
export interface ReconcileStats {
  trashed: number
  removed: number
  freedBytes: number
}

function assetView(asset: Asset): ManagedLibraryAsset {
  return {
    kind: 'managed',
    id: asset.id,
    name: asset.originalName?.trim() || asset.fileName,
    fileName: asset.fileName,
    mime: asset.mime,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
    unreferencedSince: asset.unreferencedSince,
    trashedAt: asset.trashedAt
  }
}

function referencesByAsset(db: DatabaseSync): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT json_extract(props, '$.assetId') AS asset_id, COUNT(*) AS count
       FROM nodes
       WHERE type = 'asset'
       GROUP BY json_extract(props, '$.assetId')`
    )
    .all() as unknown as Array<{ asset_id: string | null; count: number }>
  return new Map(rows.filter((row) => row.asset_id).map((row) => [row.asset_id as string, Number(row.count)]))
}

async function removeAssetFiles(deps: LocalLibraryDeps, asset: Asset): Promise<void> {
  const paths = [
    resolve(deps.assetsDir, asset.fileName),
    resolve(deps.thumbnailsDir, thumbnailNameFor(asset.fileName))
  ]
  await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)))
}

/**
 * 根据全局画布引用维护临时素材的宽限期和回收站。
 * 只在读取素材侧栏、启动、或用户点"立即整理"时扫表；应用关闭期间经过的时间
 * 也会在下次打开时补算。
 *
 * 关掉自动清理时只记录"从什么时候开始没被引用"，不移动、不删除——
 * 这样用户重新打开开关后，计时不会从零开始。
 */
export async function reconcileLibrary(deps: LocalLibraryDeps): Promise<ReconcileStats> {
  const stats: ReconcileStats = { trashed: 0, removed: 0, freedBytes: 0 }
  const now = (deps.now?.() ?? new Date()).getTime()
  const nowIso = new Date(now).toISOString()
  const cleanup = deps.cleanup?.() ?? DEFAULT_ASSET_CLEANUP
  const { graceMs, trashMs } = cleanupWindowMs(cleanup)
  const refs = referencesByAsset(deps.db)
  const snapshotRefs = new Set(deps.snapshotAssetIds?.() ?? [])

  for (const asset of listAssets(deps.db)) {
    const count = refs.get(asset.id) ?? 0
    if (count > 0 || snapshotRefs.has(asset.id)) {
      if (asset.unreferencedSince || asset.trashedAt) {
        deps.db
          .prepare('UPDATE assets SET unreferenced_since = NULL, trashed_at = NULL WHERE id = ?')
          .run(asset.id)
      }
      continue
    }

    if (asset.trashedAt) {
      if (!cleanup.enabled) continue
      const trashedAt = Date.parse(asset.trashedAt)
      if (Number.isFinite(trashedAt) && now - trashedAt >= trashMs) {
        await removeAssetFiles(deps, asset)
        deps.db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id)
        stats.removed += 1
        stats.freedBytes += asset.bytes
      }
      continue
    }

    if (asset.retentionPolicy === 'permanent') {
      if (asset.unreferencedSince) {
        deps.db.prepare('UPDATE assets SET unreferenced_since = NULL WHERE id = ?').run(asset.id)
      }
      continue
    }

    if (!asset.unreferencedSince) {
      deps.db.prepare('UPDATE assets SET unreferenced_since = ? WHERE id = ?').run(nowIso, asset.id)
      continue
    }
    if (!cleanup.enabled) continue

    const unusedAt = Date.parse(asset.unreferencedSince)
    if (Number.isFinite(unusedAt) && now - unusedAt >= graceMs) {
      const trashedAt = unusedAt + graceMs
      if (now - trashedAt >= trashMs) {
        await removeAssetFiles(deps, asset)
        deps.db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id)
        stats.removed += 1
        stats.freedBytes += asset.bytes
        continue
      }
      deps.db
        .prepare('UPDATE assets SET trashed_at = ?, unreferenced_since = NULL WHERE id = ?')
        .run(new Date(trashedAt).toISOString(), asset.id)
      stats.trashed += 1
    }
  }
  return stats
}

/** 托管素材的占用统计（原图字节数）。 */
export function libraryUsage(db: DatabaseSync): LibraryUsage {
  const usage: LibraryUsage = {
    managedCount: 0,
    managedBytes: 0,
    permanentCount: 0,
    permanentBytes: 0,
    trashCount: 0,
    trashBytes: 0
  }
  for (const asset of listAssets(db)) {
    if (asset.trashedAt) {
      usage.trashCount += 1
      usage.trashBytes += asset.bytes
    } else {
      usage.managedCount += 1
      usage.managedBytes += asset.bytes
      if (asset.retentionPolicy === 'permanent') {
        usage.permanentCount += 1
        usage.permanentBytes += asset.bytes
      }
    }
  }
  return usage
}

/** 按当前策略整理一次，并回一份最新占用。 */
export async function cleanupLibraryNow(
  deps: LocalLibraryDeps
): Promise<{ stats: ReconcileStats; usage: LibraryUsage }> {
  const stats = await reconcileLibrary(deps)
  return { stats, usage: libraryUsage(deps.db) }
}

function linkedFolders(db: DatabaseSync): LinkedFolderRow[] {
  return db
    .prepare('SELECT id, name, path, created_at FROM linked_folders ORDER BY created_at ASC')
    .all() as unknown as LinkedFolderRow[]
}

export async function getLocalLibraryState(deps: LocalLibraryDeps): Promise<LocalLibraryState> {
  await reconcileLibrary(deps)
  const assets = listAssets(deps.db)
  return {
    managed: assets.filter((asset) => !asset.trashedAt).map(assetView),
    trash: assets.filter((asset) => asset.trashedAt).map(assetView),
    folders: linkedFolders(deps.db).map(
      (folder): LinkedFolderSummary => ({
        id: folder.id,
        name: folder.name,
        available: existsSync(folder.path),
        createdAt: folder.created_at
      })
    )
  }
}

export function linkFolder(db: DatabaseSync, path: string, now = new Date()): LinkedFolderSummary {
  const found = db.prepare('SELECT * FROM linked_folders WHERE path = ?').get(path) as LinkedFolderRow | undefined
  const row = found ?? {
    id: randomUUID(),
    name: basename(path),
    path,
    created_at: now.toISOString()
  }
  if (!found) {
    db.prepare('INSERT INTO linked_folders (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      row.id,
      row.name,
      row.path,
      row.created_at
    )
  }
  return { id: row.id, name: row.name, available: existsSync(row.path), createdAt: row.created_at }
}

export function unlinkFolder(db: DatabaseSync, id: string, thumbnailsDir?: string): boolean {
  folderScanCache.delete(id)
  // 移除链接时顺手清掉这个文件夹的缩略图缓存，避免越积越多；
  // 缓存可能很大，放后台删，不要卡住界面。
  if (thumbnailsDir) {
    void rm(linkedThumbnailDir(thumbnailsDir, id), { recursive: true, force: true }).catch(
      () => undefined
    )
  }
  return db.prepare('DELETE FROM linked_folders WHERE id = ?').run(id).changes > 0
}

function folderRow(db: DatabaseSync, id: string): LinkedFolderRow | null {
  return (db.prepare('SELECT * FROM linked_folders WHERE id = ?').get(id) as LinkedFolderRow | undefined) ?? null
}

export function resolveLinkedAssetPath(db: DatabaseSync, folderId: string, relativePath: string): string | null {
  const folder = folderRow(db, folderId)
  if (!folder || !relativePath || relativePath.includes('\0')) return null
  try {
    const root = realpathSync(folder.path)
    const candidate = realpathSync(resolve(root, relativePath))
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) return null
    if (!IMAGE_MIME[extname(candidate).toLowerCase()] || !statSync(candidate).isFile()) return null
    return candidate
  } catch {
    return null
  }
}

/**
 * 协议处理器的版本。每个缩略图请求都会走到这里，同步 fs 调用会直接卡住主进程，
 * 所以单独提供异步版本（同步版本留给单次导入等非热路径）。
 */
export async function resolveLinkedAssetPathAsync(
  db: DatabaseSync,
  folderId: string,
  relativePath: string
): Promise<string | null> {
  const folder = folderRow(db, folderId)
  if (!folder || !relativePath || relativePath.includes('\0')) return null
  try {
    const root = await realpath(folder.path)
    const candidate = await realpath(resolve(root, relativePath))
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) return null
    if (!IMAGE_MIME[extname(candidate).toLowerCase()]) return null
    const info = await stat(candidate)
    return info.isFile() ? candidate : null
  } catch {
    return null
  }
}

const FOLDER_SCAN_CACHE_MS = 5_000
/** 返回多少张；再多也不适合一次塞进侧栏。 */
const LINKED_LIST_LIMIT = 2000
/**
 * 最多收集多少个候选路径。比返回上限多收一些，才能在“图片很多”的文件夹里
 * 按修改时间挑出最近的一批，而不是被遍历顺序决定。
 */
const LINKED_SCAN_CAP = 5000
const folderScanCache = new Map<
  string,
  { at: number; path: string; listing: LinkedFolderListing }
>()

/** 并发跑异步任务，避免几百个文件一个一个 stat 串行排队。 */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await task(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

export async function listLinkedFolderAssets(
  db: DatabaseSync,
  folderId: string,
  limit = LINKED_LIST_LIMIT
): Promise<LinkedFolderListing> {
  const folder = folderRow(db, folderId)
  if (!folder || !existsSync(folder.path)) return { items: [], truncated: false }

  // 来回切换标签页时不必每次重新遍历整个文件夹；5 秒内复用上一次结果。
  const cached = folderScanCache.get(folderId)
  if (cached && cached.path === folder.path && Date.now() - cached.at < FOLDER_SCAN_CACHE_MS) {
    return cached.listing
  }

  const root = resolve(folder.path)
  const files: string[] = []
  const scanCap = Math.max(limit, LINKED_SCAN_CAP)
  let capHit = false

  async function walk(dir: string): Promise<void> {
    if (files.length >= scanCap) {
      capHit = true
      return
    }
    // 某个子目录没权限时跳过它，不要把整个文件夹判成读取失败
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = resolve(dir, entry.name)
      if (entry.isDirectory()) continue
      if (!entry.isFile()) continue
      if (!IMAGE_MIME[extname(entry.name).toLowerCase()]) continue
      if (files.length >= scanCap) {
        capHit = true
        return
      }
      files.push(absolute)
    }
    // 先把当前目录的图片收进来，再递归子目录，常见结构（按相册分目录）下更快
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      await walk(resolve(dir, entry.name))
      if (files.length >= scanCap) return
    }
  }

  await walk(root)

  const items = await mapLimit(files, 16, async (absolute): Promise<LinkedFolderAsset | null> => {
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) return null
    const name = basename(absolute)
    return {
      kind: 'linked',
      folderId,
      relativePath: relative(root, absolute),
      name,
      mime: IMAGE_MIME[extname(name).toLowerCase()]!,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString()
    }
  })

  const sorted = items
    .filter((item): item is LinkedFolderAsset => item !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  const listing: LinkedFolderListing = {
    items: sorted.slice(0, limit),
    truncated: capHit || sorted.length > limit
  }
  folderScanCache.set(folderId, { at: Date.now(), path: folder.path, listing })
  return listing
}

function placementResult(
  deps: LocalLibraryDeps,
  projectId: string
): Extract<ImportResult, { ok: true }> {
  const graph = loadGraph(deps.db, projectId)
  return {
    ok: true,
    graph,
    assets: collectAssetInfos(deps.db, graph, deps.assetsDir),
    importedCount: 1,
    errors: []
  }
}

async function placeLibraryItem(
  deps: LocalLibraryDeps,
  projectId: string,
  item: LibraryDragItem,
  at: { x: number; y: number }
): Promise<string | null> {
  if (item.kind === 'managed') {
    const asset = getAsset(deps.db, item.assetId)
    if (!asset || asset.trashedAt) return '这个素材现在不可用'
    const natural = { width: asset.width ?? 240, height: asset.height ?? 180 }
    const display = displaySizeFor(natural)
    upsertNode(
      deps.db,
      createAssetNode({
        id: randomUUID(),
        projectId,
        name: asset.originalName?.trim() || asset.fileName,
        x: at.x,
        y: at.y,
        w: display.width || 240,
        h: display.height || 180,
        assetId: asset.id,
        naturalWidth: asset.width ?? 0,
        naturalHeight: asset.height ?? 0
      })
    )
    deps.db
      .prepare('UPDATE assets SET unreferenced_since = NULL, trashed_at = NULL WHERE id = ?')
      .run(asset.id)
    return null
  }

  const path = resolveLinkedAssetPath(deps.db, item.folderId, item.relativePath)
  if (!path) return '找不到这个文件，请重新连接文件夹后再试'
  let bytes: Uint8Array
  try {
    // HEIC/TIFF 浏览器和 nativeImage 都不认，先转成 PNG 再收进素材库。
    bytes = needsTranscode(path) ? await transcodeToPng(path) : new Uint8Array(await readFile(path))
  } catch {
    return '这张图片无法转换，请换一张试试'
  }
  await importOneImage(deps, projectId, {
    name: basename(path),
    bytes,
    importMethod: 'file',
    index: 0,
    at
  })
  return null
}

/**
 * 批量放入画布：多选拖进来时按 24px 阶梯错开，避免叠成一摞。
 * 只读一次图、最后统一回一份 graph，比逐张走 IPC 快。
 */
export async function placeLibraryItems(
  deps: LocalLibraryDeps,
  projectId: string,
  items: LibraryDragItem[],
  at: { x: number; y: number }
): Promise<ImportResult> {
  const errors: ImportFailure[] = []
  const seen = new Set<string>()
  let importedCount = 0

  for (const [index, item] of items.entries()) {
    const key = item.kind === 'managed' ? `m:${item.assetId}` : `l:${item.folderId}:${item.relativePath}`
    if (seen.has(key)) continue
    seen.add(key)
    const offset = Math.min(index, 12) * 24
    let message: string | null
    try {
      message = await placeLibraryItem(deps, projectId, item, { x: at.x + offset, y: at.y + offset })
    } catch (error) {
      message = error instanceof Error ? error.message : '素材放入失败'
    }
    if (message) {
      errors.push({ name: item.kind === 'linked' ? basename(item.relativePath) : '素材', message })
    } else {
      importedCount += 1
    }
  }

  if (importedCount === 0) {
    return { ok: false, message: errors[0]?.message ?? '素材放入失败' }
  }
  return { ...placementResult(deps, projectId), importedCount, errors }
}

export function trashManagedAsset(
  db: DatabaseSync,
  assetId: string,
  now = new Date(),
  protectedIds?: ReadonlySet<string>
): boolean {
  const refs = referencesByAsset(db).get(assetId) ?? 0
  if (refs > 0 || protectedIds?.has(assetId)) return false
  return (
    db
      .prepare('UPDATE assets SET trashed_at = ?, unreferenced_since = NULL WHERE id = ? AND trashed_at IS NULL')
      .run(now.toISOString(), assetId).changes > 0
  )
}

export function restoreManagedAsset(db: DatabaseSync, assetId: string, now = new Date()): boolean {
  return (
    db
      .prepare(
        `UPDATE assets
         SET trashed_at = NULL, retention_policy = 'temporary', unreferenced_since = ?
         WHERE id = ? AND trashed_at IS NOT NULL`
      )
      .run(now.toISOString(), assetId).changes > 0
  )
}

/** 批量移入回收站；引用统计只扫一次表，框选几十张也不会卡。 */
export function trashManagedAssets(
  db: DatabaseSync,
  assetIds: string[],
  now = new Date(),
  protectedIds?: ReadonlySet<string>
): TrashLibraryAssetsResult {
  const refs = referencesByAsset(db)
  const statement = db.prepare(
    'UPDATE assets SET trashed_at = ?, unreferenced_since = NULL WHERE id = ? AND trashed_at IS NULL'
  )
  const trashedAt = now.toISOString()
  let trashed = 0
  let blocked = 0
  for (const assetId of new Set(assetIds)) {
    if ((refs.get(assetId) ?? 0) > 0 || protectedIds?.has(assetId)) {
      blocked += 1
      continue
    }
    if (statement.run(trashedAt, assetId).changes > 0) trashed += 1
    else blocked += 1
  }
  return { trashed, blocked }
}

/** 批量还原；返回实际还原的张数。 */
export function restoreManagedAssets(db: DatabaseSync, assetIds: string[], now = new Date()): number {
  const statement = db.prepare(
    `UPDATE assets
     SET trashed_at = NULL, retention_policy = 'temporary', unreferenced_since = ?
     WHERE id = ? AND trashed_at IS NOT NULL`
  )
  const restoredAt = now.toISOString()
  let restored = 0
  for (const assetId of new Set(assetIds)) {
    if (statement.run(restoredAt, assetId).changes > 0) restored += 1
  }
  return restored
}
