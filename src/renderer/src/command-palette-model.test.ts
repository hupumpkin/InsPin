import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from '../../shared/ipc'
import {
  buildCommands,
  filterCommands,
  firstEnabledIndex,
  moveSelection,
  type PaletteCommand
} from './command-palette-model'

function project(id: string, name: string): ProjectSummary {
  return { id, name, createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z' }
}

describe('buildCommands', () => {
  it('新建在最前，导入可用', () => {
    const commands = buildCommands([project('p1', '项目一')], 'p1')

    expect(commands[0]).toMatchObject({ kind: 'new-project' })
    const importCommand = commands.find((command) => command.kind === 'import')
    expect(importCommand?.disabled).toBeFalsy()
  })

  it('浏览器只提供左侧揭开，右侧始终留给画布', () => {
    const commands = buildCommands([], null, 'left')
    const docks = commands.filter((command) => command.kind === 'dock-panel')

    expect(docks.map((command) => command.dock)).toEqual(['left'])
    expect(docks[0]?.hint).toBe('当前')
  })

  it('每个项目一条切换命令，当前项目标注出来', () => {
    const commands = buildCommands([project('p1', '项目一'), project('p2', '项目二')], 'p2')
    const switches = commands.filter((command) => command.kind === 'switch-project')

    expect(switches.map((command) => command.projectId)).toEqual(['p1', 'p2'])
    expect(switches.find((command) => command.projectId === 'p2')?.hint).toBe('当前项目')
    expect(switches.find((command) => command.projectId === 'p1')?.hint).toBe('切换项目')
  })

  it('没有项目时只剩新建、导入与左侧浏览器入口', () => {
    expect(buildCommands([], null).map((command) => command.kind)).toEqual([
      'new-project',
      'import',
      'dock-panel'
    ])
  })
})

describe('filterCommands', () => {
  const commands = buildCommands([project('p1', '灵感收集'), project('p2', '竞品分析')], 'p1')

  it('空输入返回全部', () => {
    expect(filterCommands(commands, '   ')).toHaveLength(commands.length)
  })

  it('按项目名匹配', () => {
    expect(filterCommands(commands, '竞品').map((command) => command.label)).toEqual(['竞品分析'])
  })

  it('按关键词匹配，不必记住按钮怎么写', () => {
    expect(filterCommands(commands, '新建').map((command) => command.kind)).toContain('new-project')
    expect(filterCommands(commands, '切换')).toHaveLength(2)
  })

  it('大小写不敏感', () => {
    expect(filterCommands(commands, 'IMPORT').map((command) => command.kind)).toEqual(['import'])
  })

  it('无匹配返回空', () => {
    expect(filterCommands(commands, '不存在的词')).toEqual([])
  })
})

describe('firstEnabledIndex', () => {
  it('第一条可执行命令', () => {
    const commands: PaletteCommand[] = [
      { id: 'a', kind: 'import', label: 'a', keywords: '', disabled: true },
      { id: 'b', kind: 'new-project', label: 'b', keywords: '' }
    ]
    expect(firstEnabledIndex(commands)).toBe(1)
  })

  it('全禁用时返回 -1', () => {
    const commands: PaletteCommand[] = [
      { id: 'a', kind: 'import', label: 'a', keywords: '', disabled: true }
    ]
    expect(firstEnabledIndex(commands)).toBe(-1)
  })
})

describe('moveSelection', () => {
  const commands: PaletteCommand[] = [
    { id: 'a', kind: 'new-project', label: 'a', keywords: '' },
    { id: 'b', kind: 'import', label: 'b', keywords: '', disabled: true },
    { id: 'c', kind: 'switch-project', label: 'c', keywords: '' }
  ]

  it('向下移动会跳过禁用项', () => {
    expect(moveSelection(commands, 0, 1)).toBe(2)
  })

  it('到底后回到开头（首尾循环）', () => {
    expect(moveSelection(commands, 2, 1)).toBe(0)
  })

  it('向上移动同样跳过禁用项', () => {
    expect(moveSelection(commands, 2, -1)).toBe(0)
  })

  it('还没选中时向下取第一条、向上取最后一条', () => {
    expect(moveSelection(commands, -1, 1)).toBe(0)
    expect(moveSelection(commands, -1, -1)).toBe(2)
  })

  it('全禁用或空列表返回 -1', () => {
    expect(
      moveSelection([{ id: 'a', kind: 'import', label: 'a', keywords: '', disabled: true }], 0, 1)
    ).toBe(-1)
    expect(moveSelection([], 0, 1)).toBe(-1)
  })
})
