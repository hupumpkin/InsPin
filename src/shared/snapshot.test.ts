import { describe, expect, it } from 'vitest'
import type { AssetInfo } from './ipc'
import { createAssetNode, createGroupNode, type ProjectGraph } from './node'
import { buildScene } from './scene'
import {
  clampOpacity,
  clampZoom,
  collectSnapshotContent,
  fitZoomFor,
  reviveSnapshotRecord,
  snapshotLayerGeometry,
  snapshotWindowSize,
  type SnapshotLayer
} from './snapshot'

function assetInfo(id: string, fileName = `${id}.png`): AssetInfo {
  return {
    id,
    fileName,
    mime: 'image/png',
    width: 100,
    height: 80,
    bytes: 1000,
    importMethod: 'file',
    createdAt: '2026-10-15T00:00:00.000Z',
    sourceUrl: null,
    pageUrl: null
  }
}

/** 两张图：一张摆在 (100,50)，一张在组里（组在 (10,10)，子图偏移 (5,5)）。 */
function graphWithGroup(): ProjectGraph {
  const a = createAssetNode({
    id: 'a',
    projectId: 'p',
    name: 'A',
    x: 100,
    y: 50,
    w: 200,
    h: 120,
    assetId: 'asset-a',
    naturalWidth: 200,
    naturalHeight: 120
  })
  const g = createGroupNode({ id: 'g', projectId: 'p', name: '组', x: 10, y: 10, w: 60, h: 60 })
  const b = createAssetNode({
    id: 'b',
    projectId: 'p',
    name: 'B',
    parentId: 'g',
    x: 5,
    y: 5,
    w: 50,
    h: 50,
    assetId: 'asset-b',
    naturalWidth: 50,
    naturalHeight: 50
  })
  g.childIds = ['b']
  return {
    projectId: 'p',
    rootIds: ['a', 'g'],
    nodes: { a, g, b }
  }
}

const always = () => assetInfo('asset-a')
const infoFor = (id: string): AssetInfo | null =>
  id === 'asset-a' || id === 'asset-b' ? assetInfo(id) : null
const nothingMissing = (): boolean => false

describe('collectSnapshotContent', () => {
  it('单张图片：只有一个盒子，坐标归零', () => {
    const items = buildScene(graphWithGroup())
    const content = collectSnapshotContent(items, ['a'], infoFor, nothingMissing)
    expect(content).not.toBeNull()
    expect(content!.layers).toHaveLength(1)
    expect(content!.layers[0]).toMatchObject({ nodeId: 'a', kind: 'asset', x: 0, y: 0, w: 200, h: 120 })
    expect(content!.width).toBe(200)
    expect(content!.height).toBe(120)
    expect(content!.assets['asset-a']).toBeDefined()
  })

  it('选一个组：组和子图都进来，坐标相对组左上角', () => {
    const items = buildScene(graphWithGroup())
    const content = collectSnapshotContent(items, ['g'], infoFor, nothingMissing)
    expect(content).not.toBeNull()
    const ids = content!.layers.map((layer) => layer.nodeId)
    expect(ids).toEqual(['g', 'b'])
    // 组的盒子 = 内容的并集 (15,15) 起、50×50（不是模型里声明的 60×60）→ 归一后 (0,0)
    expect(content!.layers[0]).toMatchObject({ nodeId: 'g', x: 0, y: 0, w: 50, h: 50 })
    // 子图绝对 (15,15) 正是组的左上角 → (0,0)
    expect(content!.layers[1]).toMatchObject({ nodeId: 'b', x: 0, y: 0, w: 50, h: 50 })
    expect(content!.width).toBe(50)
    expect(content!.height).toBe(50)
  })

  it('多选：两张图合并成一个包围盒，各自按最小左上角平移', () => {
    const items = buildScene(graphWithGroup())
    const content = collectSnapshotContent(items, ['a', 'g'], infoFor, nothingMissing)
    expect(content).not.toBeNull()
    // a 在 (100,50)，组的盒子是 (15,15) 起的 50×50 → 整体左上角 (15,15)
    const a = content!.layers.find((layer) => layer.nodeId === 'a')
    expect(a).toMatchObject({ x: 85, y: 35 })
    expect(content!.width).toBe(285) // 100+200 - 15
  })

  it('素材文件不在时记进 missing，但仍然出现在 assets 里（信息还在）', () => {
    const items = buildScene(graphWithGroup())
    const content = collectSnapshotContent(items, ['a'], infoFor, (id) => id === 'asset-a')
    expect(content!.missing).toEqual(['asset-a'])
    expect(content!.assets['asset-a']).toBeDefined()
  })

  it('隐藏的节点不进快照', () => {
    const graph = graphWithGroup()
    graph.nodes['a']!.visible = false
    const items = buildScene(graph)
    expect(collectSnapshotContent(items, ['a'], infoFor, nothingMissing)).toBeNull()
  })

  it('空选择返回 null', () => {
    const items = buildScene(graphWithGroup())
    expect(collectSnapshotContent(items, [], infoFor, nothingMissing)).toBeNull()
    expect(collectSnapshotContent(items, ['不存在'], infoFor, nothingMissing)).toBeNull()
  })

  it('裁切信息一起冻结（否则钉出来是整张图）', () => {
    const graph = graphWithGroup()
    const node = graph.nodes['a']!
    if (node.type !== 'asset') throw new Error('测试数据应是图片节点')
    node.props.crop = { x: 0.25, y: 0.5, w: 0.5, h: 0.5 }

    const items = buildScene(graph)
    const content = collectSnapshotContent(items, ['a'], infoFor, nothingMissing)
    expect(content!.layers[0]!.crop).toEqual({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 })
  })
})

describe('snapshotLayerGeometry', () => {
  const layer: SnapshotLayer = {
    nodeId: 'a',
    kind: 'asset',
    name: 'A',
    x: 10,
    y: 20,
    w: 200,
    h: 120,
    rotation: 0
  }

  it('整张图：图片盒子和可视框一致', () => {
    const geometry = snapshotLayerGeometry(layer, 2)
    expect(geometry.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(geometry.outer).toEqual({ left: 20, top: 40, width: 400, height: 240 })
    expect(geometry.image).toEqual({ left: 0, top: 0, width: 400, height: 240 })
  })

  it('裁切后图片放大并偏移，超出部分由外层裁掉', () => {
    const geometry = snapshotLayerGeometry(
      { ...layer, crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 } },
      2
    )
    expect(geometry.outer).toEqual({ left: 20, top: 40, width: 400, height: 240 })
    expect(geometry.image).toEqual({ left: -200, top: -240, width: 800, height: 480 })
  })

  it('旧快照没有裁切字段 / 坏数据按整张图处理', () => {
    expect(snapshotLayerGeometry(layer, 1).crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const broken = {
      ...layer,
      crop: { x: 'x', y: 0, w: 1, h: 1 }
    } as unknown as SnapshotLayer
    expect(snapshotLayerGeometry(broken, 1).crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})

describe('缩放与透明度', () => {
  it('都夹在合法区间里', () => {
    expect(clampOpacity(0)).toBe(0.2)
    expect(clampOpacity(5)).toBe(1)
    expect(clampOpacity(Number.NaN)).toBe(1)
    expect(clampZoom(0)).toBe(0.25)
    expect(clampZoom(99)).toBe(4)
  })

  it('窗口尺寸 = 内容 × 缩放，最小 1px', () => {
    expect(snapshotWindowSize({ width: 200, height: 100 }, 2)).toEqual({ width: 400, height: 200 })
    expect(snapshotWindowSize({ width: 0, height: 0 }, 1)).toEqual({ width: 1, height: 1 })
  })

  it('内容过大时缩到最长边的上限（小图保持原样）', () => {
    expect(fitZoomFor({ width: 100, height: 100 })).toBe(1)
    expect(fitZoomFor({ width: 480, height: 480 })).toBe(1)
    // 1800 × 900 → 缩到最长边 480，也就是 480/1800
    expect(fitZoomFor({ width: 1800, height: 900 })).toBeCloseTo(480 / 1800, 5)
  })
})

describe('reviveSnapshotRecord', () => {
  const content = { layers: [], assets: {}, missing: [], width: 10, height: 10 }

  it('形状不对就返回 null', () => {
    expect(reviveSnapshotRecord(null)).toBeNull()
    expect(reviveSnapshotRecord({ id: 'x' })).toBeNull()
    expect(reviveSnapshotRecord({ id: 'x', content: {} })).toBeNull()
  })

  it('读回来时补齐缺省值并夹住越界的数', () => {
    const record = reviveSnapshotRecord({
      id: 's1',
      projectId: 'p',
      sourceIds: ['a', 3],
      content,
      x: 5,
      y: Number.NaN,
      opacity: 9,
      zoom: 0,
      locked: true
    })
    expect(record).toMatchObject({
      id: 's1',
      sourceIds: ['a'],
      x: 5,
      y: 0,
      opacity: 1,
      zoom: 0.25,
      locked: true
    })
  })
})
