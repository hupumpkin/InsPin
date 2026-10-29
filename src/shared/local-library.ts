export type LibraryViewMode = 'grid' | 'list'
export const LIBRARY_DRAG_MIME = 'application/x-inspin-library-item'

export interface ManagedLibraryAsset {
  kind: 'managed'
  id: string
  name: string
  fileName: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  createdAt: string
  unreferencedSince: string | null
  trashedAt: string | null
}

export interface LinkedFolderSummary {
  id: string
  name: string
  available: boolean
  createdAt: string
}

export interface LinkedFolderAsset {
  kind: 'linked'
  folderId: string
  relativePath: string
  name: string
  mime: string
  bytes: number
  modifiedAt: string
}

/** 一个文件夹的浏览结果。`truncated` = 图片太多，只返回了最近的一部分。 */
export interface LinkedFolderListing {
  items: LinkedFolderAsset[]
  truncated: boolean
}

export type LibraryDragItem =
  | { kind: 'managed'; assetId: string }
  | { kind: 'linked'; folderId: string; relativePath: string }

/** 一次拖拽可以带多张素材；单选时也统一走这个结构，画布只需认一种格式。 */
export interface LibraryDragBundle {
  items: LibraryDragItem[]
}

/** 校验来自 dataTransfer 的任意值，别把脏数据直接交给主进程。 */
export function isLibraryDragItem(value: unknown): value is LibraryDragItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (item.kind === 'managed') return typeof item.assetId === 'string' && item.assetId.length > 0
  if (item.kind === 'linked') {
    return typeof item.folderId === 'string' && item.folderId.length > 0 && typeof item.relativePath === 'string'
  }
  return false
}

/** 解析拖拽负载：兼容早期的单张格式和现在的 `{ items }` 批量格式。 */
export function parseLibraryDragPayload(raw: string): LibraryDragItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    const rawItems =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as LibraryDragBundle).items)
        ? (parsed as LibraryDragBundle).items
        : [parsed]
    return rawItems.filter(isLibraryDragItem)
  } catch {
    return []
  }
}

export interface LocalLibraryState {
  managed: ManagedLibraryAsset[]
  trash: ManagedLibraryAsset[]
  folders: LinkedFolderSummary[]
}

export type LibraryResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; canceled?: boolean }

export interface PlaceLibraryItemsRequest {
  projectId: string
  items: LibraryDragItem[]
  at: { x: number; y: number }
}

export interface TrashLibraryAssetsResult {
  trashed: number
  /** 仍被画布引用（或参考快照在用）而没删掉的张数。 */
  blocked: number
}
