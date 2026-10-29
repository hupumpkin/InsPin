import { AngleDown } from 'reicon-react'
import { useProjectStore, useCurrentProject } from '../state/projects'

/**
 * 画布顶部的项目名浮层（路线图 D1.3）。
 *
 * 设计稿没有应用栏（规范 §8 把"项目新建 / 切换"列为未覆盖），所以这里按既有
 * 语言做了一块**浮层**：居中的白色胶囊、r12、与角落按钮同高，画布仍然铺满。
 * 点它就展开项目切换面板。
 */
interface ProjectChipProps {
  open: boolean
  onToggle: () => void
}

export default function ProjectChip({ open, onToggle }: ProjectChipProps): React.JSX.Element {
  const current = useCurrentProject()
  const status = useProjectStore((state) => state.status)

  const label =
    current?.name ??
    (status === 'error' ? '项目加载失败' : status === 'loading' ? '载入中…' : '新建项目')

  return (
    <button
      type="button"
      className="project-chip"
      onClick={onToggle}
      title="切换项目（⌘K 也可）"
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <span className="project-chip__label">{label}</span>
      <AngleDown className="project-chip__chevron" size={14} />
    </button>
  )
}
