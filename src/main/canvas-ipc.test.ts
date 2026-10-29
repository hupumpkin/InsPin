import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAsset } from './assets'
import {
  importClipboard,
  importPaths,
  importWeb,
  loadCanvas,
  pickImageMimeType,
  rankedClipboardAssetTypes,
  sanitizeWebDropRequest
} from './canvas-ipc'
import type { FetchLike } from './download'
import type { ClipboardContent, ClipboardImage } from './canvas-ipc'
import { migrate } from './db'
import type { ImageMeasurer } from './import-files'
import { loadGraph, saveGraph } from './nodes'
import { createFrameNode } from '../shared/node'
import { createProject } from './projects'
import type { ProjectLogSink } from './projects-ipc'
import { NO_USABLE_ADDRESS } from './web-import'

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
const TEXT = new TextEncoder().encode('这不是图片')
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><path d="M0 0h24v12H0z"/></svg>'
)

const NOW = new Date('2026-10-14T10:00:00.000Z')
const noMeasure: ImageMeasurer = () => null
const silent: ProjectLogSink = { info: () => {}, error: () => {} }

const clipboardWith = (content: ClipboardContent | ClipboardContent[] | null) => async () => content
const CLIP_IMAGE: ClipboardImage = {
  name: '剪贴板图片.png',
  bytes: PNG,
  width: 800,
  height: 600
}

let db: DatabaseSync
let assetsDir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  assetsDir = mkdtempSync(join(tmpdir(), 'ins-pin-canvas-ipc-'))
  createProject(db, '项目', { id: 'p1', now: NOW })
})

afterEach(() => {
  db.close()
  rmSync(assetsDir, { recursive: true, force: true })
})

const deps = (read: () => Promise<ClipboardContent | ClipboardContent[] | null>) => ({
  db,
  assetsDir,
  measure: noMeasure,
  logger: silent,
  readClipboardImage: read
})

describe('loadCanvas', () => {
  it('没有项目 id / 项目不存在时给可读提示', () => {
    expect(loadCanvas(db, '')).toMatchObject({ ok: false })
    expect(loadCanvas(db, undefined)).toMatchObject({ ok: false })
    expect(loadCanvas(db, '不存在')).toMatchObject({ ok: false, message: '项目不存在' })
  })

  it('返回整张画布与用到的素材', () => {
    const result = loadCanvas(db, 'p1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.graph.rootIds).toEqual([])
      expect(result.assets).toEqual({})
    }
  })
})

describe('importClipboard', () => {
  it('把剪贴板里的图片存进项目，来源标为 clipboard', async () => {
    const result = await importClipboard(deps(clipboardWith(CLIP_IMAGE)), 'p1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.importedCount).toBe(1)
    expect(result.errors).toEqual([])

    const graph = loadGraph(db, 'p1')
    expect(graph.rootIds).toHaveLength(1)
    const node = graph.nodes[graph.rootIds[0]!]
    expect(node?.name).toBe('剪贴板图片.png')
    // 800x600 的长边压到 400 → 400x300
    expect(node?.w).toBe(400)
    expect(node?.h).toBe(300)

    if (node?.type === 'asset') {
      expect(getAsset(db, node.props.assetId)?.importMethod).toBe('clipboard')
    }
    expect(readdirSync(assetsDir)).toHaveLength(1)
  })

  it('剪贴板里没有可导入内容时给一句人话，且不写任何东西', async () => {
    const result = await importClipboard(deps(clipboardWith(null)), 'p1')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.message).toContain('剪贴板里没有可导入')
    expect(loadGraph(db, 'p1').rootIds).toEqual([])
    expect(readdirSync(assetsDir)).toEqual([])
  })

  it('没有项目时先提示建项目', async () => {
    const result = await importClipboard(deps(clipboardWith(CLIP_IMAGE)), null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('先新建一个项目')
  })

  it('连续粘贴同一张图：文件只存一份，画布上两张', async () => {
    await importClipboard(deps(clipboardWith(CLIP_IMAGE)), 'p1')
    await importClipboard(deps(clipboardWith(CLIP_IMAGE)), 'p1')

    expect(loadGraph(db, 'p1').rootIds).toHaveLength(2)
    expect(readdirSync(assetsDir)).toHaveLength(1)
  })

  it('把剪贴板里的原始 SVG 内容当作矢量素材导入', async () => {
    const result = await importClipboard(
      deps(clipboardWith({ name: '剪贴板图片.svg', bytes: SVG, width: 0, height: 0 })),
      'p1'
    )

    expect(result).toMatchObject({ ok: true, importedCount: 1, errors: [] })
    const graph = loadGraph(db, 'p1')
    const node = graph.nodes[graph.rootIds[0]!]
    expect(node).toMatchObject({ name: '剪贴板图片.svg', w: 240, h: 120 })
    if (node?.type === 'asset') expect(getAsset(db, node.props.assetId)?.mime).toBe('image/svg+xml')
  })

  it('把普通剪贴板文本以默认文本框粘进画布，不保留原格式', async () => {
    const result = await importClipboard(deps(clipboardWith({ text: '第一行\n第二行' })), 'p1')

    expect(result).toMatchObject({ ok: true, importedCount: 0, importedTextCount: 1, errors: [] })
    const node = loadGraph(db, 'p1').nodes[loadGraph(db, 'p1').rootIds[0]!]
    expect(node).toMatchObject({ type: 'frame', name: '文本' })
    if (node?.type === 'frame') {
      expect(node.props.element).toEqual({ kind: 'text', text: '第一行\n第二行', color: '#3D414D', fontSize: 16 })
    }
  })

  it('按传入的画布落点居中粘贴图片和默认文本框', async () => {
    await importClipboard(deps(clipboardWith(CLIP_IMAGE)), 'p1', { x: 600, y: 400 })
    await importClipboard(deps(clipboardWith({ text: '落点文本' })), 'p1', { x: 200, y: 100 })

    const graph = loadGraph(db, 'p1')
    const image = graph.nodes[graph.rootIds[0]!]
    const text = graph.nodes[graph.rootIds[1]!]
    expect(image).toMatchObject({ x: 400, y: 250, w: 400, h: 300 })
    expect(text).toMatchObject({ x: 157, y: 87 })
  })

  it('剪贴板里有多张图时一次全部导入', async () => {
    const result = await importClipboard(
      deps(
        clipboardWith([
          { ...CLIP_IMAGE, name: '第一张.png' },
          { ...CLIP_IMAGE, name: '第二张.png' }
        ])
      ),
      'p1'
    )

    expect(result).toMatchObject({ ok: true, importedCount: 2, errors: [] })
    expect(loadGraph(db, 'p1').rootIds).toHaveLength(2)
  })

  it('多张图一起粘进自动布局容器时整组落位', async () => {
    const container = createFrameNode({
      id: 'auto',
      projectId: 'p1',
      name: '自动布局',
      w: 300,
      h: 100,
      props: { layoutMode: 'horizontal' }
    })
    saveGraph(db, { projectId: 'p1', rootIds: ['auto'], nodes: { auto: container } })

    const result = await importClipboard(
      deps(
        clipboardWith([
          { ...CLIP_IMAGE, name: '第一张.png' },
          { ...CLIP_IMAGE, name: '第二张.png' }
        ])
      ),
      'p1',
      null,
      { containerId: 'auto', index: 0 }
    )

    expect(result).toMatchObject({ ok: true, importedCount: 2 })
    const graph = loadGraph(db, 'p1')
    expect(graph.rootIds).toEqual(['auto'])
    expect(graph.nodes['auto']?.childIds).toHaveLength(2)
  })

  it('剪贴板里其实是坏图时给提示而不是脏数据', async () => {
    const result = await importClipboard(
      deps(clipboardWith({ name: '坏图.png', bytes: TEXT, width: 10, height: 10 })),
      'p1'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.importedCount).toBe(0)
      expect(result.errors[0]?.message).toContain('不是图片')
    }
    expect(loadGraph(db, 'p1').rootIds).toEqual([])
  })
})

describe('pickImageMimeType', () => {
  it('优先选 PNG', () => {
    expect(pickImageMimeType(['text/plain', 'image/jpeg', 'image/png'])).toBe('image/png')
  })

  it('没有 PNG 就取任意图片类型', () => {
    expect(pickImageMimeType(['text/html', 'image/tiff'])).toBe('image/tiff')
  })

  it('没有图片类型时返回 null', () => {
    expect(pickImageMimeType(['text/plain', 'text/html'])).toBeNull()
    expect(pickImageMimeType([])).toBeNull()
  })
})

describe('rankedClipboardAssetTypes', () => {
  it('优先尝试 SVG 原始文本，再回退到 PNG 等图片格式', () => {
    expect(rankedClipboardAssetTypes(['image/png', 'text/html', 'text/plain', 'image/jpeg'])).toEqual([
      'text/plain',
      'text/html',
      'image/png',
      'image/jpeg'
    ])
  })

  it('忽略没有机会承载 SVG 的普通剪贴板类型', () => {
    expect(rankedClipboardAssetTypes(['application/json', 'text/rtf'])).toEqual([])
  })
})

describe('importPaths 边界', () => {
  it('没有项目 / 没有路径时给可读提示', async () => {
    expect(await importPaths(deps(clipboardWith(null)), null, ['/tmp/a.png'])).toMatchObject({
      ok: false
    })
    expect(await importPaths(deps(clipboardWith(null)), 'p1', [])).toMatchObject({
      ok: false,
      message: '没有可导入的文件'
    })
    expect(await importPaths(deps(clipboardWith(null)), 'p1', [123, null])).toMatchObject({
      ok: false
    })
  })
})

describe('sanitizeWebDropRequest', () => {
  it('正常请求原样通过，落点也保留', () => {
    const request = sanitizeWebDropRequest({
      payload: { textHtml: '<img src="https://a.com/x.png">', textUriList: null, textPlain: null },
      pageUrl: 'https://a.com/',
      position: { x: 12, y: 34 }
    })
    expect(request).toEqual({
      payload: { textHtml: '<img src="https://a.com/x.png">', textUriList: null, textPlain: null },
      pageUrl: 'https://a.com/',
      position: { x: 12, y: 34 }
    })
  })

  it('三种文本一个都没有 → null（别把空请求送进下载）', () => {
    expect(sanitizeWebDropRequest({ payload: {}, pageUrl: null, position: null })).toBeNull()
    expect(sanitizeWebDropRequest({ payload: { textHtml: '' }, pageUrl: null })).toBeNull()
  })

  it('形状不对 → null', () => {
    expect(sanitizeWebDropRequest(null)).toBeNull()
    expect(sanitizeWebDropRequest('x')).toBeNull()
    expect(sanitizeWebDropRequest({ payload: 'x' })).toBeNull()
  })

  it('落点不是有限数就当没给，不写出 NaN 坐标', () => {
    const request = sanitizeWebDropRequest({
      payload: { textPlain: 'https://a.com/x.png' },
      position: { x: Number.NaN, y: 3 }
    })
    expect(request?.position).toBeNull()
  })
})

describe('importWeb 边界', () => {
  const webDeps = (fetchImpl: FetchLike) => ({
    db,
    assetsDir,
    measure: noMeasure,
    logger: silent,
    fetchImpl
  })

  it('没有项目时给可读提示，不去发请求', async () => {
    let called = false
    const result = await importWeb(
      webDeps(async () => {
        called = true
        return new Response(PNG)
      }),
      null,
      { payload: { textPlain: 'https://a.com/x.png' } }
    )
    expect(result).toMatchObject({ ok: false })
    expect(called).toBe(false)
  })

  it('拖进来的东西里没有可用地址时，一个请求都不发，回一句人话', async () => {
    let called = false
    const result = await importWeb(
      webDeps(async () => {
        called = true
        return new Response(PNG)
      }),
      'p1',
      { payload: { textPlain: '没有地址的一段话' } }
    )
    expect(called).toBe(false)
    expect(result).toMatchObject({ ok: true, importedCount: 0 })
    expect(result.ok && result.errors[0]?.message).toBe(NO_USABLE_ADDRESS)
  })

  it('拖进来的是网页地址（不是图）时，不生成坏卡片', async () => {
    const html = new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    const result = await importWeb(webDeps(async () => html), 'p1', {
      payload: { textUriList: 'https://huaban.com/pins/123' }
    })
    expect(result).toMatchObject({ ok: true, importedCount: 0 })
    expect(result.ok && result.errors[0]?.message).toContain('不是图片')
  })

  it('走通了：下载成功 → 落库 → 画布读回来带上这个节点', async () => {
    const result = await importWeb(
      webDeps(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } })),
      'p1',
      {
        payload: { textPlain: 'https://cdn.example.com/pic.png' },
        pageUrl: 'https://example.com/page',
        position: { x: 40, y: 60 }
      }
    )

    expect(result).toMatchObject({ ok: true, importedCount: 1 })
    const graph = loadGraph(db, 'p1')
    const node = Object.values(graph.nodes)[0]!
    expect({ x: node.x, y: node.y }).toEqual({ x: 40, y: 60 })
    expect(node.type).toBe('asset')
  })
})
