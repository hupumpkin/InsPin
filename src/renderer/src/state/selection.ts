import { create } from 'zustand'

/**
 * 画布上的选中集（路线图 D2.4 / D2.5）。
 *
 * 只存 id，节点数据始终从对象模型里查——避免"选中了一份副本"这种不同步。
 * 切项目 / 删节点后要清掉，否则会留下指向不存在节点的选中。
 */
interface SelectionState {
  ids: string[]
  /**
   * 图层面板里鼠标悬停的那一行（D4a.2）。悬停面板时画布对应对象要高亮，
   * 所以这份状态放在 store 里让画布也能读到。
   */
  hoverId: string | null
  /**
   * 批量收下结果后暂存的待选中集。
   *
   * 收图时用户还在浏览器里，不能立刻把画布选中改掉；等指针回到画布
   * （CanvasStage 的 pointerenter）再一次性选中这批新图。
   */
  pendingIds: string[]
  /** 整体替换选中 */
  set: (ids: string[]) => void
  /** 加选/减选（按住 ⇧ 点选） */
  toggle: (id: string) => void
  clear: () => void
  setHover: (id: string | null) => void
  setPending: (ids: string[]) => void
  /** 取出待选中集并清空（指针回到画布时调用） */
  takePending: () => string[]
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ids: [],
  hoverId: null,
  pendingIds: [],
  set: (ids) => set({ ids }),
  toggle: (id) =>
    set((state) => ({
      ids: state.ids.includes(id) ? state.ids.filter((x) => x !== id) : [...state.ids, id]
    })),
  clear: () => set({ ids: [] }),
  setHover: (id) => set({ hoverId: id }),
  setPending: (ids) => set({ pendingIds: ids }),
  takePending: () => {
    const pending = get().pendingIds
    if (pending.length > 0) set({ ids: pending, pendingIds: [] })
    return pending
  }
}))
