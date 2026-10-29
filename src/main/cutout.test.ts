import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db'
import { importOneImage } from './import-files'
import { createProject } from './projects'
import { cutoutCapability, cutoutName, runCutout, sanitizeCutoutTargets } from './cutout'

// 1×1 的最小 PNG；导入流程只需要合法头部与 IEND。
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
])

let db: DatabaseSync
let assetsDir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  assetsDir = mkdtempSync(join(tmpdir(), 'ins-pin-cutout-assets-'))
  createProject(db, '项目', { id: 'p1' })
})

afterEach(() => {
  db.close()
  rmSync(assetsDir, { recursive: true, force: true })
})

describe('cutoutCapability', () => {
  it('macOS 14 以下或组件缺失时不可用', () => {
    expect(cutoutCapability('/bin/sh', '13.6.9')).toMatchObject({ available: false })
    expect(cutoutCapability('/definitely/not/here', '14.0')).toMatchObject({ available: false })
    expect(cutoutCapability('/bin/sh', '14.0', 'x64')).toMatchObject({ available: false })
  })

  it('系统与可执行组件均符合时可用', () => {
    expect(cutoutCapability('/bin/sh', '14.0', 'arm64')).toEqual({ available: true })
  })
})

describe('sanitizeCutoutTargets', () => {
  it('只接受恰好一张合法目标，坏坐标退化为 null', () => {
    expect(sanitizeCutoutTargets([{ nodeId: 'n1', assetId: 'a1', at: { x: Number.NaN, y: 20 } }])).toEqual([
      { nodeId: 'n1', assetId: 'a1', at: null }
    ])
    expect(sanitizeCutoutTargets([{ nodeId: 'n1', assetId: 'a1' }, { nodeId: 'n2', assetId: 'a2' }])).toEqual([])
  })
})

describe('runCutout', () => {
  it('成功时保留原图并把透明 PNG 作为右侧新节点导回画布', async () => {
    const original = await importOneImage(
      { db, assetsDir, measure: () => ({ width: 200, height: 100 }), newId: () => 'original' },
      'p1',
      {
        name: '原图.png',
        bytes: PNG,
        importMethod: 'file',
        index: 0,
        at: { x: 100, y: 50 },
        sourceUrl: 'https://cdn.example.com/original.png',
        resourceUrl: 'https://cdn.example.com/original.png',
        pageUrl: 'https://www.behance.net/gallery/123'
      }
    )
    const result = await runCutout(
      {
        db,
        assetsDir,
        measure: () => ({ width: 200, height: 100 }),
        logger: { info: () => undefined, error: () => undefined },
        helperPath: '/bin/sh',
        systemVersion: '14.0',
        architecture: 'arm64',
        runSubjectLift: async (_helper, _input, output) => writeFileSync(output, PNG)
      },
      'p1',
      [{ nodeId: original.node.id, assetId: original.asset.id, at: { x: 324, y: 50 } }]
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.importedCount).toBe(1)
    expect(result.graph.rootIds).toHaveLength(2)
    expect(result.importedNode).toMatchObject({ x: 324, y: 50 })
    expect(result.graph.nodes[original.node.id]).toBeDefined()
    const cutoutNode = result.importedNode && result.graph.nodes[result.importedNode.id]
    if (!cutoutNode || cutoutNode.type !== 'asset') throw new Error('没有导入抠图节点')
    expect(result.assets[cutoutNode.props.assetId]).toMatchObject({
      sourceUrl: 'https://cdn.example.com/original.png',
      pageUrl: 'https://www.behance.net/gallery/123'
    })
  })

  it('原生处理失败时不生成新节点，并返回可读错误', async () => {
    const original = await importOneImage(
      { db, assetsDir, measure: () => ({ width: 1, height: 1 }), newId: () => 'original' },
      'p1',
      { name: '原图.png', bytes: PNG, importMethod: 'file', index: 0 }
    )
    const result = await runCutout(
      {
        db, assetsDir, measure: () => ({ width: 1, height: 1 }),
        logger: { info: () => undefined, error: () => undefined }, helperPath: '/bin/sh', systemVersion: '14.0', architecture: 'arm64',
        runSubjectLift: async () => { throw new Error('这张图没有识别到明显主体') }
      },
      'p1',
      [{ nodeId: original.node.id, assetId: original.asset.id, at: null }]
    )
    expect(result).toEqual({ ok: false, message: '这张图没有识别到明显主体，换一张试试' })
  })
})

describe('cutoutName', () => {
  it('沿用原名并换成 PNG 后缀', () => {
    expect(cutoutName('商品主图.jpg')).toBe('商品主图-抠图.png')
    expect(cutoutName('  ')).toBe('图片-抠图.png')
  })
})
