import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AssetRejectedError,
  findAssetByHash,
  getAsset,
  listAssets,
  saveAsset,
  sha256Of
} from './assets'
import { migrate } from './db'

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
])

/** 与 PNG 只有一个字节不同的另一张图 */
const PNG_OTHER = Uint8Array.from(PNG.map((v, i) => (i === 20 ? v + 1 : v)))

const NOW = new Date('2026-10-14T10:00:00.000Z')

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  dir = mkdtempSync(join(tmpdir(), 'ins-pin-assets-'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 不指定 id：让它按内容哈希生成，和真实调用一致 */
const save = (bytes: Uint8Array, over: Record<string, unknown> = {}) =>
  saveAsset(db, dir, { bytes, importMethod: 'drag', ...over }, { now: NOW })

describe('saveAsset', () => {
  it('落盘 + 入库，文件名是内容哈希', async () => {
    const { asset, deduped } = await save(PNG)

    const hash = sha256Of(PNG)
    expect(deduped).toBe(false)
    expect(asset.sha256).toBe(hash)
    expect(asset.mime).toBe('image/png')
    expect(asset.bytes).toBe(PNG.length)
    expect(asset.fileName).toBe(`${hash}.png`)
    expect(existsSync(join(dir, asset.fileName))).toBe(true)
    expect(asset.createdAt).toBe(NOW.toISOString())
  })

  it('记录来源信息', async () => {
    const { asset } = await save(PNG, {
      importMethod: 'pin',
      sourceUrl: 'https://example.com/page',
      resourceUrl: 'https://cdn.example.com/a.png',
      pageUrl: 'https://example.com/page'
    })

    expect(asset.importMethod).toBe('pin')
    expect(asset.resourceUrl).toBe('https://cdn.example.com/a.png')
    expect(asset.pageUrl).toBe('https://example.com/page')
  })

  it('同一张图存两次只占一份文件、一条记录', async () => {
    const first = await save(PNG)
    const second = await save(PNG)

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.asset.id).toBe(first.asset.id)
    expect(listAssets(db)).toHaveLength(1)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('内容不同的图各存一份', async () => {
    await save(PNG)
    await save(PNG_OTHER)

    expect(listAssets(db)).toHaveLength(2)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('文件被手动删掉后，重新导入会补回来', async () => {
    const first = await save(PNG)
    rmSync(join(dir, first.asset.fileName))

    await save(PNG)

    expect(existsSync(join(dir, first.asset.fileName))).toBe(true)
    expect(listAssets(db)).toHaveLength(1)
  })
})

describe('saveAsset 的拒绝情况', () => {
  async function expectRejected(
    bytes: Uint8Array,
    reason: string
  ): Promise<AssetRejectedError> {
    const error = await save(bytes).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetRejectedError)
    expect((error as AssetRejectedError).reason).toBe(reason)
    return error as AssetRejectedError
  }

  it('空文件', async () => {
    const error = await expectRejected(new Uint8Array(), 'empty')
    expect(error.message).toContain('空')
  })

  it('不是图片，并说清楚看起来是什么', async () => {
    const error = await expectRejected(new TextEncoder().encode('就是一段文字'), 'not-image')
    expect(error.message).toContain('这不是图片')
    expect(error.message).toContain('文本文件')
    expect(error.detail).toBe('文本文件')
  })

  it('图片损坏', async () => {
    const truncated = PNG.subarray(0, 33)
    const error = await expectRejected(truncated, 'corrupt')
    expect(error.message).toContain('损坏')
  })

  it('被拒绝时库里不留记录、磁盘不留文件', async () => {
    await save(new Uint8Array()).catch(() => undefined)
    await save(new TextEncoder().encode('text')).catch(() => undefined)

    expect(listAssets(db)).toHaveLength(0)
    expect(readdirSync(dir)).toHaveLength(0)
  })
})

describe('查询', () => {
  it('按哈希查得到', async () => {
    const { asset } = await save(PNG)
    expect(findAssetByHash(db, sha256Of(PNG))?.id).toBe(asset.id)
    expect(findAssetByHash(db, '不存在的哈希')).toBeNull()
  })

  it('按 id 查得到', async () => {
    const { asset } = await save(PNG)
    expect(getAsset(db, asset.id)?.mime).toBe('image/png')
    expect(getAsset(db, 'nope')).toBeNull()
  })

  it('列表按时间倒序', async () => {
    await saveAsset(db, dir, { bytes: PNG, importMethod: 'drag' }, { id: 'old', now: NOW })
    await saveAsset(db, dir, { bytes: PNG_OTHER, importMethod: 'drag' }, { id: 'new', now: new Date('2026-10-14T11:00:00.000Z') })
    expect(listAssets(db).map((a) => a.id)).toEqual(['new', 'old'])
  })
})
