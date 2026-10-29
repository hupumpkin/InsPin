import { useEffect, useRef, useState } from 'react'
import canvasChevron from '../assets/icons/relay-canvas-chevron.svg'
import { useCurrentProject, useProjectStore } from '../state/projects'

/** 画布名称属于右下角视图控制；项目数据仍是一张张独立保存的画布。 */
export default function CanvasNameMenu(): React.JSX.Element {
  const current = useCurrentProject()
  const projects = useProjectStore((state) => state.projects)
  const create = useProjectStore((state) => state.create)
  const remove = useProjectStore((state) => state.remove)
  const select = useProjectStore((state) => state.select)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onEscape)
    }
  }, [])

  const createCanvas = async (): Promise<void> => {
    const usedNames = new Set(projects.map((project) => project.name))
    let index = 1
    while (usedNames.has(`画布${index}`)) index += 1
    await create(`画布${index}`)
    setOpen(false)
  }

  const deleteCanvas = async (): Promise<void> => {
    if (!current) return
    await remove(current.id)
    setOpen(false)
  }

  return (
    <div className="canvas-name" ref={rootRef}>
      <button
        type="button"
        className="canvas-name__trigger"
        aria-label={`画布：${current?.name ?? '画布1'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((visible) => !visible)}
      >
        <span>{current?.name ?? '画布1'}</span>
        <img src={canvasChevron} alt="" aria-hidden="true" />
      </button>

      {open && (
        <div className="canvas-name__menu" role="menu" aria-label="画布菜单">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={project.id === current?.id}
              onClick={() => {
                select(project.id)
                setOpen(false)
              }}
            >
              {project.name}
            </button>
          ))}
          <span className="canvas-name__divider" aria-hidden="true" />
          <button type="button" role="menuitem" onClick={() => void createCanvas()}>新建画布</button>
          <button type="button" role="menuitem" onClick={() => void deleteCanvas()} disabled={!current}>删除画布</button>
        </div>
      )}
    </div>
  )
}
