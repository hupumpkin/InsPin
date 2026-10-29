import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveAsset } from './assets'
import { updateAssetReferenceClocks } from './asset-retention'
import { migrate } from './db'
import {
  getLocalLibraryState,
  linkFolder,
  listLinkedFolderAssets,
  reconcileLibrary,
  resolveLinkedAssetPath,
  restoreManagedAsset,
  restoreManagedAssets,
  trashManagedAssets,
  TRASH_RETENTION_MS,
  UNUSED_GRACE_MS
} from './local-library'

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])

let db: DatabaseSync
let root: string
let assetsDir: string
let thumbnailsDir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  root = mkdtempSync(join(tmpdir(), 'inspin-library-'))
  assetsDir = join(root, 'assets')
  thumbnailsDir = join(root, 'thumbs')
  mkdirSync(assetsDir)
  mkdirSync(thumbnailsDir)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function deps(now: Date) {
  return { db, assetsDir, thumbnailsDir, measure: () => ({ width: 1, height: 1 }), now: () => now }
}

describe('本地素材生命周期', () => {
  it('画布自动收集的素材连续 3 天无引用后进入回收站', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const { asset } = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', originalName: '灵感.png', retentionPolicy: 'temporary' },
      { now: start }
    )

    await reconcileLibrary(deps(start))
    expect((await getLocalLibraryState(deps(start))).managed).toHaveLength(1)

    const afterGrace = new Date(start.getTime() + UNUSED_GRACE_MS + 1)
    const state = await getLocalLibraryState(deps(afterGrace))
    expect(state.managed).toHaveLength(0)
    expect(state.trash.map((item) => item.id)).toEqual([asset.id])
  })

  it('主动保存的素材无引用也永久保留', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', retentionPolicy: 'permanent' },
      { now: start }
    )
    const muchLater = new Date(start.getTime() + UNUSED_GRACE_MS * 10)
    const state = await getLocalLibraryState(deps(muchLater))
    expect(state.managed).toHaveLength(1)
    expect(state.trash).toHaveLength(0)
  })

  it('还原只回素材库，并重新开始 3 天无引用计时', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const { asset } = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', retentionPolicy: 'temporary' },
      { now: start }
    )
    db.prepare('UPDATE assets SET trashed_at = ? WHERE id = ?').run(start.toISOString(), asset.id)
    const restoredAt = new Date('2026-10-10T00:00:00.000Z')
    expect(restoreManagedAsset(db, asset.id, restoredAt)).toBe(true)
    expect((await getLocalLibraryState(deps(restoredAt))).managed).toHaveLength(1)
    const state = await getLocalLibraryState(deps(new Date(restoredAt.getTime() + UNUSED_GRACE_MS + 1)))
    expect(state.trash).toHaveLength(1)
  })

  it('最后一个画布引用消失时立即开始 3 天计时', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const { asset } = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', retentionPolicy: 'temporary' },
      { now: start }
    )
    updateAssetReferenceClocks(db, start)
    expect(db.prepare('SELECT unreferenced_since FROM assets WHERE id = ?').get(asset.id)).toEqual({
      unreferenced_since: start.toISOString()
    })
  })

  it('回收站停留满 30 天后清理数据库与本地文件', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const { asset } = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', retentionPolicy: 'temporary' },
      { now: start }
    )
    db.prepare('UPDATE assets SET trashed_at = ? WHERE id = ?').run(start.toISOString(), asset.id)

    await reconcileLibrary(deps(new Date(start.getTime() + TRASH_RETENTION_MS + 1)))

    expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(asset.id)).toBeUndefined()
    expect(existsSync(join(assetsDir, asset.fileName))).toBe(false)
  })

  it('关掉自动清理后只计时，不移动也不删除', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const { asset } = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', retentionPolicy: 'temporary' },
      { now: start }
    )
    const later = new Date(start.getTime() + UNUSED_GRACE_MS + TRASH_RETENTION_MS + 1)
    const policy = { enabled: false, graceDays: 3, trashDays: 30 }
    // 先在起点跑一次，让"多久没被引用"的计时真正开始
    await reconcileLibrary({ ...deps(start), cleanup: () => policy })
    await reconcileLibrary({ ...deps(later), cleanup: () => policy })

    expect(existsSync(join(assetsDir, asset.fileName))).toBe(true)
    expect((await getLocalLibraryState({ ...deps(later), cleanup: () => ({ enabled: false, graceDays: 3, trashDays: 30 }) })).managed).toHaveLength(1)
  })

  it('宽限期可以改：7 天时第 4 天还在，第 8 天进回收站', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const { asset } = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', retentionPolicy: 'temporary' },
      { now: start }
    )
    const policy = { enabled: true, graceDays: 7, trashDays: 30 }

    // 在起点先记下"从什么时候开始没被引用"
    await reconcileLibrary({ ...deps(start), cleanup: () => policy })

    const day4 = new Date(start.getTime() + 4 * 24 * 60 * 60 * 1000)
    await reconcileLibrary({ ...deps(day4), cleanup: () => policy })
    expect(db.prepare('SELECT trashed_at FROM assets WHERE id = ?').get(asset.id)).toEqual({
      trashed_at: null
    })

    const day8 = new Date(start.getTime() + 8 * 24 * 60 * 60 * 1000)
    await reconcileLibrary({ ...deps(day8), cleanup: () => policy })
    expect(
      (db.prepare('SELECT trashed_at FROM assets WHERE id = ?').get(asset.id) as { trashed_at: string })
        .trashed_at
    ).not.toBeNull()
  })

  it('批量移入回收站会跳过受保护的素材，批量还原只动回收站里的', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const first = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'file', retentionPolicy: 'permanent' },
      { now: start }
    )
    // 换一个字节，避免内容哈希去重把两张合成同一份
    const second = await saveAsset(
      db,
      assetsDir,
      { bytes: Uint8Array.from([...PNG, 0]), importMethod: 'file', retentionPolicy: 'permanent' },
      { now: start }
    )

    const trashed = trashManagedAssets(db, [first.asset.id, second.asset.id], start, new Set([first.asset.id]))
    expect(trashed).toEqual({ trashed: 1, blocked: 1 })
    expect((await getLocalLibraryState(deps(start))).trash.map((item) => item.id)).toEqual([second.asset.id])

    expect(restoreManagedAssets(db, [first.asset.id, second.asset.id], start)).toBe(1)
    const state = await getLocalLibraryState(deps(start))
    expect(state.managed.map((item) => item.id).sort()).toEqual([first.asset.id, second.asset.id].sort())
    expect(state.trash).toHaveLength(0)
  })

  it('离线超过 33 天后会一次补算并直接清理', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z')
    const { asset } = await saveAsset(
      db,
      assetsDir,
      { bytes: PNG, importMethod: 'drag', retentionPolicy: 'temporary' },
      { now: start }
    )
    updateAssetReferenceClocks(db, start)

    await reconcileLibrary(deps(new Date(start.getTime() + UNUSED_GRACE_MS + TRASH_RETENTION_MS + 1)))

    expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(asset.id)).toBeUndefined()
  })
})

describe('外部只读文件夹', () => {
  it('只列出图片并拒绝越出链接目录的路径', async () => {
    const folderPath = join(root, '来源')
    mkdirSync(folderPath)
    writeFileSync(join(folderPath, '图片.png'), PNG)
    writeFileSync(join(folderPath, '说明.txt'), 'not an image')
    const outside = join(root, 'outside.png')
    writeFileSync(outside, PNG)
    symlinkSync(outside, join(folderPath, '逃逸.png'))
    const folder = linkFolder(db, folderPath)

    const listing = await listLinkedFolderAssets(db, folder.id)
    expect(listing.items.map((item) => item.name)).toEqual(['图片.png'])
    expect(listing.truncated).toBe(false)
    expect(resolveLinkedAssetPath(db, folder.id, '图片.png')).toBe(realpathSync(join(folderPath, '图片.png')))
    expect(resolveLinkedAssetPath(db, folder.id, '说明.txt')).toBeNull()
    expect(resolveLinkedAssetPath(db, folder.id, '逃逸.png')).toBeNull()
    expect(resolveLinkedAssetPath(db, folder.id, '../outside.png')).toBeNull()
  })

  it('把 HEIC/TIFF 也列出来，交给系统解码器处理', async () => {
    const folderPath = join(root, '手机相册')
    mkdirSync(folderPath)
    writeFileSync(join(folderPath, 'IMG_0001.HEIC'), PNG)
    writeFileSync(join(folderPath, '扫描件.TIFF'), PNG)
    writeFileSync(join(folderPath, 'IMG_0002.JPG'), PNG)
    const folder = linkFolder(db, folderPath)

    const listing = await listLinkedFolderAssets(db, folder.id)
    const byName = new Map(listing.items.map((item) => [item.name, item.mime]))
    expect(byName.get('IMG_0001.HEIC')).toBe('image/heic')
    expect(byName.get('扫描件.TIFF')).toBe('image/tiff')
    expect(byName.get('IMG_0002.JPG')).toBe('image/jpeg')
  })

  it('超过返回上限时明确告诉界面“只显示了一部分”', async () => {
    const folderPath = join(root, '很多图')
    mkdirSync(folderPath)
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(folderPath, `${index}.png`), PNG)
    }
    const folder = linkFolder(db, folderPath)

    const listing = await listLinkedFolderAssets(db, folder.id, 3)
    expect(listing.items).toHaveLength(3)
    expect(listing.truncated).toBe(true)
  })
})
