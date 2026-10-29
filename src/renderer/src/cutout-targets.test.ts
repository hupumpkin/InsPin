import { describe, expect, it } from 'vitest'
import type { AssetInfo } from '../../shared/ipc'
import { createAssetNode, type ProjectGraph } from '../../shared/node'
import { buildScene } from '../../shared/scene'
import { canRunCutout, collectCutoutTargets } from './cutout-targets'

function assetInfo(id: string, mime = 'image/png', missing = false): AssetInfo {
  return {
    id,
    fileName: `${id.padEnd(16, '0')}.png`,
    mime,
    width: 200,
    height: 100,
    bytes: 1,
    importMethod: 'file',
    createdAt: '2026-10-20T00:00:00.000Z',
    sourceUrl: null,
    pageUrl: null,
    ...(missing ? { missing: true } : {})
  }
}

function graphWithTwoImages(): ProjectGraph {
  const a = createAssetNode({
    id: 'a', projectId: 'p', name: 'A', x: 100, y: 50, w: 200, h: 100,
    assetId: 'asset-a', naturalWidth: 200, naturalHeight: 100
  })
  const b = createAssetNode({
    id: 'b', projectId: 'p', name: 'B', x: 400, y: 50, w: 200, h: 100,
    assetId: 'asset-b', naturalWidth: 200, naturalHeight: 100
  })
  return { projectId: 'p', rootIds: ['a', 'b'], nodes: { a, b } }
}

describe('collectCutoutTargets', () => {
  it('单选兼容位图时，在原图右侧 24px 生成落点', () => {
    const graph = graphWithTwoImages()
    const targets = collectCutoutTargets(graph, { 'asset-a': assetInfo('asset-a') }, ['a'], buildScene(graph))

    expect(targets).toEqual([{ nodeId: 'a', assetId: 'asset-a', name: 'A', at: { x: 324, y: 50 } }])
    expect(canRunCutout(targets, true)).toBe(true)
  })

  it('多选（包括 PNG + SVG 混选）一律不露出入口', () => {
    const graph = graphWithTwoImages()
    const targets = collectCutoutTargets(
      graph,
      { 'asset-a': assetInfo('asset-a'), 'asset-b': assetInfo('asset-b', 'image/svg+xml') },
      ['a', 'b'],
      buildScene(graph)
    )
    expect(targets).toEqual([])
    expect(canRunCutout(targets, true)).toBe(false)
  })

  it('SVG、丢失素材或系统不可用时不提供抠图', () => {
    const graph = graphWithTwoImages()
    expect(collectCutoutTargets(graph, { 'asset-a': assetInfo('asset-a', 'image/svg+xml') }, ['a'], buildScene(graph))).toEqual([])
    const targets = collectCutoutTargets(graph, { 'asset-a': assetInfo('asset-a', 'image/png', true) }, ['a'], buildScene(graph))
    expect(targets).toEqual([])
    expect(canRunCutout(targets, false)).toBe(false)
  })
})
