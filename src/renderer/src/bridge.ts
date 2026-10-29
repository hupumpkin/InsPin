/**
 * 预加载桥的可用性检查。
 *
 * **为什么需要这个**：界面在开发时会热更新，但 `preload` 只在窗口创建那一刻加载一次。
 * 代码里给桥加了新接口后，老窗口里的界面会拿到**过期的桥**——表现就是
 * `window.insPin.canvas` 不存在，任何用到它的地方都会当场报错。
 *
 * 这里做两件事：
 *   1. 认出"桥过期"，调用方能给用户一句人话，而不是抛一个未捕获异常；
 *   2. 首次发现过期时自动刷新界面一次（刷新会重新加载 preload，从而自愈）。
 *      只刷一次，防止桥真的缺接口时无限循环。
 */

type InsPinBridge = NonNullable<Window['insPin']>

const RELOAD_FLAG = 'ins-pin-bridge-reloaded'

/**
 * **必须缓存**：`contextBridge` 暴露出来的对象是代理，**每次取属性都可能返回一个新的
 * 代理对象**。如果每次渲染都调 `window.insPin.canvas`，拿到的引用每次都不一样，
 * 于是任何把它放进依赖数组的 effect 都会**每次渲染都重跑**（画布会不停地整棵重铺）。
 */
let projectsCache: InsPinBridge['projects'] | null | undefined
let canvasCache: InsPinBridge['canvas'] | null | undefined
let browserCache: InsPinBridge['browser'] | null | undefined
let settingsCache: InsPinBridge['settings'] | null | undefined
let localLibraryCache: InsPinBridge['localLibrary'] | null | undefined

export function projectsBridge(): InsPinBridge['projects'] | null {
  if (projectsCache !== undefined) return projectsCache
  const api = window.insPin
  // 项目列表新增了改名/删除能力。旧 preload 缺任一项时，宁可让界面提示重启，
  // 也不要在用户点到右键菜单后才抛出 “not a function”。
  projectsCache =
    api &&
    typeof api.projects?.list === 'function' &&
    typeof api.projects?.create === 'function' &&
    typeof api.projects?.rename === 'function' &&
    typeof api.projects?.delete === 'function'
      ? api.projects
      : null
  return projectsCache
}

export function canvasBridge(): InsPinBridge['canvas'] | null {
  if (canvasCache !== undefined) return canvasCache
  const api = window.insPin
  canvasCache = api && typeof api.canvas?.importPaths === 'function' ? api.canvas : null
  return canvasCache
}

export function localLibraryBridge(): InsPinBridge['localLibrary'] | null {
  if (localLibraryCache !== undefined) return localLibraryCache
  const api = window.insPin
  localLibraryCache =
    api &&
    typeof api.localLibrary?.getState === 'function' &&
    typeof api.localLibrary?.placeItems === 'function'
      ? api.localLibrary
      : null
  return localLibraryCache
}

export function browserBridge(): InsPinBridge['browser'] | null {
  if (browserCache) return browserCache
  const api = window.insPin
  // 核心浏览器能力缺失时才判定桥不可用。智能采集的新增回调是可选增强，
  // 不能因为预加载层尚未刷新就让标签、关闭和侧边栏一起失效。
  const browser =
    api &&
    typeof api.browser?.getState === 'function' &&
    typeof api.browser?.setPanel === 'function' &&
    typeof api.browser?.hidePanelImmediately === 'function'
      ? api.browser
      : null
  // 不缓存空值：开发热更新或预加载层重载后，可以在下一次交互自动恢复。
  if (browser) browserCache = browser
  return browser
}

/** 设置入口与设置读写。缺了它不影响别的功能，所以单独判断。 */
export function settingsBridge(): InsPinBridge['settings'] | null {
  if (settingsCache !== undefined) return settingsCache
  const api = window.insPin
  settingsCache =
    api &&
    typeof api.settings?.onOpen === 'function' &&
    typeof api.settings?.get === 'function' &&
    typeof api.settings?.update === 'function' &&
    typeof api.settings?.reset === 'function'
      ? api.settings
      : null
  return settingsCache
}

/** 以图搜图。缺了它只是这一个功能不可用，不刷新界面。 */
export function imageSearchBridge(): InsPinBridge['imageSearch'] | null {
  const api = window.insPin
  if (!api || typeof api.imageSearch?.start !== 'function') return null
  return api.imageSearch
}

/** 画布桥是否可用；不可用时（且本次会话没刷过）自动刷新一次界面。 */
export function ensureCanvasBridge(): boolean {
  if (canvasBridge()) {
    // 恢复正常就把"已刷新"标记清掉，这样同一个窗口以后再遇到同样问题还能自愈
    try {
      sessionStorage.removeItem(RELOAD_FLAG)
    } catch {
      // 拿不到 sessionStorage 不影响正常使用
    }
    return true
  }
  try {
    if (!sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, '1')
      location.reload()
    }
  } catch {
    // 隐私模式等拿不到 sessionStorage 时忽略，直接走"显示提示"的分支
  }
  return false
}

/** 给用户看的提示：桥过期时让他重启，而不是看到一片空白或一句英文报错。 */
export const BRIDGE_STALE_MESSAGE = '素材功能没能加载上，请按 ⌘Q 退出 InsPin 后重新打开'
