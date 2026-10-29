import { describe, expect, it } from 'vitest'
import { createAddNodeCommand } from './command'
import { HistoryStack } from './history'
import { createAssetNode, type ProjectGraph } from './node'

function emptyGraph(): ProjectGraph {
  return { projectId: 'p1', rootIds: [], nodes: {} }
}

const addN = (id: string) =>
  createAddNodeCommand(
    createAssetNode({
      id,
      projectId: 'p1',
      name: id,
      assetId: `a-${id}`,
      naturalWidth: 10,
      naturalHeight: 10
    })
  )

describe('HistoryStack', () => {
  it('undoEntry / redoEntry 返回被撤销/重做的命令', () => {
    const history = new HistoryStack(emptyGraph())
    const add = addN('n1')
    history.execute(add)
    expect(history.undoEntry()).toBe(add)
    expect(history.graph.rootIds).toEqual([])
    expect(history.redoEntry()).toBe(add)
    expect(history.graph.rootIds).toEqual(['n1'])
  })

  it('不改变画布的命令也能占一步，撤销顺序与操作一致', () => {
    const history = new HistoryStack(emptyGraph())
    const noop = {
      name: 'noop',
      apply: (graph: ProjectGraph) => graph,
      revert: (graph: ProjectGraph) => graph
    }
    history.execute(addN('n1'))
    history.execute(noop)
    expect(history.undoEntry()).toBe(noop)
    expect(history.graph.rootIds).toEqual(['n1'])
    expect(history.undoEntry()?.name).toBe('add-node:asset')
    expect(history.graph.rootIds).toEqual([])
  })

  it('初始状态：不能撤销也不能重做', () => {
    const history = new HistoryStack(emptyGraph())
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.graph.rootIds).toEqual([])
  })

  it('execute 之后可以撤销，但不能重做', () => {
    const history = new HistoryStack(emptyGraph())
    history.execute(addN('n1'))
    expect(history.graph.rootIds).toEqual(['n1'])
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
  })

  it('undo 回到上一步，redo 再前进', () => {
    const history = new HistoryStack(emptyGraph())
    history.execute(addN('n1'))
    history.execute(addN('n2'))

    history.undo()
    expect(history.graph.rootIds).toEqual(['n1'])
    expect(history.canRedo).toBe(true)

    history.redo()
    expect(history.graph.rootIds).toEqual(['n1', 'n2'])
    expect(history.canRedo).toBe(false)
  })

  it('连续 undo 按倒序回退，undo 到底后再 undo 无变化', () => {
    const history = new HistoryStack(emptyGraph())
    history.execute(addN('n1'))
    history.execute(addN('n2'))

    history.undo()
    history.undo()
    expect(history.graph.rootIds).toEqual([])
    expect(history.canUndo).toBe(false)

    history.undo()
    expect(history.graph.rootIds).toEqual([])
  })

  it('redo 到底后再 redo 无变化', () => {
    const history = new HistoryStack(emptyGraph())
    history.execute(addN('n1'))
    history.undo()
    history.redo()
    history.redo()
    expect(history.graph.rootIds).toEqual(['n1'])
  })

  it('撤销后执行新命令会清空重做栈', () => {
    const history = new HistoryStack(emptyGraph())
    history.execute(addN('n1'))
    history.execute(addN('n2'))
    history.undo()
    expect(history.canRedo).toBe(true)

    history.execute(addN('n3'))
    expect(history.canRedo).toBe(false)
    expect(history.graph.rootIds).toEqual(['n1', 'n3'])
  })

  it('全撤销再全重做，图与最初一致', () => {
    const history = new HistoryStack(emptyGraph())
    history.execute(addN('n1'))
    history.execute(addN('n2'))
    history.execute(addN('n3'))
    const peak = structuredClone(history.graph)

    history.undo()
    history.undo()
    history.undo()
    expect(history.graph).toEqual(emptyGraph())

    history.redo()
    history.redo()
    history.redo()
    expect(history.graph).toEqual(peak)
  })

  it('undo 返回的是新图对象，不复用旧引用', () => {
    const history = new HistoryStack(emptyGraph())
    const before = history.graph
    history.execute(addN('n1'))
    const after = history.graph
    expect(after).not.toBe(before)
  })
})
