import { describe, expect, it } from 'vitest'
import { createAddNodeCommand } from './command'
import { createAssetNode, createFrameNode, type ProjectGraph } from './node'

function emptyGraph(): ProjectGraph {
  return { projectId: 'p1', rootIds: [], nodes: {} }
}

const asset = (id: string, parentId: string | null = null) =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    parentId,
    assetId: `a-${id}`,
    naturalWidth: 10,
    naturalHeight: 10
  })

describe('createAddNodeCommand', () => {
  it('顶层节点：进入 nodes 与 rootIds', () => {
    const graph = createAddNodeCommand(asset('n1')).apply(emptyGraph())
    expect(Object.keys(graph.nodes)).toEqual(['n1'])
    expect(graph.rootIds).toEqual(['n1'])
  })

  it('子节点：挂进父节点的 childIds', () => {
    const parent = createFrameNode({ id: 'p', projectId: 'p1', name: 'p' })
    let graph = createAddNodeCommand(parent).apply(emptyGraph())
    graph = createAddNodeCommand(asset('c', 'p')).apply(graph)
    expect(graph.nodes['p']?.childIds).toEqual(['c'])
    expect(graph.rootIds).toEqual(['p'])
  })

  it('重复 apply 不会重复登记（重做安全）', () => {
    const command = createAddNodeCommand(asset('n1'))
    const once = command.apply(emptyGraph())
    const twice = command.apply(once)
    expect(twice.rootIds).toEqual(['n1'])
  })

  it('revert 把节点与引用一起撤掉', () => {
    const parent = createFrameNode({ id: 'p', projectId: 'p1', name: 'p' })
    const addParent = createAddNodeCommand(parent)
    const addChild = createAddNodeCommand(asset('c', 'p'))

    const withBoth = addChild.apply(addParent.apply(emptyGraph()))
    const afterUndo = addChild.revert(withBoth)

    expect(afterUndo.nodes['c']).toBeUndefined()
    expect(afterUndo.nodes['p']?.childIds).toEqual([])
  })

  it('revert 顶层节点会同步移出 rootIds', () => {
    const command = createAddNodeCommand(asset('n1'))
    const applied = command.apply(emptyGraph())
    const reverted = command.revert(applied)
    expect(reverted.nodes).toEqual({})
    expect(reverted.rootIds).toEqual([])
  })

  it('apply → revert 回到原状', () => {
    const before = emptyGraph()
    const command = createAddNodeCommand(asset('n1'))
    expect(command.revert(command.apply(before))).toEqual(before)
  })

  it('父节点不存在时不动图（不造悬挂节点）', () => {
    const before = emptyGraph()
    expect(createAddNodeCommand(asset('c', 'missing')).apply(before)).toBe(before)
  })

  it('revert 一个没加过的图是空操作', () => {
    const before = emptyGraph()
    expect(createAddNodeCommand(asset('n1')).revert(before)).toBe(before)
  })

  it('不修改入参', () => {
    const before = emptyGraph()
    const snapshot = JSON.stringify(before)
    createAddNodeCommand(asset('n1')).apply(before)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
