import { create } from 'zustand'
import { emptyBrowserState, type BrowserState } from '../../../shared/browser'
import type { BrowserCommand } from '../../../shared/ipc'
import { browserBridge } from '../bridge'

/**
 * 浏览器标签的界面状态（路线图 D3.1–D3.4）。
 *
 * 事实来源在主进程（那里是真正的网页视图）；界面这一份是它的投影，
 * 每次操作拿回新的状态、主进程之后再推变更过来。界面只画 chrome。
 */

interface BrowserStore {
  state: BrowserState
  load: () => Promise<void>
  /** 主进程推来的状态变化 */
  apply: (state: BrowserState) => void
  newTab: (url?: string) => Promise<void>
  closeTab: (id: string) => Promise<void>
  activateTab: (id: string) => Promise<void>
  moveTab: (id: string, to: number) => Promise<void>
  navigate: (id: string, url: string) => Promise<void>
  command: (id: string, command: BrowserCommand) => Promise<void>
}

export const useBrowserStore = create<BrowserStore>((set) => {
  /** 所有操作都是"调桥 → 拿回最新状态"，主进程推的变更走 apply。 */
  const run = async (action: (api: NonNullable<ReturnType<typeof browserBridge>>) => Promise<BrowserState>): Promise<void> => {
    const api = browserBridge()
    if (!api) return
    const state = await action(api)
    set({ state })
  }

  return {
    state: emptyBrowserState(),
    async load() {
      await run((api) => api.getState())
    },
    apply(state) {
      set({ state })
    },
    async newTab(url) {
      await run((api) => api.newTab(url))
    },
    async closeTab(id) {
      await run((api) => api.closeTab(id))
    },
    async activateTab(id) {
      await run((api) => api.activateTab(id))
    },
    async moveTab(id, to) {
      await run((api) => api.moveTab(id, to))
    },
    async navigate(id, url) {
      await run((api) => api.navigate(id, url))
    },
    async command(id, command) {
      await run((api) => api.command(id, command))
    }
  }
})
