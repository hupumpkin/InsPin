import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import {
  buildCommands,
  filterCommands,
  firstEnabledIndex,
  moveSelection,
  type PaletteCommand
} from '../command-palette-model'
import { useGraphStore } from '../state/graph'
import { useProjectStore } from '../state/projects'
import { useUiStore } from '../state/ui'

/** ⌘K 命令面板（路线图 D1.3）：切换项目 / 新建项目 / （占位）导入文件。 */
interface CommandPaletteProps {
  onClose: () => void
}

export default function CommandPalette({ onClose }: CommandPaletteProps): React.JSX.Element {
  const projects = useProjectStore((state) => state.projects)
  const currentId = useProjectStore((state) => state.currentId)
  const select = useProjectStore((state) => state.select)
  const create = useProjectStore((state) => state.create)
  const importViaPicker = useGraphStore((state) => state.importViaPicker)
  const panelDock = useUiStore((state) => state.panel.dock)
  const setPanelDock = useUiStore((state) => state.setPanelDock)

  const [mode, setMode] = useState<'command' | 'new'>('command')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const commands = useMemo(
    () => buildCommands(projects, currentId, panelDock),
    [projects, currentId, panelDock]
  )
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query])

  // 过滤结果一变就把高亮拉回第一条可执行的命令，避免高亮停在已被过滤掉的项上
  useEffect(() => {
    setActive(firstEnabledIndex(filtered))
  }, [filtered])

  const activeIndex =
    active >= 0 && active < filtered.length ? active : firstEnabledIndex(filtered)

  function runCommand(command: PaletteCommand | undefined): void {
    if (!command || command.disabled) return
    if (command.kind === 'new-project') {
      setMode('new')
      setQuery('')
      setError(null)
      return
    }
    if (command.kind === 'switch-project' && command.projectId) {
      select(command.projectId)
      onClose()
    }
    if (command.kind === 'import') {
      void (async () => {
        const result = await importViaPicker(currentId)
        if (result.ok) onClose()
        // 导入结果统一在画布工具条上方用 Toast 反馈；取消选择则留在这里继续操作。
        else if (!result.canceled) onClose()
      })()
    }
    if (command.kind === 'dock-panel' && command.dock) {
      setPanelDock(command.dock)
      onClose()
    }
  }

  async function submitNew(): Promise<void> {
    const result = await create(query)
    if (result.ok) onClose()
    else setError(result.message)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      // 别让事件冒到 window 的全局 Esc（那会直接关掉整个面板，而不是退回命令列表）
      event.stopPropagation()
      if (mode === 'new') {
        setMode('command')
        setQuery('')
        setError(null)
      } else {
        onClose()
      }
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (mode === 'new') void submitNew()
      else runCommand(filtered[activeIndex])
      return
    }

    if (mode === 'command' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setActive(moveSelection(filtered, activeIndex, event.key === 'ArrowDown' ? 1 : -1))
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          className="palette__input"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onKeyDown}
          placeholder={mode === 'new' ? '输入项目名，回车创建' : '输入命令或项目名…'}
          aria-label="命令或项目名"
        />

        {mode === 'new' ? (
          <p className="palette__hint">
            {query.trim() ? `回车创建「${query.trim()}」` : '输入项目名后回车创建'} · Esc 返回
          </p>
        ) : (
          <ul className="palette__list">
            {filtered.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  className="palette__item"
                  aria-selected={index === activeIndex}
                  disabled={command.disabled}
                  onMouseMove={() => setActive(index)}
                  onClick={() => runCommand(command)}
                >
                  <span className="palette__label">{command.label}</span>
                  {command.hint && <span className="palette__side">{command.hint}</span>}
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="palette__empty">没有匹配的命令</li>}
          </ul>
        )}

        {error && <p className="palette__error">{error}</p>}
      </div>
    </div>
  )
}
