import { describe, expect, it } from 'vitest'
import { createAssetNode, createGroupNode, type Node, type ProjectGraph } from '../../../shared/node'
import { buildScene } from '../../../shared/scene'
import { previewPositionFromWorld } from './preview-position'

function graphOf(nodes: Node[], rootIds: string[]): ProjectGraph {
  return { projectId: 'p1', rootIds, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) }
}

describe('previewPositionFromWorld', () => {
  it('uses a tightened group’s visible origin, so a child starts its drag without jumping', () => {
    // 模型中组从 (20, 30) 起；其唯一孩子又有 (100, 40) 的偏移。
    // 但组的视觉边框会收紧到孩子，于是 Pixi 中孩子的局部位置实际是 (0, 0)。
    const group = createGroupNode({ id: 'group', projectId: 'p1', name: '组', x: 20, y: 30, w: 400, h: 300 })
    const image = createAssetNode({
      id: 'image',
      projectId: 'p1',
      name: '图片',
      x: 100,
      y: 40,
      w: 80,
      h: 60,
      parentId: 'group',
      assetId: 'asset-image',
      naturalWidth: 80,
      naturalHeight: 60
    })
    group.childIds = ['image']
    const graph = graphOf([group, image], ['group'])
    const scene = buildScene(graph)

    // 图片世界坐标为 (120, 70)；没有移动时，预览位置必须仍是视觉父级内的 (0, 0)。
    expect(previewPositionFromWorld(scene, 'image', { x: 120, y: 70 })).toEqual({ x: 0, y: 0 })
  })
})
