import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db'
import { getAsset } from './assets'
import {
  countRootNodes,
  displaySizeFor,
  importImageFiles,
  importOneImage,
  messageFor,
  placementFor,
  type ImageMeasurer
} from './import-files'
import { loadGraph } from './nodes'
import { createProject } from './projects'

// 与 assets.test.ts 同一张最小可用 PNG（头部 + IHDR + IEND）
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

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180"/></svg>'
)

const NOW = new Date('2026-10-14T10:00:00.000Z')
const measure400x300: ImageMeasurer = () => ({ width: 400, height: 300 })

let db: DatabaseSync
let assetsDir: string
let sourceDir: string
let counter = 0

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  assetsDir = mkdtempSync(join(tmpdir(), 'ins-pin-import-assets-'))
  sourceDir = mkdtempSync(join(tmpdir(), 'ins-pin-import-src-'))
  counter = 0
  createProject(db, '项目', { id: 'p1', now: NOW })
})

afterEach(() => {
  db.close()
  rmSync(assetsDir, { recursive: true, force: true })
  rmSync(sourceDir, { recursive: true, force: true })
})

/** 在源目录里造一个文件，返回它的绝对路径。 */
function makeSourceFile(name: string, bytes: Uint8Array): string {
  const path = join(sourceDir, name)
  writeFileSync(path, bytes)
  return path
}

const run = (paths: string[], measure: ImageMeasurer = measure400x300) =>
  importImageFiles(
    { db, assetsDir, measure, now: () => NOW, newId: () => `n${counter++}` },
    'p1',
    paths
  )

describe('importImageFiles', () => {
  it('SVG 能落盘，并在解码器失效时从标签上读出尺寸', async () => {
    const path = makeSourceFile('图标.svg', SVG)
    // 模拟 Electron 的 nativeImage 解不了 SVG
    const outcome = await run([path], () => null)

    expect(outcome.errors).toEqual([])
    expect(outcome.imported).toHaveLength(1)
    const imported = outcome.imported[0]!
    expect(getAsset(db, imported.asset.id)?.mime).toBe('image/svg+xml')
    expect(imported.node.props.naturalWidth).toBe(320)
    expect(imported.node.props.naturalHeight).toBe(180)
    expect(imported.node.w).toBe(320)
    expect(imported.node.h).toBe(180)
  })

  it('把图片落盘、建节点、写进项目', async () => {
    const path = makeSourceFile('灵感.png', PNG)
    const outcome = await run([path])

    expect(outcome.errors).toEqual([])
    expect(outcome.imported).toHaveLength(1)
    expect(outcome.imported[0]?.deduped).toBe(false)

    const graph = loadGraph(db, 'p1')
    expect(graph.rootIds).toHaveLength(1)
    const node = graph.nodes[graph.rootIds[0]!]
    expect(node?.type).toBe('asset')
    expect(node?.name).toBe('灵感.png')
    if (node?.type === 'asset') {
      expect(node.props.naturalWidth).toBe(400)
      expect(node.props.naturalHeight).toBe(300)
      expect(node.w).toBe(400)
      expect(node.h).toBe(300)
    }

    expect(readdirSync(assetsDir)).toHaveLength(1)
  })

  it('同一张图导入两次：只存一份文件，但能用两次', async () => {
    const first = makeSourceFile('a.png', PNG)
    const second = makeSourceFile('b.png', PNG)

    const outcome = await run([first, second])

    expect(outcome.imported.map((item) => item.deduped)).toEqual([false, true])
    expect(outcome.imported[0]?.asset.id).toBe(outcome.imported[1]?.asset.id)
    expect(readdirSync(assetsDir)).toHaveLength(1)
    expect(loadGraph(db, 'p1').rootIds).toHaveLength(2)
  })

  it('不是图片的文件被拒绝，且不留下任何节点', async () => {
    const text = makeSourceFile('笔记.txt', new TextEncoder().encode('这不是图片'))
    const outcome = await run([text])

    expect(outcome.imported).toEqual([])
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]?.message).toContain('不是图片')
    // 失败项要带文件名（给界面看），同时保留完整路径（只进日志）
    expect(outcome.errors[0]?.name).toBe('笔记.txt')
    expect(outcome.errors[0]?.path).toBe(text)
    expect(loadGraph(db, 'p1').rootIds).toEqual([])
    expect(readdirSync(assetsDir)).toEqual([])
  })

  it('读不到的文件只影响它自己', async () => {
    const good = makeSourceFile('ok.png', PNG)
    const outcome = await run([join(sourceDir, '不存在.png'), good])

    expect(outcome.imported).toHaveLength(1)
    expect(outcome.errors).toHaveLength(1)
    expect(loadGraph(db, 'p1').rootIds).toHaveLength(1)
  })

  it('多张图错开摆放，不叠在一起', async () => {
    const a = makeSourceFile('a.png', PNG)
    const b = makeSourceFile('b.png', PNG)
    const c = makeSourceFile('c.png', PNG)
    await run([a, b, c])

    const graph = loadGraph(db, 'p1')
    const positions = graph.rootIds.map((id) => `${graph.nodes[id]?.x},${graph.nodes[id]?.y}`)
    expect(new Set(positions).size).toBe(3)
  })
})

describe('importOneImage', () => {
  const deps = () => ({
    db,
    assetsDir,
    measure: measure400x300,
    now: () => NOW,
    newId: () => `n${counter++}`
  })

  it('尺寸已知就直接用，不再去解码', async () => {
    const item = await importOneImage(deps(), 'p1', {
      name: '剪贴板图片.png',
      bytes: PNG,
      width: 1000,
      height: 500,
      importMethod: 'clipboard',
      index: countRootNodes(db, 'p1')
    })

    // 1000x500 的长边压到 400 → 400x200
    expect({ w: item.node.w, h: item.node.h }).toEqual({ w: 400, h: 200 })
    expect(getAsset(db, item.asset.id)?.importMethod).toBe('clipboard')
    expect(getAsset(db, item.asset.id)?.retentionPolicy).toBe('permanent')
    expect(countRootNodes(db, 'p1')).toBe(1)
  })

  it('解码失败时从文件头保住正方图的比例，并给出可选中的大小', async () => {
    const item = await importOneImage(
      { ...deps(), measure: () => null },
      'p1',
      { name: 'x.png', bytes: PNG, importMethod: 'clipboard', index: 0 }
    )
    expect({ w: item.node.w, h: item.node.h }).toEqual({ w: 240, h: 240 })
    expect(item.node.props.naturalWidth).toBe(1)
  })

  it('解码失败时仍按图片文件头的比例建立低清副本，绝不压成固定 4:3', async () => {
    // 模拟一张浏览器能显示、但 Electron 解码器暂时没有读出尺寸的 600×900 竖图。
    // PNG 的 IHDR 宽高分别在第 16–23 个字节，以大端整数保存。
    const portrait = Uint8Array.from(PNG)
    portrait.set([0x00, 0x00, 0x02, 0x58, 0x00, 0x00, 0x03, 0x84], 16)

    const item = await importOneImage(
      { ...deps(), measure: () => null },
      'p1',
      { name: '低清竖图.png', bytes: portrait, importMethod: 'drag', index: 0 }
    )

    // 走正常导入的 400px 长边上限，宽高仍须是原图的 2:3。
    expect({ w: item.node.w, h: item.node.h }).toEqual({ w: 267, h: 400 })
    expect({ width: item.node.props.naturalWidth, height: item.node.props.naturalHeight }).toEqual({
      width: 600,
      height: 900
    })
    expect(getAsset(db, item.asset.id)?.retentionPolicy).toBe('temporary')
  })
})

describe('displaySizeFor', () => {
  it('长边压到上限以内并保持比例', () => {
    expect(displaySizeFor({ width: 800, height: 600 })).toEqual({ width: 400, height: 300 })
    expect(displaySizeFor({ width: 1000, height: 2000 })).toEqual({ width: 200, height: 400 })
  })

  it('小图不放大', () => {
    expect(displaySizeFor({ width: 120, height: 80 })).toEqual({ width: 120, height: 80 })
  })

  it('尺寸未知时返回 0，交给 <img> 按原始尺寸显示', () => {
    expect(displaySizeFor({ width: 0, height: 0 })).toEqual({ width: 0, height: 0 })
  })
})

describe('placementFor', () => {
  it('同一列内横向递增、满一列后下移', () => {
    expect(placementFor(1).x).toBeGreaterThan(placementFor(0).x)
    expect(placementFor(1).y).toBe(placementFor(0).y)
    expect(placementFor(6).y).toBeGreaterThan(placementFor(0).y)
  })
})

describe('measure 失败时', () => {
  it('不阻断导入，节点仍然能抓能选且保持文件头比例', async () => {
    const path = makeSourceFile('unknown.png', PNG)
    const outcome = await run([path], () => null)

    expect(outcome.errors).toEqual([])
    const node = loadGraph(db, 'p1').nodes[loadGraph(db, 'p1').rootIds[0]!]
    expect({ w: node?.w, h: node?.h }).toEqual({ w: 240, h: 240 })
    expect(existsSync(assetsDir)).toBe(true)
  })
})

describe('messageFor 把文件系统错误翻成人话（D6a.4）', () => {
  const withCode = (code: string): Error => Object.assign(new Error(`${code}: raw os text`), { code })

  it('磁盘满 / 没权限 / 只读 / 文件不在，都给能照做的话', () => {
    expect(messageFor(withCode('ENOSPC'))).toContain('磁盘空间不够')
    expect(messageFor(withCode('EACCES'))).toContain('没有写入权限')
    expect(messageFor(withCode('EROFS'))).toContain('只读')
    expect(messageFor(withCode('ENOENT'))).toContain('找不到要读的文件')
    // 这些文案里都不该漏出底层错误码
    for (const code of ['ENOSPC', 'EACCES', 'EROFS', 'ENOENT']) {
      expect(messageFor(withCode(code))).not.toContain(code)
    }
  })

  it('认不出来的错误退回通用说法，不把原始信息原样甩给用户', () => {
    expect(messageFor(new Error('something odd'))).toBe('读取失败：something odd')
    expect(messageFor('乱七八糟')).toBe('导入失败')
  })
})
