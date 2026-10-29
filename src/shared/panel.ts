/**
 * 浏览器面板的几何（路线图 D3.5 分栏 / D3.6 停靠 / D3.7 最小窗口降级）。
 *
 * 面板有多宽、停在哪一侧、窗口太窄时怎么退让——全在这一个纯函数里算完。
 * 主进程拿它定**原生网页视图**的尺寸，界面拿同一份结果定**chrome 的宽度与
 * 工具栏位移**；两边共用一份，就不会"网页在左边、白框在右边"这种对不上。
 */

export type PanelDock = 'left' | 'right' | 'float'

export interface PanelPrefs {
  /** 面板停在哪：左停靠 / 右停靠 / 浮动（盖在画布上，即设计稿那种） */
  dock: PanelDock
  /** 期望的面板宽度占窗口宽的比例（拖分栏线得到） */
  ratio: number
  /** 用户想不想让面板开着（窗口太窄时会被降级收起，但这份意愿保留） */
  open: boolean
}

/** 界面往主进程发的一小步改动：只带你真的要改的那一项。 */
export interface PanelPatch {
  open?: boolean
  dock?: PanelDock
  ratio?: number
}

export interface PanelLayout {
  dock: PanelDock
  /** **实际**是否展开：窗口太窄会被降级收起，与 `requested` 无关 */
  open: boolean
  /** 用户的意愿（界面据此判断"窗口变宽后要不要自动回来"） */
  requested: boolean
  /** 面板实际占位宽度 px；收起时是 0（原生视图要藏起来） */
  width: number
  /** 展开时面板的宽度 px。**收起时仍保留**——滑出动画要用它算位移 */
  openWidth: number
  /** 当前窗口内容区宽度，界面拆幽灵框、算分栏线位置都要用 */
  windowWidth: number
}

/** 浏览器面板最窄 420：再窄地址栏就没法用了（路线图 D3.5 的约束） */
export const MIN_BROWSER_WIDTH = 420
/**
 * 面板最宽只能占窗口的 80%。
 *
 * 路线图 D3.5 原本写的是"画布 ≥640"，但那把面板卡得太死（1500 的窗口只能拖到 860）。
 * 2026-10-15 用户手测后改成按比例：最多占窗口 80%，剩下 20% 留给画布。
 */
export const MAX_PANEL_RATIO = 0.8
/** 内容区窄于它 → 面板不再按比例，直接收到 MIN_BROWSER_WIDTH（D3.7） */
export const DEGRADE_WIDTH = 1060
/** 再窄于它 → 面板自动收起，把整个窗口让给画布（D3.7） */
export const COLLAPSE_WIDTH = 900
/** 侧栏卡片与窗口、画布之间的留白；渲染层与主进程都必须取这个值。 */
export const PANEL_CARD_GUTTER = 8

/** 设计稿 §7.3：浏览器面板宽 1003 / 1920 = 52.24% */
export const DEFAULT_PANEL_RATIO = 1003 / 1920

export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  // 侧栏从左边揭开，画布同步让位；浮层与右停靠仍可在设置中选。
  dock: 'left',
  ratio: DEFAULT_PANEL_RATIO,
  open: true
}

/** 把宽度夹进"浏览器 ≥420、最多占窗口 80%"这个区间。 */
export function clampPanelWidth(width: number, windowWidth: number): number {
  const upper = Math.max(MIN_BROWSER_WIDTH, Math.round(windowWidth * MAX_PANEL_RATIO))
  return Math.round(Math.max(MIN_BROWSER_WIDTH, Math.min(width, upper)))
}

/** 拖完分栏线：把目标宽度换算成要存的比例（顺手夹进合法区间）。 */
export function ratioForWidth(width: number, windowWidth: number): number {
  if (windowWidth <= 0) return DEFAULT_PANEL_RATIO
  return clampPanelWidth(width, windowWidth) / windowWidth
}

/**
 * 分栏线该落在窗口的哪个 x。
 *
 * **偏在画布那一侧**：网页是原生视图，永远盖在界面之上，压在它下面的热区点不到。
 * 所以左/浮动时线贴在面板右边，右停靠时贴在面板左边。
 */
export function panelEdgeX(
  layout: Pick<PanelLayout, 'dock' | 'open' | 'width'>,
  windowWidth: number
): number {
  if (!layout.open) return 0
  return layout.dock === 'right' ? windowWidth - layout.width : layout.width
}

export function resolvePanelLayout(input: {
  windowWidth: number
  prefs: PanelPrefs
}): PanelLayout {
  const { windowWidth, prefs } = input
  const desired =
    windowWidth < DEGRADE_WIDTH ? MIN_BROWSER_WIDTH : Math.round(windowWidth * prefs.ratio)
  const openWidth = clampPanelWidth(desired, windowWidth)
  const open = prefs.open && windowWidth >= COLLAPSE_WIDTH
  return {
    dock: prefs.dock,
    open,
    requested: prefs.open,
    width: open ? openWidth : 0,
    openWidth,
    windowWidth
  }
}

/**
 * 读回存过的面板偏好。**坏数据一律回到默认**——磁盘被手动改过、旧版本格式都不该让应用打不开。
 */
export function normalizePanelPrefs(raw: unknown): PanelPrefs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PANEL_PREFS }
  const data = raw as { dock?: unknown; ratio?: unknown; open?: unknown }
  // r11 的画布只保留“从左侧揭开”的结构。旧版曾把原生网页视图停靠在右侧或
  // 浮在画布上；那块原生层无法吃到画布的拖放与背景色，视觉上就像右侧漏算了一块。
  // 读取历史偏好时统一迁回左侧，避免升级后沿用这个错误状态。
  const dock: PanelDock = data.dock === 'left' ? 'left' : DEFAULT_PANEL_PREFS.dock
  const ratio =
    typeof data.ratio === 'number' && Number.isFinite(data.ratio) && data.ratio > 0.1 && data.ratio < 0.9
      ? data.ratio
      : DEFAULT_PANEL_PREFS.ratio
  const open = typeof data.open === 'boolean' ? data.open : DEFAULT_PANEL_PREFS.open
  return { dock, ratio, open }
}

/**
 * 把界面传来的补丁并进偏好。只认合法值，其余字段保持不动——
 * 界面永远只能"改一项"，不会因为漏传字段把别的设置清掉。
 */
export function applyPanelPatch(prefs: PanelPrefs, patch: unknown): PanelPrefs {
  if (typeof patch !== 'object' || patch === null) return prefs
  const data = patch as { dock?: unknown; ratio?: unknown; open?: unknown }
  const next: PanelPrefs = { ...prefs }
  if (data.dock === 'left' || data.dock === 'right' || data.dock === 'float') next.dock = data.dock
  if (typeof data.ratio === 'number' && Number.isFinite(data.ratio) && data.ratio > 0.1 && data.ratio < 0.9) {
    next.ratio = data.ratio
  }
  if (typeof data.open === 'boolean') next.open = data.open
  return next
}
