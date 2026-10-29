import { create } from 'zustand'
import type {
  CreateProjectResult,
  DeleteProjectResult,
  ProjectSummary,
  RenameProjectResult
} from '../../../shared/ipc'
import { BRIDGE_STALE_MESSAGE, projectsBridge } from '../bridge'

/**
 * 界面侧的项目状态（路线图 D1.3）。
 *
 * 这里**只持有界面要用的东西**（列表 + 当前是哪一个）。项目数据的事实来源始终是
 * 主进程的数据库；界面这一份是它的投影。切换项目只改内存、不动数据库（画布视图
 * 位置的持久化属于 D2.12，退出恢复属于 D1.9）。
 */

export type ProjectLoadStatus = 'loading' | 'ready' | 'error'

interface ProjectState {
  projects: ProjectSummary[]
  currentId: string | null
  status: ProjectLoadStatus
  /** 列表读取失败时的说明；界面要能显示"为什么没有项目" */
  error: string | null
  load: () => Promise<void>
  create: (name: string) => Promise<CreateProjectResult>
  rename: (id: string, name: string) => Promise<RenameProjectResult>
  remove: (id: string) => Promise<DeleteProjectResult>
  select: (id: string) => void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentId: null,
  status: 'loading',
  error: null,

  async load() {
    const api = projectsBridge()
    if (!api) {
      set({ status: 'error', error: BRIDGE_STALE_MESSAGE })
      return
    }
    set({ status: 'loading', error: null })
    try {
      const projects = await api.list()
      const current = get().currentId
      // 当前项目被删掉（或还没选过）时，默认落到最近改动的那个
      const keepCurrent = current !== null && projects.some((p) => p.id === current)
      set({
        projects,
        status: 'ready',
        error: null,
        currentId: keepCurrent ? current : (projects[0]?.id ?? null)
      })
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  },

  async create(name) {
    const api = projectsBridge()
    if (!api) return { ok: false, message: BRIDGE_STALE_MESSAGE }

    const result = await api.create(name)
    if (result.ok) {
      const project = result.project
      // 新建的总是最近改动的，排到最前；并立即切过去，用户新建完就能用
      set((state) => ({
        projects: [project, ...state.projects.filter((p) => p.id !== project.id)],
        currentId: project.id
      }))
      api.notifySwitched({ id: project.id, name: project.name })
    }
    return result
  },

  async rename(id, name) {
    const api = projectsBridge()
    if (!api) return { ok: false, message: BRIDGE_STALE_MESSAGE }
    const result = await api.rename(id, name)
    if (result.ok) {
      const project = result.project
      set((state) => ({
        projects: state.projects.map((item) => (item.id === project.id ? project : item))
      }))
      if (get().currentId === project.id) api.notifySwitched({ id: project.id, name: project.name })
    }
    return result
  },

  async remove(id) {
    const api = projectsBridge()
    if (!api) return { ok: false, message: BRIDGE_STALE_MESSAGE }
    const result = await api.delete(id)
    if (result.ok) {
      set((state) => {
        const remaining = state.projects.filter((project) => project.id !== id)
        const projects = result.replacement ? [result.replacement] : remaining
        const nextCurrent =
          state.currentId === id ? (result.replacement?.id ?? remaining[0]?.id ?? null) : state.currentId
        return { projects, currentId: nextCurrent }
      })
      const next = get().projects.find((project) => project.id === get().currentId)
      if (next) api.notifySwitched({ id: next.id, name: next.name })
    }
    return result
  },

  select(id) {
    const project = get().projects.find((p) => p.id === id)
    if (!project) return
    set({ currentId: project.id })
    projectsBridge()?.notifySwitched({ id: project.id, name: project.name })
  }
}))

/** 当前项目的完整信息；没有项目时为 null。 */
export function useCurrentProject(): ProjectSummary | null {
  return useProjectStore((state) => state.projects.find((p) => p.id === state.currentId) ?? null)
}
