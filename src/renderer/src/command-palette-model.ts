import type { ProjectSummary } from '../../shared/ipc'
import { DEFAULT_PANEL_PREFS, type PanelDock } from '../../shared/panel'

/**
 * ⌘K 命令面板的纯逻辑（路线图 D1.3）。
 *
 * 只做「根据项目列表拼出命令 / 按输入过滤 / 键盘上下移动选哪一条」，
 * 不碰 DOM、不碰 React——所以能直接单测。渲染与按键绑定在 CommandPalette.tsx。
 */

export type PaletteCommandKind = 'new-project' | 'switch-project' | 'import' | 'dock-panel'

export interface PaletteCommand {
  id: string
  kind: PaletteCommandKind
  label: string
  /** 右侧灰字说明 */
  hint?: string
  /** 参与搜索的额外关键词（如"切换"），让用户不必记住按钮叫什么 */
  keywords: string
  /** 关联的项目（仅切换命令有） */
  projectId?: string
  /** 要切到哪种停靠（仅 dock-panel 有） */
  dock?: PanelDock
  disabled?: boolean
}

/** 面板停靠位置的中文名与展示顺序（D3.6）。 */
export const DOCK_COMMANDS: { dock: PanelDock; label: string }[] = [
  { dock: 'left', label: '停靠到左边' }
]

/** 本版的动作：新建项目 / 切换项目 / 从本地导入图片 / 面板停靠位置。 */
export function buildCommands(
  projects: ProjectSummary[],
  currentId: string | null,
  currentDock: PanelDock = DEFAULT_PANEL_PREFS.dock
): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    {
      id: 'new-project',
      kind: 'new-project',
      label: '新建项目',
      hint: '空白项目',
      keywords: 'new create 项目 新建'
    }
  ]

  for (const project of projects) {
    const isCurrent = project.id === currentId
    commands.push({
      id: `switch:${project.id}`,
      kind: 'switch-project',
      label: project.name,
      hint: isCurrent ? '当前项目' : '切换项目',
      keywords: 'switch 切换 项目',
      projectId: project.id
    })
  }

  commands.push({
    id: 'import',
    kind: 'import',
    label: '导入文件…',
    hint: '从本地选图片',
    keywords: 'import 导入 文件 图片 本地'
  })

  // 浏览器只从左侧揭开，保证右侧始终是实际可拖放、可换色的画布。
  // 入口放这儿而不是加常驻按钮——不占界面，也不跟"更多"菜单抢空间。
  for (const { dock, label } of DOCK_COMMANDS) {
    commands.push({
      id: `dock:${dock}`,
      kind: 'dock-panel',
      label: `浏览器面板：${label}`,
      hint: dock === currentDock ? '当前' : '切换停靠',
      keywords: `dock 停靠 面板 浏览器 位置 ${label}`,
      dock
    })
  }

  return commands
}

/** 大小写不敏感的包含匹配；空输入返回全部。 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return commands
  return commands.filter((command) =>
    `${command.label} ${command.keywords}`.toLowerCase().includes(needle)
  )
}

/** 第一条可执行的命令；没有则 -1。 */
export function firstEnabledIndex(commands: PaletteCommand[]): number {
  return commands.findIndex((command) => !command.disabled)
}

/**
 * 从 `from` 出发按 delta（±1）移动，跳过禁用项并首尾循环。
 * `from` 为 -1（还没选）时，往前取最后一条、往后取第一条。
 */
export function moveSelection(
  commands: PaletteCommand[],
  from: number,
  delta: 1 | -1
): number {
  const count = commands.length
  if (count === 0) return -1

  let index = from < 0 ? (delta > 0 ? -1 : 0) : from
  for (let step = 0; step < count; step++) {
    index = (index + delta + count) % count
    if (!commands[index]?.disabled) return index
  }
  return -1
}
