import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, type WebContentsView } from 'electron'
import type { PanelLayout } from '../shared/panel'
import type { SnapshotCreateResult, SnapshotPatch, SnapshotView } from '../shared/snapshot'
import { Logger, LogEvent } from './logger'

/**
 * 自动自检（路线图 D0.11）。跑一遍"启动 → 两个视图就位 → 起始页可用 → 拖放数据通路可用"，
 * 结果写到终端，任一项不过就以非 0 退出，方便一条命令判断这版能不能用。
 *
 * **能自动化的边界**：真正的"从左边网页拖到右边画布"是操作系统级拖拽，
 * 脚本模拟不出来。这里验证的是**接收端通路**（拖放数据在画布视图里能被拿到），
 * 原生跨栏拖拽仍然要人工测——与实验阶段结论一致。
 */

export interface SmokeCheck {
  name: string
  ok: boolean
  detail?: unknown
}

export interface SmokeContext {
  contentWidth: number
  contentHeight: number
  browserBounds: Electron.Rectangle
  canvasBounds: Electron.Rectangle
  /** 主进程算出的面板布局（D3.5–D3.7），自检据此核对原生视图的位置 */
  panel: PanelLayout
  /** 浏览器 chrome 两行的高度（D3.1） */
  chromeHeight: number
  /** 浏览器卡片与窗口边缘的留白（须与主进程布局常量一致） */
  panelGutter: number
  canvasView: WebContentsView
  browserView: WebContentsView
  startPageUrl: string
  logger: Logger
}

/**
 * 面板几何的自检（D3.5–D3.7）。
 *
 * 这部分**驱动**真界面：切一次停靠、再缩一次窗口，然后核对原生网页视图有没有
 * 老老实实跟到位。这几条最值得自动守着——出问题时用户只会看到"网页和面板错位"，
 * 靠肉眼很难说清是哪一步没跟上。
 */
export interface PanelSmokeContext {
  /** 改面板设置（与界面走的是同一条路） */
  update: (patch: { dock?: PanelLayout['dock']; open?: boolean }) => PanelLayout
  /** 当前原生网页视图的位置 */
  browserBounds: () => Electron.Rectangle | null
  /** 浏览器卡片与窗口边缘的留白 */
  panelGutter: number
  windowWidth: () => number
  /** 改窗口内容区大小（触发 D3.7 降级） */
  resizeWindow: (width: number, height: number) => void
  /** 等动画/重排落定 */
  settle: () => Promise<void>
  /** 自检开始时的窗口内容区尺寸，跑完要还原回去 */
  originalSize: { width: number; height: number }
  /** 画布视图：用于核对原生侧栏收起后 Pixi 是否同步扩展渲染尺寸。 */
  canvasView: WebContentsView
}

export async function runPanelSmokeChecks(ctx: PanelSmokeContext): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = []
  const add = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, detail })
  }

  const dockLeft = ctx.update({ dock: 'left', open: true })
  await ctx.settle()
  const leftBounds = ctx.browserBounds()
  add(
    'panel-reveal-left',
    Boolean(leftBounds && leftBounds.x === 0 && leftBounds.width === dockLeft.width),
    { bounds: leftBounds, width: dockLeft.width }
  )

  const dockRight = ctx.update({ dock: 'right' })
  await ctx.settle()
  const rightBounds = ctx.browserBounds()
  add(
    'panel-dock-right',
    Boolean(
      rightBounds &&
        rightBounds.x === ctx.windowWidth() - dockRight.width - ctx.panelGutter &&
        rightBounds.width === dockRight.width
    ),
    { bounds: rightBounds, width: dockRight.width }
  )

  // 右侧面板会带画布 gutter，但顶栏控件仍必须和全局浏览器入口共用基线；
  // 同时，智能采集入口的右缘要与“更多”入口对齐。
  const collectChromeAlignment = (await evaluate(
    ctx.canvasView,
    `(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null
      const button = rect('.corner--top-left')
      const tab = rect('.browser__tab[data-active="true"]')
      const collect = rect('.browser__collect')
      const more = rect('.browser__navbtn[aria-label="更多"]')
      if (!button || !tab || !collect || !more) return null
      return {
        tabTopDelta: Math.abs(button.top - tab.top),
        collectTopDelta: Math.abs(button.top - collect.top),
        collectRightDelta: Math.abs(collect.right - more.right)
      }
    })()`
  )) as {
    tabTopDelta: number
    collectTopDelta: number
    collectRightDelta: number
  } | null
  add(
    'smart-collect-chrome-alignment-right',
    Boolean(
      collectChromeAlignment &&
        collectChromeAlignment.tabTopDelta < 0.5 &&
        collectChromeAlignment.collectTopDelta < 0.5 &&
        collectChromeAlignment.collectRightDelta < 0.5
    ),
    collectChromeAlignment
  )

  const collapsed = ctx.update({ open: false })
  await ctx.settle()
  const collapsedBounds = ctx.browserBounds()
  // 右停靠收起：整个视图滑到窗口右边之外
  add(
    'panel-collapse',
    collapsed.open === false && Boolean(collapsedBounds && collapsedBounds.x >= ctx.windowWidth()),
    { layout: collapsed, bounds: collapsedBounds }
  )

  // 侧栏从“开”收回时 .canvas-area 会变宽。Pixi 的 backing store 也必须同步变宽，
  // 否则右半块虽然是画布 DOM，却只露出外层背景，图片和换色都会在旧边界被截断。
  const canvasAfterCollapse = (await evaluate(
    ctx.canvasView,
    `(() => {
      const host = document.querySelector('.stage__canvas')
      const canvas = host?.querySelector('canvas')
      if (!host || !canvas) return null
      const scale = window.devicePixelRatio || 1
      return {
        dpr: scale,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        hostWidth: Math.round(host.getBoundingClientRect().width),
        rendererWidth: Math.round(canvas.width / scale),
        hostHeight: Math.round(host.getBoundingClientRect().height),
        rendererHeight: Math.round(canvas.height / scale)
      }
    })()`
  )) as {
    dpr: number
    canvasWidth: number
    canvasHeight: number
    hostWidth: number
    rendererWidth: number
    hostHeight: number
    rendererHeight: number
  } | null
  add(
    'canvas-expands-after-panel-collapse',
    Boolean(
      canvasAfterCollapse &&
        canvasAfterCollapse.rendererWidth === canvasAfterCollapse.hostWidth &&
        canvasAfterCollapse.rendererHeight === canvasAfterCollapse.hostHeight
    ),
    canvasAfterCollapse
  )

  ctx.update({ dock: 'float', open: true })
  await ctx.settle()

  // D3.7：窄于 1060 → 面板收到 420
  ctx.resizeWindow(1000, 800)
  await ctx.settle()
  const degraded = ctx.update({ open: true })
  await ctx.settle()
  add('panel-degrade-narrow', degraded.open === true && degraded.width === 420, degraded)

  // 再窄于 900 → 自动收起（意愿还在，窗口拉回来会自己展开）
  ctx.resizeWindow(820, 800)
  await ctx.settle()
  const autoCollapsed = ctx.update({ open: true })
  await ctx.settle()
  add(
    'panel-auto-collapse',
    autoCollapsed.open === false && autoCollapsed.requested === true,
    autoCollapsed
  )

  // 复原成默认，别把窗口留在小尺寸上
  ctx.resizeWindow(ctx.originalSize.width, ctx.originalSize.height)
  ctx.update({ dock: 'float', open: true })
  await ctx.settle()

  return checks
}

export interface CaptureSmokeContext {
  canvasView: WebContentsView
  browserView: WebContentsView
  /** 主进程里是否还有一次采集会话没结束。 */
  captureActive: () => boolean
  /** 等面板滑动与界面状态落定。 */
  settle: () => Promise<void>
}

/**
 * 采集生命周期的自检。
 *
 * 非冻结采集把"压暗、高亮、点击拦截"注入到当前网页里；一旦切走标签、收起面板
 * 或刷新网页，这些注入会留在旧页面/旧文档，用户在新页面上只会得到"点了没反应"。
 * 这三条退出路径都必须把采集会话收干净，界面上的采集态也要跟着清掉。
 */
export async function runCaptureSmokeChecks(ctx: CaptureSmokeContext): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = []
  const add = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, detail })
  }

  const bridge = async (script: string): Promise<unknown> =>
    evaluate(
      ctx.canvasView,
      `(async () => {
        const api = window.insPin
        if (!api) return { error: 'bridge-missing' }
        ${script}
      })()`
    )

  const waitForCapture = async (want: boolean, timeoutMs = 4000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (ctx.captureActive() === want) return true
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    return ctx.captureActive() === want
  }

  const collectLabel = async (): Promise<string | null> =>
    (await evaluate(
      ctx.canvasView,
      `document.querySelector('.browser__collect')?.getAttribute('aria-label') ?? null`
    )) as string | null

  const waitForLabel = async (label: string, timeoutMs = 4000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await collectLabel()) === label) return true
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    return (await collectLabel()) === label
  }

  /**
   * 走界面上的采集按钮，而不是绕过界面直接调 IPC——这样同时验证
   * 主进程会话和界面上的采集态。只有不冻结模式按钮才会变成「退出智能采集」。
   */
  const startCollect = async (): Promise<{ clicked: boolean; active: boolean; liveLabel: boolean }> => {
    const clicked =
      (await evaluate(
        ctx.canvasView,
        `(() => {
          const button = document.querySelector('.browser__collect[aria-label="智能采集"]')
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false
          button.click()
          return true
        })()`
      )) === true
    const active = clicked && (await waitForCapture(true))
    const liveLabel = active && (await waitForLabel('退出智能采集'))
    return { clicked, active, liveLabel }
  }

  const clickCollectMode = async (label: string): Promise<boolean> =>
    (await evaluate(
      ctx.canvasView,
      `(() => {
        const button = [...document.querySelectorAll('.collect-mode button')]
          .find((item) => item.textContent?.trim() === ${JSON.stringify(label)})
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false
        button.click()
        return true
      })()`
    )) === true

  const waitForSelector = async (
    selector: string,
    present: boolean,
    timeoutMs = 4000
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found =
        (await evaluate(
          ctx.canvasView,
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        )) === true
      if (found === present) return true
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    return false
  }

  /** 冻结态：覆盖层里的退出按钮必须和浏览器栏里的采集入口完全重合。 */
  const collectControlAlignment = async (): Promise<{
    entry: { left: number; top: number; right: number; bottom: number } | null
    exit: { left: number; top: number; right: number; bottom: number } | null
  } | null> =>
    (await evaluate(
      ctx.canvasView,
      `(() => {
        const rect = (element) => {
          if (!element) return null
          const value = element.getBoundingClientRect()
          return { left: value.left, top: value.top, right: value.right, bottom: value.bottom }
        }
        return {
          entry: rect(document.querySelector('.browser__collect[aria-label="智能采集"]')),
          exit: rect(document.querySelector('.capture__collect-group .corner'))
        }
      })()`
    )) as {
      entry: { left: number; top: number; right: number; bottom: number } | null
      exit: { left: number; top: number; right: number; bottom: number } | null
    } | null

  // 不冻结模式才会挂到具体网页上；SMOKE 下改设置只影响内存，不写回用户配置。
  // 采集检查从最常见的左停靠面板开始，网页与 chrome 在同一侧。
  await bridge(`await api.settings.update({ freezeSmartCollection: false }); return true`)
  await bridge(`await api.browser.setPanel({ dock: 'left', open: true }); return true`)
  await ctx.settle()

  // 1) 采集内切换到锁定屏幕：开关生效，退出按钮落在采集入口的原坐标上
  const startedForToggle = await startCollect()
  const clickedFrozen = await clickCollectMode('锁定屏幕')
  const frozenMounted = await waitForSelector('.capture__collect-group .corner', true)
  const alignment = await collectControlAlignment()
  const aligned = Boolean(
    alignment?.entry &&
      alignment.exit &&
      Math.abs(alignment.entry.left - alignment.exit.left) < 0.5 &&
      Math.abs(alignment.entry.top - alignment.exit.top) < 0.5 &&
      Math.abs(alignment.entry.right - alignment.exit.right) < 0.5 &&
      Math.abs(alignment.entry.bottom - alignment.exit.bottom) < 0.5
  )
  const frozenSelected =
    (await evaluate(
      ctx.canvasView,
      `document.querySelector('.collect-mode button[aria-pressed="true"]')?.textContent?.trim() ?? null`
    )) === '锁定屏幕'
  add(
    'capture-mode-switch-freezes',
    Boolean(
      startedForToggle.clicked &&
        startedForToggle.active &&
        startedForToggle.liveLabel &&
        clickedFrozen &&
        frozenMounted &&
        frozenSelected &&
        aligned
    ),
    { startedForToggle, clickedFrozen, frozenMounted, frozenSelected, alignment }
  )

  // 2) 切回滚动屏幕：覆盖层收起，采集继续
  const clickedLive = await clickCollectMode('滚动屏幕')
  const overlayGone = await waitForSelector('.capture__collect-group', false)
  const liveAgain = await waitForLabel('退出智能采集')
  add(
    'capture-mode-switch-unfreezes',
    Boolean(clickedLive && overlayGone && liveAgain && ctx.captureActive()),
    { clickedLive, overlayGone, liveAgain }
  )

  // 3) 收起浏览器面板 → 结束采集
  await bridge(`await api.browser.setPanel({ open: false }); return true`)
  await ctx.settle()
  const activeAfterClose = await waitForCapture(false)
  const labelAfterClose = await waitForLabel('智能采集')
  add(
    'capture-ends-when-panel-closes',
    Boolean(activeAfterClose && labelAfterClose),
    { activeAfterClose, labelAfterClose }
  )

  // 4) 切到另一个标签 → 结束采集
  await bridge(`await api.browser.setPanel({ open: true }); return true`)
  await ctx.settle()
  const startedByTab = await startCollect()
  const tabSwitch = (await bridge(
    `const before = await api.browser.getState()
     const next = await api.browser.newTab()
     const closed = await api.browser.closeTab(next.activeId)
     return { before: before.activeId, during: next.activeId, after: closed.activeId }`
  )) as { before?: string | null; during?: string | null; after?: string | null } | null
  const activeAfterTabSwitch = await waitForCapture(false)
  const labelAfterTabSwitch = await waitForLabel('智能采集')
  add(
    'capture-ends-when-tab-switches',
    Boolean(
      startedByTab.clicked &&
        startedByTab.active &&
        startedByTab.liveLabel &&
        tabSwitch?.before === tabSwitch?.after &&
        activeAfterTabSwitch &&
        labelAfterTabSwitch
    ),
    { startedByTab, tabSwitch, activeAfterTabSwitch, labelAfterTabSwitch }
  )
  await ctx.settle()

  // 5) 网页刷新 → 结束采集
  const startedByReload = await startCollect()
  const reloaded = await bridge(
    `const state = await api.browser.getState()
     if (!state.activeId) return false
     await api.browser.command(state.activeId, 'reload')
     return true`
  )
  const activeAfterReload = await waitForCapture(false)
  const labelAfterReload = await waitForLabel('智能采集')
  add(
    'capture-ends-when-page-reloads',
    Boolean(
      startedByReload.clicked &&
        startedByReload.active &&
        startedByReload.liveLabel &&
        reloaded === true &&
        activeAfterReload &&
        labelAfterReload
    ),
    { startedByReload, reloaded, activeAfterReload, labelAfterReload }
  )

  await waitForIdle(ctx.browserView)
  return checks
}

/**
 * 参考快照的自检（D5）。
 *
 * 这里最值得自动守着的是**"浮窗真的一直在最上层、而且全屏也盖得住"**——
 * 这正是用户手测时最容易说不清、又最容易回归的一条（换个 Electron 版本、
 * 改一行窗口参数就可能悄悄失效）。所以它是从原生窗口里**读回来**核对，
 * 而不是只看我们自己的记录。
 *
 * 素材缺失占位（D5.6）也在这里造出来：种下去的节点指向一条不存在的素材。
 */
export interface SnapshotSmokeContext {
  /** 在（内存）库里造一个项目 + 一张指向"不存在的素材"的图 */
  seed: () => { projectId: string; nodeId: string }
  create: (projectId: string, sourceIds: string[]) => SnapshotCreateResult
  view: (id: string) => SnapshotView | null
  update: (id: string, patch: SnapshotPatch) => SnapshotView | null
  /** 打开独立的钉住设置菜单。 */
  openMenu: (id: string) => void
  /** 把快照放到指定安全坐标，供缩放锚点自检使用。 */
  move: (id: string, x: number, y: number) => void
  close: (id: string) => void
  /** 从原生浮窗读回来的属性 */
  inspect: (id: string) => {
    visible: boolean
    alwaysOnTop: boolean
    onAllWorkspaces: boolean
    opacity: number
    position: { x: number; y: number }
    size: { width: number; height: number }
  } | null
  /** 从独立菜单窗口读回尺寸与位置，验证它不随图片缩放。 */
  inspectMenu: (id: string) => {
    visible: boolean
    position: { x: number; y: number }
    size: { width: number; height: number }
  } | null
  /** 用真实 range input 连续写入几档值，验证拖动不会被误写成 25%。 */
  dragMenuZoom: (id: string, values: number[]) => Promise<boolean>
  /** 歇一小会儿（浮窗的显示与关闭都是异步落定的） */
  settle: () => Promise<void>
}

export async function runSnapshotSmokeChecks(ctx: SnapshotSmokeContext): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = []
  const add = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, detail })
  }

  /** 等到浮窗真的露出来（ready-to-show 是异步的，直接读会读到还没显示） */
  const waitVisible = async (id: string): Promise<void> => {
    for (let i = 0; i < 80; i++) {
      if (ctx.inspect(id)?.visible) return
      await ctx.settle()
    }
  }

  const { projectId, nodeId } = ctx.seed()
  const created = ctx.create(projectId, [nodeId])
  if (!created.ok) {
    add('snapshot-create', false, created)
    return checks
  }

  await waitVisible(created.id)

  const view = ctx.view(created.id)
  add(
    'snapshot-create',
    Boolean(view && view.content.layers.length === 1 && view.content.width > 0),
    view ? { layers: view.content.layers.length, size: [view.content.width, view.content.height] } : null
  )

  // 缺失素材（种下去的节点指向没有记录的素材）要落到 missing 里，界面才好画占位
  add('snapshot-missing-asset', Boolean(view && view.content.missing.length === 1), view?.content.missing)

  const floating = ctx.inspect(created.id)
  add(
    'snapshot-window-floating',
    Boolean(
      floating && floating.visible && floating.alwaysOnTop && floating.onAllWorkspaces
    ),
    floating
  )

  // 锁定 / 缩放 / 透明度：改完记录与窗口都要跟上（缩放后的尺寸要真的变大）
  const before = ctx.inspect(created.id)
  ctx.update(created.id, { locked: true, zoom: 2, opacity: 0.5 })
  const after = ctx.inspect(created.id)
  const updated = ctx.view(created.id)
  add(
    'snapshot-controls',
    Boolean(
      updated &&
        updated.locked === true &&
        updated.opacity === 0.5 &&
        updated.zoom === 2 &&
        after &&
        before &&
        after.size.width === before.size.width * 2 &&
        Math.abs(after.opacity - 0.5) < 0.01
    ),
    { updated: updated && { locked: updated.locked, zoom: updated.zoom }, before, after }
  )

  // 连续拖缩放时，快照应围绕自己的视觉中心变化。先放到能容纳 300% 的安全区域，
  // 排除屏幕边界的合理贴边行为；否则窗口会在屏幕上“乱飘”。
  // 上一项刚好验证过锁定状态；锁定时窗口本就不能被用户拖动，因此这里先解锁。
  ctx.update(created.id, { locked: false })
  ctx.move(created.id, 600, 400)
  const zoomBefore = ctx.inspect(created.id)
  ctx.update(created.id, { zoom: 3 })
  const zoomAfter = ctx.inspect(created.id)
  const centerOf = (snapshot: NonNullable<typeof zoomBefore>) => ({
    x: snapshot.position.x + snapshot.size.width / 2,
    y: snapshot.position.y + snapshot.size.height / 2
  })
  const centerBefore = zoomBefore ? centerOf(zoomBefore) : null
  const centerAfter = zoomAfter ? centerOf(zoomAfter) : null
  add(
    'snapshot-zoom-keeps-center',
    Boolean(
      centerBefore &&
        centerAfter &&
        Math.abs(centerBefore.x - centerAfter.x) <= 1 &&
        Math.abs(centerBefore.y - centerAfter.y) <= 1
    ),
    { centerBefore, centerAfter, before: zoomBefore, after: zoomAfter }
  )

  // 右键菜单不能塞进会改变尺寸的钉住图，否则正在拖动的 range 会跟着窗口改坐标，
  // 指针瞬间落到最左端、缩放被错误夹到 25%。这里从真实的独立窗口读回它的边界。
  ctx.openMenu(created.id)
  let menuBefore = ctx.inspectMenu(created.id)
  for (let i = 0; i < 20 && !menuBefore?.visible; i++) {
    await ctx.settle()
    menuBefore = ctx.inspectMenu(created.id)
  }
  ctx.update(created.id, { zoom: 0.25 })
  const menuAfter = ctx.inspectMenu(created.id)
  add(
    'snapshot-menu-stays-fixed-while-zooming',
    Boolean(
      menuBefore &&
        menuAfter &&
        menuBefore.visible &&
        menuAfter.visible &&
        menuBefore.size.width === menuAfter.size.width &&
        menuBefore.size.height === menuAfter.size.height &&
        menuBefore.position.x === menuAfter.position.x &&
        menuBefore.position.y === menuAfter.position.y
    ),
    { menuBefore, menuAfter }
  )

  const sliderChanged = await ctx.dragMenuZoom(created.id, [80, 115, 165])
  for (let i = 0; i < 6; i++) await ctx.settle()
  const sliderZoom = ctx.view(created.id)?.zoom
  add(
    'snapshot-menu-slider-never-jumps-to-minimum',
    sliderChanged && typeof sliderZoom === 'number' && Math.abs(sliderZoom - 1.65) < 0.001,
    { sliderZoom }
  )

  ctx.close(created.id)
  // 窗口的 closed 事件是异步的，等它真的从表里消失
  for (let i = 0; i < 80 && ctx.view(created.id) !== null; i++) await ctx.settle()
  add('snapshot-close', ctx.view(created.id) === null, null)

  return checks
}

const DRAG_PROBE = `(() => {
  const dt = new DataTransfer()
  dt.setData('text/html', '<img src="https://probe.invalid/drag-probe.png">')
  dt.setData('text/uri-list', 'https://probe.invalid/drag-probe.png')
  const target = document.querySelector('.app') || document.body
  let seen = null
  const onDrop = (event) => {
    if (!seen) {
      seen = {
        html: event.dataTransfer ? event.dataTransfer.getData('text/html') : null,
        uri: event.dataTransfer ? event.dataTransfer.getData('text/uri-list') : null
      }
    }
  }
  document.addEventListener('drop', onDrop, true)
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  document.removeEventListener('drop', onDrop, true)
  return seen
})()`

/** 往画布真的派一次"从网页拖进来"的 drop，看应用接没接住（D3.8）。 */
const DROP_INTO_CANVAS = `(() => {
  const dt = new DataTransfer()
  dt.setData('text/html', '<img src="https://probe.invalid/drag-probe.png">')
  dt.setData('text/uri-list', 'https://probe.invalid/drag-probe.png')
  const stage = document.querySelector('.stage')
  if (!stage) return 'no-stage'
  const rect = stage.getBoundingClientRect()
  stage.dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
      clientX: rect.left + 240,
      clientY: rect.top + 200
    })
  )
  return 'sent'
})()`

/**
 * 文本工具的完整用户路径：点工具 → 点画布，必须立即进入原位编辑。
 *
 * **必须用主进程的真实鼠标输入**（`sendInputEvent`）：合成一个 `pointerdown`
 * 不会带浏览器默认的焦点处理，曾让这里“自动通过、手测没反应”。同时挂上
 * MutationObserver，区分“压根没建编辑框”和“建了又立刻被删掉”。
 */
const TEXT_TOOL_PREPARE = `(() => {
  const button = document.querySelector('[aria-label="文本"]')
  const stage = document.querySelector('.stage__canvas')
  if (!button || !stage) return { reason: !button ? 'no-text-button' : 'no-stage' }
  const log = { added: 0, removed: 0, focusout: [] }
  window.__insPinTextProbe = log
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.classList.contains('canvas-text-editor')) log.added++
      }
      for (const node of record.removedNodes) {
        if (node instanceof Element && node.classList.contains('canvas-text-editor')) log.removed++
      }
    }
  }).observe(document.querySelector('.stage'), { childList: true, subtree: true })
  document.addEventListener(
    'focusout',
    (event) => log.focusout.push(event.target?.className || event.target?.tagName || 'unknown'),
    true
  )
  const b = button.getBoundingClientRect()
  const s = stage.getBoundingClientRect()
  return {
    button: { x: b.left + b.width / 2, y: b.top + b.height / 2 },
    stage: { x: s.left + Math.max(220, s.width * 0.58), y: s.top + Math.max(180, s.height * 0.42) }
  }
})()`

const TEXT_TOOL_STATE = `(() => {
  const button = document.querySelector('[aria-label="文本"]')
  const editor = document.querySelector('.canvas-text-editor')
  const log = window.__insPinTextProbe
  return {
    toolPressed: button?.getAttribute('aria-pressed') ?? null,
    editor: Boolean(editor),
    focused: document.activeElement === editor,
    activeTag: document.activeElement?.tagName ?? null,
    selected: document.querySelector('.stage')?.getAttribute('data-selected') ?? null,
    projectReady: document.querySelector('.stage')?.getAttribute('data-project-ready') ?? null,
    graphReady: document.querySelector('.stage')?.getAttribute('data-graph-ready') ?? null,
    value: editor?.value ?? null,
    added: log?.added ?? 0,
    removed: log?.removed ?? 0,
    focusout: log?.focusout ?? []
  }
})()`

/** 文本工具回归探针里额外要“点一下别处提交、再双击回来”的位置。 */
const TEXT_TOOL_EXTRA_POINTS = `(() => {
  const stage = document.querySelector('.stage__canvas')
  if (!stage) return null
  const s = stage.getBoundingClientRect()
  return {
    blank: { x: s.left + Math.max(220, s.width * 0.72), y: s.top + Math.max(180, s.height * 0.68) }
  }
})()`

/** 真实鼠标点击（走 Chromium 的默认行为，包括焦点转移）。 */
async function realClick(
  view: WebContentsView,
  point: { x: number; y: number },
  clickCount = 1
): Promise<void> {
  const wc = view.webContents
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount })
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount })
  await new Promise((resolve) => setTimeout(resolve, 60))
}

/** 真实鼠标拖拽（分几步移动，pointermove 才能拿到中间位置）。 */
async function realDrag(
  view: WebContentsView,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8
): Promise<void> {
  const wc = view.webContents
  const start = { x: Math.round(from.x), y: Math.round(from.y) }
  const end = { x: Math.round(to.x), y: Math.round(to.y) }
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', x: start.x, y: start.y })
  wc.sendInputEvent({ type: 'mouseDown', x: start.x, y: start.y, button: 'left', clickCount: 1 })
  for (let step = 1; step <= steps; step++) {
    const x = Math.round(start.x + ((end.x - start.x) * step) / steps)
    const y = Math.round(start.y + ((end.y - start.y) * step) / steps)
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  wc.sendInputEvent({ type: 'mouseUp', x: end.x, y: end.y, button: 'left', clickCount: 1 })
  await new Promise((resolve) => setTimeout(resolve, 120))
}

/**
 * 模拟拖拽浏览器与画布之间的分栏线。
 *
 * 拖动期间 Pixi 若每一帧都重建 backing store，右侧画布会闪；这里记录每一帧的
 * drawing-buffer 宽度，并确认浏览器 chrome 在同一帧已采用指针对应的宽度。
 * 正确行为是拖动中画布 backing store 保持稳定，而浏览器边缘逐点跟手。
 */
const SPLITTER_DRAG_PROBE = `(async () => {
  const splitter = document.querySelector('.splitter')
  const host = document.querySelector('.stage__canvas')
  const canvas = host?.querySelector('canvas')
  const browser = document.querySelector('.browser')
  const canvasViewport = document.querySelector('.canvas-viewport')
  const area = document.querySelector('.canvas-area')
  if (!splitter || !host || !canvas || !browser || !canvasViewport || !area) return null
  const pointerId = 97
  const rect = splitter.getBoundingClientRect()
  const send = (type, clientX) => splitter.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX, clientY: rect.top + 16, button: 0 })
  )
  const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  send('pointerdown', rect.left + 1)
  await waitFrame()
  const widths = []
  const browserWidths = []
  const targetWidths = []
  const stageClipLefts = []
  const expectedClipLefts = []
  const stageClipRadii = []
  for (const shift of [36, 72, 108, 144, 180]) {
    send('pointermove', rect.left + shift)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    widths.push(canvas.width)
    browserWidths.push(Math.round(browser.getBoundingClientRect().width))
    targetWidths.push(Math.round(rect.left + shift))
    const clipPath = getComputedStyle(canvasViewport).clipPath
    const leftInset = Number(clipPath.replace('inset(', '').split(' ')[3]?.replace('px', ''))
    stageClipLefts.push(Math.round(leftInset))
    expectedClipLefts.push(Math.round(browser.getBoundingClientRect().right - area.getBoundingClientRect().left))
    stageClipRadii.push(clipPath.includes('round 16px'))
  }
  send('pointerup', rect.left + 180)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const scale = window.devicePixelRatio || 1
  return {
    widths,
    browserWidths,
    targetWidths,
    stageClipLefts,
    expectedClipLefts,
    stageClipRadii,
    distinctDuringDrag: new Set(widths).size,
    dpr: scale,
    canvasWidth: canvas.width,
    hostWidth: Math.round(host.getBoundingClientRect().width),
    rendererWidth: Math.round(canvas.width / scale)
  }
})()`

async function evaluate(view: WebContentsView, script: string): Promise<unknown> {
  try {
    return await view.webContents.executeJavaScript(script)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** 等视图加载完（或超时），避免在页面上还没东西时就断言。 */
export async function waitForIdle(view: WebContentsView, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (view.webContents.isLoading() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function runSmokeTest(ctx: SmokeContext): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = []
  const add = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, detail })
  }

  // 1) 布局：左侧是从画布下方揭开的浏览器（贴窗口左、无 gutter）；其余形态仍是
  //    chrome 以下的侧栏卡片。这里核对原生网页视图有没有落到对应几何上。
  const leftReveal = ctx.panel.dock === 'left'
  const expectedBrowserX =
    leftReveal
      ? 0
      : ctx.panel.dock === 'right'
      ? ctx.contentWidth - ctx.panel.width - ctx.panelGutter
      : ctx.panelGutter
  add(
    'layout-split',
    ctx.canvasBounds.x === 0 &&
      ctx.canvasBounds.y === 0 &&
      ctx.canvasBounds.width === ctx.contentWidth &&
      ctx.canvasBounds.height === ctx.contentHeight &&
      ctx.browserBounds.x === expectedBrowserX &&
      ctx.browserBounds.y === ctx.chromeHeight + (leftReveal ? 0 : ctx.panelGutter) &&
      ctx.browserBounds.width === ctx.panel.width &&
      ctx.browserBounds.height ===
        ctx.contentHeight -
          ctx.chromeHeight -
          (leftReveal ? 0 : 2 * ctx.panelGutter),
    {
      browser: ctx.browserBounds,
      canvas: ctx.canvasBounds,
      panel: ctx.panel,
      expectedBrowserX,
      chromeHeight: ctx.chromeHeight,
      panelGutter: ctx.panelGutter
    }
  )

  // 2) 画布视图：React 外壳已挂载
  add(
    'canvas-view-loaded',
    (await evaluate(ctx.canvasView, `Boolean(document.querySelector('.toolbar'))`)) === true
  )

  // 2b) PixiJS 画布真的挂上了（D2.1）
  // 这一条专门守着"静默空白"：CSP 拦掉 unsafe-eval 或 Worker 时，初始化会失败或挂住，
  // 界面上没有任何报错，只有一块空画布——必须由自检来发现。
  let pixiMounted = false
  for (let attempt = 0; attempt < 30 && !pixiMounted; attempt++) {
    pixiMounted =
      (await evaluate(
        ctx.canvasView,
        `Boolean(document.querySelector('.stage__canvas canvas'))`
      )) === true
    if (!pixiMounted) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  add('canvas-pixi-mounted', pixiMounted)

  // 2b-1) 静止画布必须停止重绘（D6b）。画布是常驻界面，按屏幕刷新率一直画是
  //       "合盖也发热"的直接来源：松手 1 秒后帧数不应再增长。
  const idleFrames = (await evaluate(
    ctx.canvasView,
    `(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      const before = window.__insPinCanvasFrames ?? null
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const after = window.__insPinCanvasFrames ?? null
      return { before, after }
    })()`
  )) as { before: number | null; after: number | null } | null
  add(
    'canvas-idle-stops-rendering',
    Boolean(idleFrames && idleFrames.before !== null && idleFrames.after === idleFrames.before),
    idleFrames
  )

  // 2b-2) 反过来：滚轮平移必须立刻出帧，不能为了省电把交互也冻住。
  const panFrames = (await evaluate(
    ctx.canvasView,
    `(async () => {
      const host = document.querySelector('.stage__canvas')
      if (!host) return null
      const before = window.__insPinCanvasFrames ?? 0
      const rect = host.getBoundingClientRect()
      host.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 120,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { before, after: window.__insPinCanvasFrames ?? 0 }
    })()`
  )) as { before: number; after: number } | null
  add(
    'canvas-renders-after-pan',
    Boolean(panFrames && panFrames.after > panFrames.before),
    panFrames
  )

  const textTargets = (await evaluate(ctx.canvasView, TEXT_TOOL_PREPARE)) as {
    button?: { x: number; y: number }
    stage?: { x: number; y: number }
    reason?: string
  } | null
  let textTool: Record<string, unknown> | null = textTargets?.reason
    ? { reason: textTargets.reason }
    : null
  let textCommit: Record<string, unknown> | null = null
  let textReopen: Record<string, unknown> | null = null
  if (textTargets?.button && textTargets.stage) {
    await realClick(ctx.canvasView, textTargets.button)
    await realClick(ctx.canvasView, textTargets.stage)
    await new Promise((resolve) => setTimeout(resolve, 250))
    textTool = (await evaluate(ctx.canvasView, TEXT_TOOL_STATE)) as Record<string, unknown> | null

    // 真实打字：走 Chromium 的输入管线，React 的受控 textarea 必须实时跟上。
    ctx.canvasView.webContents.insertText('Hello')
    await new Promise((resolve) => setTimeout(resolve, 120))
    const typed = (await evaluate(ctx.canvasView, TEXT_TOOL_STATE)) as Record<string, unknown> | null
    if (typed) textTool = { ...textTool, typedValue: typed.value }

    // 点空白处提交：编辑框收起、对象留下并选中。
    const extra = (await evaluate(ctx.canvasView, TEXT_TOOL_EXTRA_POINTS)) as {
      blank: { x: number; y: number }
    } | null
    if (extra) {
      await realClick(ctx.canvasView, extra.blank)
      await new Promise((resolve) => setTimeout(resolve, 200))
      textCommit = (await evaluate(ctx.canvasView, TEXT_TOOL_STATE)) as Record<string, unknown> | null

      // 双击文本框中心：内容应原样回来，证明真的落成了画布对象。
      // 不点原始落点——小文本框的左上角会落进缩放热区，双击意图会被缩放抢走。
      const reopenAt = (await evaluate(
        ctx.canvasView,
        `(() => {
          const box = document.querySelector('.overlay__box')?.getBoundingClientRect()
          return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null
        })()`
      )) as { x: number; y: number } | null
      const reopenSpot = reopenAt ?? textTargets.stage
      await realClick(ctx.canvasView, reopenSpot, 1)
      await realClick(ctx.canvasView, reopenSpot, 2)
      await new Promise((resolve) => setTimeout(resolve, 200))
      textReopen = (await evaluate(ctx.canvasView, TEXT_TOOL_STATE)) as Record<string, unknown> | null
      // 收尾：Esc 结束编辑，别把浮层留给后面的检查。
      ctx.canvasView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      ctx.canvasView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  add(
    'text-tool-creates-inline-editor',
    Boolean(
      textTool?.toolPressed === 'true' &&
        textTool.editor &&
        textTool.focused &&
        textTool.typedValue === 'Hello'
    ),
    textTool
  )
  add(
    'text-tool-commits-typed-content',
    Boolean(
      textCommit &&
        textCommit.editor === false &&
        textCommit.selected === '1' &&
        textReopen?.editor === true &&
        textReopen.value === 'Hello'
    ),
    { textCommit, textReopen }
  )

  // 2b-3) 文本只能等比缩放：拖右下角放大后，字号要同步变大且落在整数上。
  const textScaleBefore = (await evaluate(
    ctx.canvasView,
    `(() => {
      const box = document.querySelector('.overlay__box')
      if (!box) return null
      const r = box.getBoundingClientRect()
      return { right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    })()`
  )) as { right: number; bottom: number; width: number; height: number } | null
  let textScale: Record<string, unknown> | null = null
  if (textScaleBefore) {
    await realDrag(
      ctx.canvasView,
      { x: textScaleBefore.right, y: textScaleBefore.bottom },
      {
        x: textScaleBefore.right + textScaleBefore.width,
        y: textScaleBefore.bottom + textScaleBefore.height
      }
    )
    const after = (await evaluate(
      ctx.canvasView,
      `(() => {
        const box = document.querySelector('.overlay__box')
        if (!box) return null
        const r = box.getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
      })()`
    )) as { left: number; top: number; width: number; height: number } | null
    if (after) {
      const center = {
        x: after.left + after.width / 2,
        y: after.top + after.height / 2
      }
      await realClick(ctx.canvasView, center)
      await realClick(ctx.canvasView, center, 2)
      const font = (await evaluate(
        ctx.canvasView,
        `(() => {
          const editor = document.querySelector('.canvas-text-editor')
          return editor ? Number.parseFloat(getComputedStyle(editor).fontSize) : null
        })()`
      )) as number | null
      ctx.canvasView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      ctx.canvasView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await new Promise((resolve) => setTimeout(resolve, 120))
      textScale = {
        widthBefore: Math.round(textScaleBefore.width),
        widthAfter: Math.round(after.width),
        font,
        integerFont: font !== null && Number.isInteger(font)
      }
    }
  }
  add(
    'text-tool-scales-font-proportionally',
    Boolean(
      textScale &&
        typeof textScale.widthAfter === 'number' &&
        textScale.widthAfter > Number(textScale.widthBefore) * 1.6 &&
        typeof textScale.font === 'number' &&
        textScale.integerFont &&
        textScale.font >= 40
    ),
    textScale
  )

  // 2b-4) 属性条数值：输入过程不落库；清空后灰字记住旧值；回车才应用。
  const fontFieldSpot = (await evaluate(
    ctx.canvasView,
    `(() => {
      const input = document.querySelector('.element-props__number--fixed input')
      if (!input) return null
      const r = input.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`
  )) as { x: number; y: number } | null
  let numberCommit: Record<string, unknown> | null = null
  if (fontFieldSpot) {
    const wc = ctx.canvasView.webContents
    const waitForFontFieldSelection = async (): Promise<boolean> => {
      const deadline = Date.now() + 1000
      while (Date.now() < deadline) {
        const selected = (await evaluate(
          ctx.canvasView,
          `(() => {
            const input = document.querySelector('.element-props__number--fixed input')
            return Boolean(
              input &&
                document.activeElement === input &&
                input.selectionStart === 0 &&
                input.selectionEnd === input.value.length
            )
          })()`
        )) as boolean
        if (selected) return true
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      return false
    }
    await realClick(ctx.canvasView, fontFieldSpot)
    await waitForFontFieldSelection()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] })
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const emptied = (await evaluate(
      ctx.canvasView,
      `(() => {
        const input = document.querySelector('.element-props__number--fixed input')
        return input ? { value: input.value, placeholder: input.placeholder } : null
      })()`
    )) as { value: string; placeholder: string } | null

    // 删干净后直接离开（点回文字）：旧值应原样保留。
    const textCenter = (await evaluate(
      ctx.canvasView,
      `(() => {
        const r = document.querySelector('.overlay__box')?.getBoundingClientRect()
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
      })()`
    )) as { x: number; y: number } | null
    if (textCenter) await realClick(ctx.canvasView, textCenter)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const kept = (await evaluate(
      ctx.canvasView,
      `(() => document.querySelector('.element-props__number--fixed input')?.value ?? null)()`
    )) as string | null

    // 输入新的整数并回车：应立刻应用。
    await realClick(ctx.canvasView, fontFieldSpot)
    await waitForFontFieldSelection()
    wc.insertText('60')
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    const applied = (await evaluate(
      ctx.canvasView,
      `(() => document.querySelector('.element-props__number--fixed input')?.value ?? null)()`
    )) as string | null
    numberCommit = { emptied, kept, applied }
  }
  add(
    'element-props-number-commits-on-enter',
    Boolean(
      numberCommit &&
        (numberCommit.emptied as { value: string } | null)?.value === '' &&
        (numberCommit.emptied as { placeholder: string } | null)?.placeholder === '49' &&
        numberCommit.kept === '49' &&
        numberCommit.applied === '60'
    ),
    numberCommit
  )

  // 2c) 画布右下角控制都在（图层面板默认收起，所以查的是入口不是面板本身）；
  //     浏览器面板默认展开、分栏线随之出现（D3.5/D3.6）
  const panels = (await evaluate(
    ctx.canvasView,
    `(() => ({
      browserButton: Boolean(document.querySelector('.corner--top-left')),
      // 入口始终挂载；窄画布只是把其中几项收进"更多"（宽度动画到 0）
      canvasControls: (() => {
        const controls = [...document.querySelectorAll('.canvas-control')]
        return (
          controls.length >= 5 &&
          Boolean(document.querySelector('.canvas-control--more')) &&
          Boolean(document.querySelector('.canvas-control[aria-label^="画布与图层"]')) &&
          Boolean(document.querySelector('.canvas-control[aria-label^="更多设置"]')) &&
          Boolean(document.querySelector('.canvas-control--zoom'))
        )
      })(),
      // 浏览器侧栏打开时原生网页铺满到底，左下文件夹开关让位隐藏；
      // 收起浏览器后它必须回来（互斥场景在 2d-2 里点它验证）。
      foldersButtonHidden: !document.querySelector('.corner--bottom-left'),
      toolbar: Boolean(document.querySelector('.toolbar')),
      panel: Boolean(document.querySelector('.browser[data-open="true"]')),
      splitter: Boolean(document.querySelector('.splitter'))
    }))()`
  )) as Record<string, boolean> | null
  add(
    'canvas-panels-mounted',
    Boolean(
      panels &&
        panels.browserButton &&
        panels.canvasControls &&
        panels.foldersButtonHidden &&
        panels.toolbar &&
        panels.panel &&
        panels.splitter
    ),
    panels
  )

  // 图层树使用虚拟列表，行是绝对定位的，不会反向撑高父容器。
  // 因此弹层必须自己提供稳定高度；只写 max-height 会让有几十层的树也塌成标题栏。
  const layersPanelGeometry = (await evaluate(
    ctx.canvasView,
    `(async () => {
      // 窄画布时图层入口收在"更多"里，两条路都要能打开
      document.querySelector('[aria-label="图层：查看和整理画布对象"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (!document.querySelector('.layers')) {
        document.querySelector('[aria-label="更多画布功能"]')?.click()
        await new Promise((resolve) => setTimeout(resolve, 40))
        ;[...document.querySelectorAll('.canvas-popover--more button')]
          .find((item) => item.textContent?.includes('图层'))?.click()
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      const panel = document.querySelector('.layers')?.getBoundingClientRect() ?? null
      const tree = document.querySelector('.layers__tree')?.getBoundingClientRect() ?? null
      const canvasSection = Boolean(document.querySelector('.layers__canvas-section'))
      const canvasRow = document.querySelector('.layers__canvas-row')
      canvasRow?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      }))
      await new Promise((resolve) => setTimeout(resolve, 40))
      const renameAction = [...document.querySelectorAll('.context-menu__item')]
        .find((item) => item.textContent === '重命名')
      renameAction?.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      const renameInput = document.querySelector('.layers__canvas-rename')
      renameInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.querySelector('[aria-label="关闭图层面板"]')?.click()
      return panel && tree
        ? {
            panelHeight: Math.round(panel.height),
            treeHeight: Math.round(tree.height),
            canvasSection,
            canvasContextRename: Boolean(renameAction),
            canvasRenameInput: Boolean(renameInput)
          }
        : null
    })()`
  )) as {
    panelHeight: number
    treeHeight: number
    canvasSection: boolean
    canvasContextRename: boolean
    canvasRenameInput: boolean
  } | null
  add(
    'layers-panel-reserves-tree-height',
    Boolean(
      layersPanelGeometry &&
        layersPanelGeometry.panelHeight >= 300 &&
        layersPanelGeometry.treeHeight >= 200 &&
        layersPanelGeometry.canvasSection &&
        layersPanelGeometry.canvasContextRename &&
        layersPanelGeometry.canvasRenameInput
    ),
    layersPanelGeometry
  )

  // 2d) 视觉几何回归：标签条要与左上浏览器按钮同一行；工具栏 / 右下视图控制
  //     仍距底 12px。左下文件夹开关在浏览器打开时不显示（网页要铺满底边），
  //     它与素材面板底栏的对齐改在 2d-2 收起浏览器后核对。
  //     画布右缘也始终到窗口内侧边，防止旧版右停靠原生视图在右边留下一条
  //     “看似画布、实际点不到”的区域。
  const geometry = (await evaluate(
    ctx.canvasView,
    `(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null
      const app = rect('.app')
      const canvas = rect('.canvas-area')
      const tab = rect('.browser__tab')
      const browserButton = rect('.corner--top-left')
      const toolbar = rect('.toolbar')
      const controls = rect('.canvas-controls')
      if (!app || !canvas || !tab || !browserButton || !toolbar || !controls) return null
      const bottomGap = (entry) => Math.round((canvas.bottom - entry.bottom) * 10) / 10
      return {
        tabButtonBottomDelta: Math.round(Math.abs(tab.bottom - browserButton.bottom) * 10) / 10,
        toolbarBottomGap: bottomGap(toolbar),
        controlsBottomGap: bottomGap(controls),
        canvasLeftGap: Math.round((canvas.left - app.left) * 10) / 10,
        canvasRightGap: Math.round((app.right - canvas.right) * 10) / 10
      }
    })()`
  )) as {
    tabButtonBottomDelta: number
    toolbarBottomGap: number
    controlsBottomGap: number
    canvasLeftGap: number
    canvasRightGap: number
  } | null
  add(
    'canvas-geometry-aligned',
    Boolean(
      geometry &&
        geometry.tabButtonBottomDelta <= 4 &&
        geometry.toolbarBottomGap === 12 &&
        geometry.controlsBottomGap === 12 &&
        geometry.canvasLeftGap === ctx.panelGutter &&
        geometry.canvasRightGap === ctx.panelGutter
    ),
    geometry
  )

  // 2d-1) 浏览器按钮 / 标签页：标签未选中是白底，选中才为浅灰；拿不到网站图标时
  // 必须画 16px Earth 兜底，不能退回以前那颗黑色圆点。
  const browserChrome = (await evaluate(
    ctx.canvasView,
    `(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null
      const button = rect('.corner--top-left')
      const tab = document.querySelector('.browser__tab[data-active="true"]')
      // 不在自检里创建真实原生网页标签（会引入页面网络加载的非确定性）。
      // 这里用同一 class 的临时节点核对未选中态 CSS；产品中的真实标签同样走这条规则。
      const inactiveTab = document.createElement('div')
      inactiveTab.className = 'browser__tab'
      document.querySelector('.browser__tabs')?.append(inactiveTab)
      const earth = tab?.querySelector('.browser__tab-earth')?.getBoundingClientRect() ?? null
      const close = rect('.browser__tab-close')
      const plus = rect('.browser__newtab')
      const mark = rect('.browser-mark')
      if (!button || !tab || !earth || !close || !plus || !mark) {
        return {
          missing: {
            button: !button,
            activeTab: !tab,
            earth: !earth,
            close: !close,
            plus: !plus,
            mark: !mark
          }
        }
      }
      const activeStyle = getComputedStyle(tab)
      const inactiveStyle = getComputedStyle(inactiveTab)
      const inactiveBackground = inactiveStyle.backgroundColor
      inactiveTab.remove()
      return {
        button: [Math.round(button.width), Math.round(button.height)],
        tab: [Math.round(tab.getBoundingClientRect().width), Math.round(tab.getBoundingClientRect().height)],
        earth: [Math.round(earth.width), Math.round(earth.height)],
        close: [Math.round(close.width), Math.round(close.height)],
        plus: [Math.round(plus.width), Math.round(plus.height)],
        mark: [Math.round(mark.width), Math.round(mark.height)],
        tabRadius: activeStyle.borderRadius,
        activeBackground: activeStyle.backgroundColor,
        inactiveBackground,
        tabFontSize: activeStyle.fontSize,
        topDelta: Math.round(Math.abs(button.top - tab.getBoundingClientRect().top) * 10) / 10
      }
    })()`
  )) as {
    button: [number, number]
    tab: [number, number]
    earth: [number, number]
    close: [number, number]
    plus: [number, number]
    mark: [number, number]
    tabRadius: string
    activeBackground: string
    inactiveBackground: string
    tabFontSize: string
    topDelta: number
  } | null
  add(
    'browser-chrome-relay-29-138',
    Boolean(
      browserChrome &&
        browserChrome.button.join('x') === '40x40' &&
        browserChrome.tab.join('x') === '186x40' &&
        browserChrome.earth.join('x') === '16x16' &&
        browserChrome.close.join('x') === '8x8' &&
        browserChrome.plus.join('x') === '12x12' &&
        browserChrome.mark.join('x') === '24x24' &&
        browserChrome.tabRadius === '12px' &&
        browserChrome.activeBackground === 'rgb(244, 244, 244)' &&
        browserChrome.inactiveBackground === 'rgb(255, 255, 255)' &&
        browserChrome.tabFontSize === '12px' &&
        browserChrome.topDelta === 0
    ),
    browserChrome
  )

  // 2d-1a) 项目入口现在在图层面板的“画布”列表里：双击改名、右键删除，
  // 删除必须经过二次确认。这里直接驱动真实事件，防止以后又把这些路径弄丢。
  const projectMenu = (await evaluate(
    ctx.canvasView,
    `(async () => {
      const waitFor = async (predicate, timeout = 800) => {
        const end = performance.now() + timeout
        while (!predicate() && performance.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 16))
        }
        return predicate()
      }
      if (!document.querySelector('.layers')) {
        document.querySelector('[aria-label="图层：查看和整理画布对象"]')?.click()
        await waitFor(() => Boolean(document.querySelector('.layers__canvas-row')))
        if (!document.querySelector('.layers__canvas-row')) {
          document.querySelector('[aria-label="更多画布功能"]')?.click()
          await waitFor(() => Boolean(document.querySelector('.canvas-popover--more')))
          ;[...document.querySelectorAll('.canvas-popover--more button')]
            .find((item) => item.textContent?.includes('图层'))?.click()
          await waitFor(() => Boolean(document.querySelector('.layers__canvas-row')))
        }
      }
      const row = document.querySelector('.layers__canvas-row')
      if (!row) return { missing: 'canvas-row' }
      const label = row.textContent?.trim()
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const renameInput = await waitFor(() => document.querySelector('.layers__canvas-rename'))
      document.querySelector('.layers__canvas-rename')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 40))
      const restored = document.querySelector('.layers__canvas-row')
      restored?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }))
      const deleteAction = await waitFor(() =>
        [...document.querySelectorAll('.context-menu__item')].find((item) => item.textContent === '删除画布')
      )
      deleteAction?.click()
      const confirm = await waitFor(() => document.querySelector('.project-confirm'))
      const cancel = confirm?.querySelector('button:not(.project-confirm__delete)')
      cancel?.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      const cancelClosesConfirmation = !document.querySelector('.project-confirm')
      document.querySelector('[aria-label="关闭图层面板"]')?.click()
      return {
        label,
        doubleClickStartsRename: Boolean(renameInput),
        rightClickShowsDelete: Boolean(deleteAction),
        deleteNeedsConfirmation: Boolean(confirm),
        cancelClosesConfirmation
      }
    })()`
  )) as {
    label?: string
    doubleClickStartsRename?: boolean
    rightClickShowsDelete?: boolean
    deleteNeedsConfirmation?: boolean
    cancelClosesConfirmation?: boolean
    missing?: string
  } | null
  add(
    'default-project-menu-interactions',
    Boolean(
      projectMenu &&
        projectMenu.label === '画布1' &&
        projectMenu.doubleClickStartsRename &&
        projectMenu.rightClickShowsDelete &&
        projectMenu.deleteNeedsConfirmation &&
        projectMenu.cancelClosesConfirmation
    ),
    projectMenu
  )

  // 2d-2) 左下文件夹复用同一套侧栏容器，但与浏览器严格互斥：打开文件夹后
  // 浏览器 chrome 必须已收起、分栏线仍可拖；再开浏览器则先等文件夹收起再揭开。
  const sidePanelExclusivity = (await evaluate(
    ctx.canvasView,
    `(async () => {
      const browserButton = document.querySelector('.corner--top-left')
      const folderPanel = document.querySelector('.folder-panel')
      const browser = document.querySelector('.browser')
      const folderStyle = getComputedStyle(folderPanel)
      const waitFor = async (predicate, timeout = 800) => {
        const end = performance.now() + timeout
        while (!predicate() && performance.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 16))
        }
        return predicate()
      }
      if (!browserButton || !folderPanel || !browser) return null
      // 浏览器侧栏打开时左下文件夹开关隐藏（原生网页要铺满底边），先收起浏览器。
      if (browser.dataset.open === 'true') {
        browserButton.click()
        await waitFor(() => browser.dataset.open === 'false', 1200)
      }
      const folderButton = document.querySelector('.corner--bottom-left')
      if (!folderButton) return null
      const collapsedCount = () =>
        document.querySelectorAll('.canvas-control[data-collapsed="true"]').length
      const controlsCollapsedBefore = collapsedCount()
      folderButton.click()
      const folderOpened = await waitFor(() => folderPanel.dataset.open === 'true')
      // 等 React 布局效应落定：收拢级别在打开后的第一帧就定了
      await new Promise((resolve) => setTimeout(resolve, 100))
      const centerY = (element) => {
        const r = element?.getBoundingClientRect()
        return r ? Math.round(((r.top + r.bottom) / 2) * 10) / 10 : null
      }
      const box = (selector) => {
        const r = document.querySelector(selector)?.getBoundingClientRect()
        return r
          ? { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
          : null
      }
      const appStyle = getComputedStyle(document.querySelector('.app'))
      const afterFolder = {
        folderOpened,
        browserOpen: browser.dataset.open === 'true',
        splitter: Boolean(document.querySelector('.splitter')),
        folderRadius: folderStyle.borderTopRightRadius,
        // 文件夹侧栏与浏览器侧栏一样遮住画布左边：工具条/右下控制区必须按同一几何收拢
        controlsCollapsedBefore,
        controlsCollapsed: collapsedCount(),
        geometry: {
          innerWidth: window.innerWidth,
          panelShift: appStyle.getPropertyValue('--panel-shift'),
          panelW: appStyle.getPropertyValue('--panel-w'),
          folderWidth: Math.round(folderPanel.getBoundingClientRect().width),
          toolbar: box('.toolbar'),
          controls: box('.canvas-controls')
        },
        // 左下开关必须与底栏里的标签卡/操作按钮在同一条中心线上
        alignment: {
          button: centerY(folderButton),
          tab: centerY(document.querySelector('.folder-panel__bottom .browser__tab')),
          action: centerY(document.querySelector('.folder-panel__action'))
        }
      }
      browserButton.click()
      const browserOpened = await waitFor(() => browser.dataset.open === 'true', 1200)
      return {
        afterFolder,
        browserOpened,
        folderClosed: folderPanel.dataset.open === 'false'
      }
    })()`
  )) as {
    afterFolder: {
      folderOpened: boolean
      browserOpen: boolean
      splitter: boolean
      folderRadius: string
      controlsCollapsedBefore: number
      controlsCollapsed: number
      geometry: {
        innerWidth: number
        panelShift: string
        panelW: string
        folderWidth: number
        toolbar: { left: number; right: number; width: number } | null
        controls: { left: number; right: number; width: number } | null
      }
      alignment: { button: number | null; tab: number | null; action: number | null }
    }
    browserOpened: boolean
    folderClosed: boolean
  } | null
  const folderAlignment = sidePanelExclusivity?.afterFolder.alignment
  add(
    'browser-and-folder-panels-exclusive',
    Boolean(
      sidePanelExclusivity &&
        sidePanelExclusivity.afterFolder.folderOpened &&
        !sidePanelExclusivity.afterFolder.browserOpen &&
        sidePanelExclusivity.afterFolder.splitter &&
        sidePanelExclusivity.afterFolder.folderRadius === '16px' &&
        sidePanelExclusivity.afterFolder.controlsCollapsed > 0 &&
        sidePanelExclusivity.browserOpened &&
        sidePanelExclusivity.folderClosed &&
        folderAlignment &&
        folderAlignment.button !== null &&
        folderAlignment.tab !== null &&
        folderAlignment.action !== null &&
        Math.abs(folderAlignment.button - folderAlignment.tab) <= 1 &&
        Math.abs(folderAlignment.button - folderAlignment.action) <= 1
    ),
    sidePanelExclusivity
  )

  // 2d-2b) 从"没有任何侧栏"的状态单独打开文件夹，也必须像浏览器一样把底部
  // 工具条和右下控制区收进"更多"（用户报的场景）。
  const folderCollapseFromIdle = (await evaluate(
    ctx.canvasView,
    `(async () => {
      const browserButton = document.querySelector('.corner--top-left')
      const browser = document.querySelector('.browser')
      const folder = document.querySelector('.folder-panel')
      if (!browserButton || !browser || !folder) return null
      const waitFor = async (predicate, timeout = 1200) => {
        const end = performance.now() + timeout
        while (!predicate() && performance.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 16))
        }
        return predicate()
      }
      const count = () =>
        document.querySelectorAll('.canvas-control[data-collapsed="true"]').length

      // 回到无侧栏基线；文件夹开关要等浏览器收起后才出现
      if (browser.dataset.open === 'true') {
        browserButton.click()
        await waitFor(() => browser.dataset.open === 'false')
      }
      await waitFor(() => Boolean(document.querySelector('.corner--bottom-left')))
      await new Promise((resolve) => setTimeout(resolve, 120))
      const before = count()
      const folderButton = document.querySelector('.corner--bottom-left')
      if (!folderButton) return null

      folderButton.click()
      await waitFor(() => folder.dataset.open === 'true')
      await new Promise((resolve) => setTimeout(resolve, 120))
      const after = count()

      // 收尾：收起文件夹、恢复浏览器，后续检查还要用
      folderButton.click()
      await waitFor(() => folder.dataset.open === 'false')
      browserButton.click()
      await waitFor(() => browser.dataset.open === 'true')
      return { before, after }
    })()`
  )) as { before: number; after: number } | null
  add(
    'folder-panel-collapses-canvas-controls-from-idle',
    Boolean(folderCollapseFromIdle && folderCollapseFromIdle.before === 0 && folderCollapseFromIdle.after > 0),
    folderCollapseFromIdle
  )

  // 2d-3) 左侧浏览器完全揭开后，右侧画布视窗的左上/左下应是“外凸”16px 圆角：
  // 角落一个像素不应命中舞台，离边缘 20px 则应落在舞台内。这样可排除内凹遮罩。
  const visibleCanvasCorners = (await evaluate(
    ctx.canvasView,
    `(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const browser = document.querySelector('.browser')?.getBoundingClientRect()
      const area = document.querySelector('.canvas-area')?.getBoundingClientRect()
      const canvasViewport = document.querySelector('.canvas-viewport')
      const stage = document.querySelector('.stage')
      if (!browser || !area || !canvasViewport || !stage) return null
      const clipPath = getComputedStyle(canvasViewport).clipPath
      const leftInset = Number(clipPath.replace('inset(', '').split(' ')[3]?.replace('px', ''))
      return {
        clipPath,
        worldClipPath: getComputedStyle(stage).clipPath,
        viewportMatchesWorld: Math.round(canvasViewport.getBoundingClientRect().width) === Math.round(stage.getBoundingClientRect().width),
        leftInset,
        expectedLeftInset: browser.right - area.left,
        has16pxRadius: clipPath.includes('round 16px')
      }
    })()`
  )) as {
    clipPath: string
    worldClipPath: string
    viewportMatchesWorld: boolean
    leftInset: number
    expectedLeftInset: number
    has16pxRadius: boolean
  } | null
  add(
    'visible-canvas-keeps-16px-corners-beside-browser',
    Boolean(
        visibleCanvasCorners &&
        visibleCanvasCorners.clipPath !== 'none' &&
        visibleCanvasCorners.worldClipPath === 'none' &&
        visibleCanvasCorners.viewportMatchesWorld &&
        Math.abs(visibleCanvasCorners.leftInset - visibleCanvasCorners.expectedLeftInset) <= 1 &&
        visibleCanvasCorners.has16pxRadius
    ),
    visibleCanvasCorners
  )

  // 2d-4) 不能只验 CSS 属性：必须抓取真实渲染截图。左上圆角外的像素应露出白色
  // 工作区，向内 24px 则应是灰色画布；两者相同说明父层背景把圆角“补成了直角”。
  const visualCorners = (await evaluate(
    ctx.canvasView,
    `(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const area = document.querySelector('.canvas-area')?.getBoundingClientRect()
      const viewport = document.querySelector('.canvas-viewport')
      const browser = document.querySelector('.browser')?.getBoundingClientRect()
      if (!area || !viewport || !browser) return null
      const clipPath = getComputedStyle(viewport).clipPath
      const leftInset = Number(clipPath.replace('inset(', '').split(' ')[3]?.replace('px', ''))
      const left = area.left + leftInset
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        corner: { x: left + 1, y: area.top + 1 },
        inside: { x: left + 24, y: area.top + 24 },
        bottomCorner: { x: left + 1, y: area.bottom - 1 },
        bottomInside: { x: left + 24, y: area.bottom - 24 }
      }
    })()`
  )) as {
    width: number
    height: number
    corner: { x: number; y: number }
    inside: { x: number; y: number }
    bottomCorner: { x: number; y: number }
    bottomInside: { x: number; y: number }
  } | null
  let visualCornerDetail: Record<string, unknown> | null = null
  if (visualCorners) {
    const image = await ctx.canvasView.webContents.capturePage()
    const imageSize = image.getSize()
    const bitmap = image.toBitmap()
    const scaleX = imageSize.width / visualCorners.width
    const scaleY = imageSize.height / visualCorners.height
    const pixelAt = (point: { x: number; y: number }): [number, number, number] => {
      const x = Math.max(0, Math.min(imageSize.width - 1, Math.floor(point.x * scaleX)))
      const y = Math.max(0, Math.min(imageSize.height - 1, Math.floor(point.y * scaleY)))
      const index = (y * imageSize.width + x) * 4
      // Electron 的 NativeImage 位图是 BGRA；比较色距不依赖通道顺序。
      return [bitmap[index] ?? 0, bitmap[index + 1] ?? 0, bitmap[index + 2] ?? 0]
    }
    const distance = (a: [number, number, number], b: [number, number, number]): number =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
    const topCorner = pixelAt(visualCorners.corner)
    const topInside = pixelAt(visualCorners.inside)
    const bottomCorner = pixelAt(visualCorners.bottomCorner)
    const bottomInside = pixelAt(visualCorners.bottomInside)
    const screenshot = join(tmpdir(), 'inspin-canvas-viewport-smoke.png')
    writeFileSync(screenshot, image.toPNG())
    visualCornerDetail = {
      screenshot,
      topCorner,
      topInside,
      bottomCorner,
      bottomInside,
      topDistance: distance(topCorner, topInside),
      bottomDistance: distance(bottomCorner, bottomInside)
    }
  }
  add(
    'canvas-viewport-visual-rounded-corners',
    Boolean(
      visualCornerDetail &&
        Number(visualCornerDetail.topDistance) >= 20 &&
        Number(visualCornerDetail.bottomDistance) >= 20
    ),
    visualCornerDetail
  )

  // 2e) 菜单条与右下视图控制重叠时，菜单条应在上层（参考稿的“浮在上面”关系）。
  const toolbarLayer = (await evaluate(
    ctx.canvasView,
    `(() => ({
      toolbar: Number(getComputedStyle(document.querySelector('.toolbar')).zIndex) || 0,
      controls: Number(getComputedStyle(document.querySelector('.canvas-controls')).zIndex) || 0
    }))()`
  )) as { toolbar: number; controls: number } | null
  add('toolbar-over-canvas-controls', Boolean(toolbarLayer && toolbarLayer.toolbar > toolbarLayer.controls), toolbarLayer)

  // 2f) 拖动分栏线时不连续重建 Pixi drawing buffer；松手才让尺寸最终对齐。
  const dragResize = (await evaluate(ctx.canvasView, SPLITTER_DRAG_PROBE)) as {
    widths: number[]
    browserWidths: number[]
    targetWidths: number[]
    stageClipLefts: number[]
    expectedClipLefts: number[]
    stageClipRadii: boolean[]
    distinctDuringDrag: number
    dpr: number
    canvasWidth: number
    hostWidth: number
    rendererWidth: number
  } | null
  add(
    'canvas-stable-while-resizing-panel',
    Boolean(
      dragResize &&
        dragResize.distinctDuringDrag <= 1 &&
        dragResize.hostWidth === dragResize.rendererWidth &&
        dragResize.browserWidths.every((width, index) => width === dragResize.targetWidths[index]) &&
        dragResize.stageClipLefts.every((left, index) => left === dragResize.expectedClipLefts[index]) &&
        dragResize.stageClipRadii.every(Boolean)
    ),
    dragResize
  )

  // 3) 浏览器视图：起始页（新标签页）已加载，六个来源卡都在
  add(
    'browser-view-loaded',
    (await evaluate(
      ctx.browserView,
      `document.title === 'InsPin' && document.querySelectorAll('.source-card').length >= 1`
    )) === true
  )

  // 3a) 登录/授权弹窗：window.open 必须开出**独立子窗口**并共享同一会话，
  //     否则花瓣这类“弹窗授权 + opener 回调”的登录会一直卡在授权页。
  const popupProbe = await (async (): Promise<{
    opened: boolean
    width?: number
    height?: number
    sameSession?: boolean
    url?: string
    missing?: boolean
  }> => {
    const opener = ctx.browserView.webContents
    const before = new Set(BrowserWindow.getAllWindows().map((win) => win.id))
    const opened = (await opener.executeJavaScript(
      `Boolean(window.open('about:blank', 'inspin-login-probe', 'width=640,height=480'))`
    )) as boolean

    let popup: BrowserWindow | null = null
    for (let attempt = 0; attempt < 50 && !popup; attempt += 1) {
      popup = BrowserWindow.getAllWindows().find((win) => !before.has(win.id)) ?? null
      if (!popup) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!popup) return { opened, missing: true }

    const bounds = popup.getBounds()
    const sameSession = popup.webContents.session === opener.session
    const url = popup.webContents.getURL()
    popup.close()
    return { opened, width: bounds.width, height: bounds.height, sameSession, url }
  })()
  add(
    'browser-login-popup',
    Boolean(
      popupProbe &&
        popupProbe.opened &&
        !popupProbe.missing &&
        popupProbe.sameSession &&
        popupProbe.url === 'about:blank' &&
        popupProbe.width === 640 &&
        typeof popupProbe.height === 'number' &&
        popupProbe.height >= 480 &&
        popupProbe.height <= 560
    ),
    popupProbe
  )

  // 4) 起始页服务在进程外也可访问（验证 http 服务真的在跑）
  try {
    const response = await fetch(ctx.startPageUrl)
    const body = await response.text()
    add('start-page-http', response.ok && body.includes('灵感钉'), {
      status: response.status,
      bytes: body.length
    })
  } catch (error) {
    add('start-page-http', false, error instanceof Error ? error.message : String(error))
  }

  // 5) 拖放数据通路：合成 drop 到画布，确认 text/html 与 text/uri-list 能被拿到
  const drag = (await evaluate(ctx.canvasView, DRAG_PROBE)) as {
    html?: string | null
    uri?: string | null
  } | null
  add(
    'drag-payload-roundtrip',
    Boolean(drag && drag.html?.includes('drag-probe.png') && drag.uri?.includes('drag-probe.png')),
    drag
  )

  // 5b) 这一步才是 D3.8 的关键：拖放**真的被应用接住了**。
  //     上面那条只证明"数据拿得到"，这条证明"事件走到了画布的处理逻辑"——
  //     没接住的话，用户拖了半天画布毫无反应，而自检仍然全绿。
  //     往 .stage 上派发（不是 .app：事件冒泡往上走，派给祖先根本到不了处理函数）。
  let dropHandled: Record<string, unknown> | null = null
  await evaluate(ctx.canvasView, DROP_INTO_CANVAS)
  for (let attempt = 0; attempt < 30; attempt++) {
    dropHandled = (await evaluate(
      ctx.canvasView,
      `(() => {
        const drop = document.querySelector('.drop')
        return {
          placeholder: Boolean(drop),
          status: drop ? drop.getAttribute('data-status') : null,
          // 失败占位符已移除；所有导入反馈统一落在画布工具条上方的 Toast。
          notice: document.querySelector('.toast')?.textContent ?? null
        }
      })()`
    )) as Record<string, unknown> | null
    if (dropHandled?.['placeholder'] || dropHandled?.['notice']) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  add(
    'web-drop-handled',
    Boolean(dropHandled?.['placeholder'] || dropHandled?.['notice']),
    dropHandled
  )

  return checks
}

/** 把自检结果写进日志（基础检查 + 面板几何检查一起记）。 */
export function logSmokeResult(checks: SmokeCheck[], logger: Logger): void {
  const failed = checks.filter((check) => !check.ok)
  logger.info(LogEvent.smokeResult, {
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map((check) => check.name)
  })
}

export function formatSmokeReport(checks: SmokeCheck[]): string {
  const lines = checks.map((check) => {
    const mark = check.ok ? '✓' : '✗'
    const detail = check.detail === undefined ? '' : `  ${JSON.stringify(check.detail)}`
    return `${mark} ${check.name}${detail}`
  })
  const failed = checks.filter((check) => !check.ok).length
  lines.push('')
  lines.push(failed === 0 ? `自检通过（${checks.length}/${checks.length}）` : `自检失败：${failed} 项未通过`)
  return lines.join('\n')
}
