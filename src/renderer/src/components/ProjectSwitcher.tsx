import { useRef, useState, type FormEvent } from 'react'
import { Plus } from 'reicon-react'
import type { ProjectSummary } from '../../../shared/ipc'
import { useProjectStore } from '../state/projects'

/** 项目切换面板：双击改名，右键删除；列表保持轻量，不再重复写“项目”标题。 */
interface ProjectSwitcherProps {
  onClose: () => void
}

export default function ProjectSwitcher({ onClose }: ProjectSwitcherProps): React.JSX.Element {
  const projects = useProjectStore((state) => state.projects)
  const currentId = useProjectStore((state) => state.currentId)
  const select = useProjectStore((state) => state.select)
  const create = useProjectStore((state) => state.create)
  const rename = useProjectStore((state) => state.rename)
  const remove = useProjectStore((state) => state.remove)

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menuProject, setMenuProject] = useState<ProjectSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 单击切换与双击改名共用同一行。稍后再执行单击，才能不让第一次 click
  // 把面板先收起、吞掉紧接着的 double click。
  const selectTimer = useRef<number | null>(null)
  const renameCancelled = useRef(false)

  const clearSelectTimer = (): void => {
    if (selectTimer.current === null) return
    window.clearTimeout(selectTimer.current)
    selectTimer.current = null
  }

  const selectAfterDoubleClickWindow = (project: ProjectSummary): void => {
    clearSelectTimer()
    selectTimer.current = window.setTimeout(() => {
      select(project.id)
      onClose()
      selectTimer.current = null
    }, 180)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const result = await create(draft)
    if (result.ok) {
      setCreating(false)
      setDraft('')
      setError(null)
    } else {
      setError(result.message)
    }
  }

  const startRename = (project: ProjectSummary): void => {
    clearSelectTimer()
    renameCancelled.current = false
    setCreating(false)
    setMenuProject(null)
    setEditingId(project.id)
    setDraft(project.name)
    setError(null)
  }

  const commitRename = async (project: ProjectSummary): Promise<void> => {
    if (editingId !== project.id) return
    const result = await rename(project.id, draft)
    if (result.ok) {
      setEditingId(null)
      setDraft('')
      setError(null)
    } else {
      setError(result.message)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const result = await remove(deleteTarget.id)
    if (result.ok) {
      setDeleteTarget(null)
      setMenuProject(null)
      setError(null)
      onClose()
    } else {
      setError(result.message)
    }
  }

  return (
    <>
      <div className="switcher" role="dialog" aria-label="项目切换">
        <ul className="switcher__list">
          {projects.map((project) => {
            const isCurrent = project.id === currentId
            const isEditing = project.id === editingId
            return (
              <li className="switcher__entry" key={project.id}>
                {isEditing ? (
                  <form
                    className="switcher__rename-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void commitRename(project)
                    }}
                  >
                    <input
                      className="switcher__input"
                      value={draft}
                      aria-label={`重命名 ${project.name}`}
                      autoFocus
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => {
                        if (renameCancelled.current) {
                          renameCancelled.current = false
                          return
                        }
                        void commitRename(project)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        event.preventDefault()
                        renameCancelled.current = true
                        setEditingId(null)
                        setDraft('')
                        setError(null)
                      }}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="switcher__item"
                    aria-current={isCurrent || undefined}
                    onClick={() => selectAfterDoubleClickWindow(project)}
                    onDoubleClick={() => startRename(project)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setMenuProject(project)
                      setError(null)
                    }}
                  >
                    <span className="switcher__name">{project.name}</span>
                  </button>
                )}
                {menuProject?.id === project.id && (
                  <button
                    type="button"
                    className="switcher__context-action"
                    onClick={() => {
                      setMenuProject(null)
                      setDeleteTarget(project)
                    }}
                  >
                    删除项目
                  </button>
                )}
              </li>
            )
          })}
        </ul>

        {creating ? (
          <form className="switcher__form" onSubmit={submit}>
            <input
              className="switcher__input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="项目名"
              aria-label="新项目名"
              autoFocus
            />
            <button type="submit" className="switcher__confirm">
              创建
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="switcher__item switcher__new"
            onClick={() => {
              setEditingId(null)
              setCreating(true)
              setDraft('')
              setError(null)
            }}
          >
            <Plus size={16} weight="Outline" />
            <span className="switcher__name">新建项目</span>
          </button>
        )}

        {error && <p className="switcher__error">{error}</p>}
      </div>

      {deleteTarget && (
        <div className="project-confirm-backdrop" role="presentation">
          <section className="project-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title">
            <h2 id="delete-project-title">删除项目？</h2>
            <p>“{deleteTarget.name}”中的画布内容将一起删除，且无法恢复。</p>
            <div className="project-confirm__actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="project-confirm__delete" onClick={() => void confirmDelete()}>删除</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
