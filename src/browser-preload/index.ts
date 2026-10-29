import { ipcRenderer } from 'electron'

/**
 * 第三方网页专用预加载层。
 *
 * 它不暴露任何 API 给网页：只在用户主动开启非冻结智能采集时，拦住一次真实左键，
 * 将点位交给主进程。滚轮、触控板、键盘与所有非采集状态的网页交互完全不受影响。
 *
 * 注意：这里**不能**引用 `shared/ipc` 等共享模块。沙箱 preload 只能加载 electron
 * 和内置模块；一旦打包器把共享模块拆成相对 chunk，整个 preload 会加载失败。
 */
const SMART_COLLECT_MODE = 'ins-pin:browser-smart-collect-mode'
const SMART_COLLECT_CLICK = 'ins-pin:browser-smart-collect-click'
const MOUSE_SHORTCUT_CONFIG = 'ins-pin:browser-mouse-shortcut-config'
const MOUSE_SHORTCUT = 'ins-pin:browser-mouse-shortcut'
const LIVE_OVERLAY = 'ins-pin:browser-live-overlay'

let collecting = false

ipcRenderer.on(SMART_COLLECT_MODE, (_event, enabled: unknown) => {
  collecting = enabled === true
  if (collecting) showLiveOverlay()
  else destroyLiveOverlay()
})

/** 截图瞬间先把压暗/高亮藏起来，否则它们会被一起截进素材里。 */
ipcRenderer.on(LIVE_OVERLAY, (_event, visible: unknown) => {
  if (!collecting || !liveOverlay) return
  setLiveOverlayVisible(visible !== false)
})

/** 采集时只认真实用户输入的左键，网页脚本伪造的事件不参与。 */
function blocksInteraction(event: Event): boolean {
  return collecting && event.isTrusted && (event as MouseEvent).button === 0
}

/**
 * 在捕获阶段截住采集期间的整个左键手势。
 *
 * - `pointerdown` 负责记录点位并开始拦截；
 * - `mousedown` / `mouseup` / `pointerup` 压住网页自己的拖拽、焦点和按压逻辑；
 * - `click` 必须单独拦：只取消 pointerdown 并不能阻止链接跳转和表单默认动作；
 * - 滚动走 wheel 事件，不受这里影响。
 */
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'] as const) {
  window.addEventListener(
    type,
    (event) => {
      if (!blocksInteraction(event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (type === 'pointerdown') {
        const { clientX, clientY } = event as MouseEvent
        // 高亮框对应的元素一起回传：主进程按它选中同一个候选，
        // 不能只给点位——点位命中的可能是外层卡片，截出来和高亮框不一致。
        const target = liveTargetAt(clientX, clientY)
        const rect = target ? liveRect(target) : null
        // 主进程随后会 capturePage；先把压暗/高亮藏掉，并等两帧确实画出去再报点，
        // 否则遮罩会被一起截进素材里。
        setLiveOverlayVisible(false)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            ipcRenderer.send(SMART_COLLECT_CLICK, { x: clientX, y: clientY, rect })
          })
        })
      }
    },
    true
  )
}

/* ---------- 非冻结智能采集：页面里的压暗与选区高亮 ---------- */

/**
 * 非冻结模式下网页一直露着，界面层的截图/遮罩根本盖不到它。所以把"压暗 + 高亮框"
 * 直接画进网页：一个 pointer-events:none 的固定层，跟随指针高亮光标的候选区域。
 *
 * 捕获阶段偷看指针、不改网页行为；点击仍由上面的采集拦截逻辑处理。
 * 选区判定沿用主进程的候选规则（媒体元素 / 语义容器 / 有背景或边框的卡片）。
 */
const LIVE_MEDIA_SELECTOR = 'img, video, canvas, svg, picture, iframe'
const LIVE_SEMANTIC_SELECTOR = 'a[href], article, figure, li, [role="article"], [role="listitem"]'
const LIVE_ACCENT = '#6d54eb'
const LIVE_DIM = 'rgba(23, 26, 38, 0.32)'
const LIVE_HOLE_SHADOW = '0 0 0 9999px rgba(23, 26, 38, 0.45)'
const LIVE_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif'

interface LiveOverlay {
  host: HTMLElement
  dim: HTMLElement
  box: HTMLElement
  label: HTMLElement
  tip: HTMLElement
}

let liveOverlay: LiveOverlay | null = null
let livePointer: { x: number; y: number } | null = null
let liveFrame = 0

function createElement(css: string, text?: string): HTMLElement {
  const element = document.createElement('div')
  element.style.cssText = css
  if (text) element.textContent = text
  return element
}

function showLiveOverlay(): void {
  if (!liveOverlay) {
    const host = document.createElement('div')
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block;'
    const shadow = host.attachShadow({ mode: 'closed' })
    const dim = createElement(`position: absolute; inset: 0; background: ${LIVE_DIM};`)
    const box = createElement(
      `position: absolute; display: none; box-sizing: border-box; border: 2px solid ${LIVE_ACCENT};` +
        ` border-radius: 3px; box-shadow: ${LIVE_HOLE_SHADOW};`
    )
    const label = createElement(
      `position: absolute; display: none; padding: 3px 7px; border-radius: 5px 5px 5px 0;` +
        ` color: #fff; background: ${LIVE_ACCENT}; font: 500 11px/15px ${LIVE_FONT}; white-space: nowrap;`,
      '智能采集'
    )
    const tip = createElement(
      `position: absolute; top: 24px; left: 50%; transform: translateX(-50%); padding: 8px 16px;` +
        ` border-radius: 12px; background: rgba(0, 0, 0, 0.7); color: #fff;` +
        ` font: 500 14px/20px ${LIVE_FONT}; white-space: nowrap;`,
      '单击采集 · Esc 退出'
    )
    shadow.append(dim, box, label, tip)
    document.documentElement.appendChild(host)
    liveOverlay = { host, dim, box, label, tip }
  }
  liveOverlay.host.style.display = 'block'
  livePointer = null
  scheduleLiveOverlay()
}

function destroyLiveOverlay(): void {
  if (liveFrame) cancelAnimationFrame(liveFrame)
  liveFrame = 0
  livePointer = null
  liveOverlay?.host.remove()
  liveOverlay = null
}

function setLiveOverlayVisible(visible: boolean): void {
  if (!liveOverlay) return
  liveOverlay.host.style.display = visible ? 'block' : 'none'
}

function liveHasSurface(style: CSSStyleDeclaration): boolean {
  const hasBorder =
    (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none') ||
    (parseFloat(style.borderRightWidth) > 0 && style.borderRightStyle !== 'none') ||
    (parseFloat(style.borderBottomWidth) > 0 && style.borderBottomStyle !== 'none') ||
    (parseFloat(style.borderLeftWidth) > 0 && style.borderLeftStyle !== 'none')
  const hasRoundedCorner = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius
  ].some((radius) => parseFloat(radius) > 0)
  return (
    style.overflow !== 'visible' ||
    style.overflowX !== 'visible' ||
    style.overflowY !== 'visible' ||
    hasRoundedCorner ||
    hasBorder ||
    style.boxShadow !== 'none' ||
    (style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)')
  )
}

/** 元素被视口裁完之后的尺寸；太小或不可见的元素不参与吸附。 */
function liveElementSize(element: Element): { width: number; height: number } | null {
  const rect = element.getBoundingClientRect()
  const width = Math.min(rect.right, Math.max(1, window.innerWidth)) - Math.max(rect.left, 0)
  const height = Math.min(rect.bottom, Math.max(1, window.innerHeight)) - Math.max(rect.top, 0)
  if (width < 32 || height < 32) return null
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
    return null
  }
  return { width, height }
}

/** 高亮框的网页视口坐标；点击时回传，主进程据此选中同一个候选。 */
function liveRect(element: Element): { x: number; y: number; width: number; height: number } | null {
  const rect = element.getBoundingClientRect()
  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  const right = Math.min(window.innerWidth, rect.right)
  const bottom = Math.min(window.innerHeight, rect.bottom)
  const width = right - left
  const height = bottom - top
  return width >= 1 && height >= 1 ? { x: left, y: top, width, height } : null
}

/** 指针下最像"一整块可采集区域"的元素；找不到就返回 null（只压暗，不画框）。 */
function liveTargetAt(x: number, y: number): Element | null {
  const start = document.elementFromPoint(x, y)
  if (!start) return null
  const viewportWidth = Math.max(1, window.innerWidth)
  const viewportHeight = Math.max(1, window.innerHeight)

  // 指针就在图片/视频上：框住媒体本身。图片常被放进带 padding 的卡片或 <a>，
  // 按外层评分会把框撑到整张卡片，和图片真实尺寸差很远。
  const media = start.closest(LIVE_MEDIA_SELECTOR)
  if (media && liveElementSize(media)) return media

  let element: Element | null = start

  for (let depth = 0; element && element !== document.body && depth < 9; depth += 1) {
    const size = liveElementSize(element)
    if (!size) {
      element = element.parentElement
      continue
    }
    const style = getComputedStyle(element)
    // 整屏大小的容器不算"一块区域"，否则永远只高亮整页
    if (
      size.width * size.height > viewportWidth * viewportHeight * 0.82 &&
      element.tagName !== 'IFRAME'
    ) {
      element = element.parentElement
      continue
    }
    // 就近原则：用户看到的是离指针最近的那块"面"。更高分数的外层卡片
    // 往往只是把图片/按钮包了一圈 padding，框出来会离真实尺寸很远。
    if (element.matches(LIVE_SEMANTIC_SELECTOR) || liveHasSurface(style)) return element
    element = element.parentElement
  }
  return null
}

function updateLiveOverlay(): void {
  const overlay = liveOverlay
  if (!overlay || !collecting) return

  const target = livePointer ? liveTargetAt(livePointer.x, livePointer.y) : null
  if (!target) {
    overlay.dim.style.display = 'block'
    overlay.box.style.display = 'none'
    overlay.label.style.display = 'none'
    return
  }

  const rect = target.getBoundingClientRect()
  const viewportWidth = Math.max(1, window.innerWidth)
  const viewportHeight = Math.max(1, window.innerHeight)
  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  const right = Math.min(viewportWidth, rect.right)
  const bottom = Math.min(viewportHeight, rect.bottom)
  const width = right - left
  const height = bottom - top
  if (width < 1 || height < 1) return

  overlay.dim.style.display = 'none'
  overlay.box.style.display = 'block'
  overlay.box.style.left = `${left}px`
  overlay.box.style.top = `${top}px`
  overlay.box.style.width = `${width}px`
  overlay.box.style.height = `${height}px`

  overlay.label.style.display = 'block'
  overlay.label.style.left = `${Math.max(0, left - 2)}px`
  // 框贴近顶边时把标签放到框内，避免飞出视口
  overlay.label.style.top = top >= 29 ? `${top - 27}px` : `${top + 4}px`
}

function scheduleLiveOverlay(): void {
  if (liveFrame) return
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0
    updateLiveOverlay()
  })
}

window.addEventListener(
  'pointermove',
  (event) => {
    if (!collecting) return
    livePointer = { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }
    scheduleLiveOverlay()
  },
  true
)

// 滚动后元素相对视口的位置变了，用最后一次指针位置重新算一遍
window.addEventListener(
  'scroll',
  () => {
    if (collecting && livePointer) scheduleLiveOverlay()
  },
  true
)

document.addEventListener('mouseleave', () => {
  if (!collecting) return
  livePointer = null
  scheduleLiveOverlay()
})

/**
 * 鼠标中键快捷键（与界面侧同一套存储格式）。
 *
 * 网页是原生视图，鼠标事件到不了 InsPin 界面；这里在捕获阶段认出中键、交给主进程执行，
 * 顺手挡住网页自己的"中键开新标签 / 自动滚动"。没绑定的中键完全不碰，网页照常工作。
 *
 * 主进程只在页面加载完成（和改键）时下发配置。拼接顺序照抄 `shared/shortcuts`：
 * Ctrl → Alt → Shift → Meta → MouseMiddle（这里不能 import 共享模块）。
 */
let mouseBindings: Array<{ accelerator: string; action: string }> = []

ipcRenderer.on(MOUSE_SHORTCUT_CONFIG, (_event, raw: unknown) => {
  if (!Array.isArray(raw)) {
    mouseBindings = []
    return
  }
  mouseBindings = raw.filter(
    (item): item is { accelerator: string; action: string } =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { accelerator?: unknown }).accelerator === 'string' &&
      typeof (item as { action?: unknown }).action === 'string'
  )
})

function middleAccelerator(event: MouseEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push('MouseMiddle')
  return parts.join('+')
}

function boundMiddleAction(event: MouseEvent): string | null {
  if (!event.isTrusted || event.button !== 1) return null
  const accelerator = middleAccelerator(event)
  return mouseBindings.find((item) => item.accelerator === accelerator)?.action ?? null
}

// mousedown 拦下按压与自动滚动，auxclick 拦下"中键开链接"的默认动作
for (const type of ['mousedown', 'auxclick'] as const) {
  window.addEventListener(
    type,
    (event) => {
      if (collecting) return
      const action = boundMiddleAction(event as MouseEvent)
      if (!action) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (type === 'mousedown') ipcRenderer.send(MOUSE_SHORTCUT, action)
    },
    true
  )
}

/**
 * 横向滚动兜底。
 *
 * 不少桌面站点（如 uinotes.com）把页面写死成 1420px 宽，再用
 * `body { overflow-x: hidden }` 把超出面板的右半边藏掉。面板比它窄时，
 * 网页既没有横向滚动条，触控板横滑也滚不动，右边内容等于看不见。
 *
 * 这里的做法只在检测到**明显横向溢出**（>24px）时生效，避免影响正常的响应式页面：
 *   1. 把 html 的 overflow-x 放开，让页面本身可以横向滚动；
 *   2. 接管触控板横滑（deltaX）和 Shift+滚轮，直接滚页面；
 *   3. 在视口底部注入一条可拖动的横滑条。
 */
const MIN_HORIZONTAL_OVERFLOW = 24
const SCROLL_BAR_HEIGHT = 10

let pageScrollEnabled = false
let barHost: HTMLElement | null = null
let barThumb: HTMLElement | null = null
let barThumbWidth = 0
let dragging = false
let dragStartX = 0
let dragStartScroll = 0
let measureFrame = 0
let measureTimer: number | null = null

function pageScroller(): Element {
  return document.scrollingElement ?? document.documentElement
}

function horizontalOverflow(): number {
  const el = pageScroller()
  return Math.max(0, el.scrollWidth - el.clientWidth)
}

function enablePageScroll(): void {
  if (pageScrollEnabled) return
  document.documentElement.style.setProperty('overflow-x', 'auto', 'important')
  pageScrollEnabled = true
}

/** 页面里自己的横向轮播先让原生处理，别把外层的页面滚动抢走。 */
function insideHorizontalScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== document.body && el !== document.documentElement) {
    const style = getComputedStyle(el)
    if (
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      el.scrollWidth > el.clientWidth + 2
    ) {
      return true
    }
    el = el.parentElement
  }
  return false
}

function ensureBar(): void {
  if (barHost) return
  const host = document.createElement('div')
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'left: 0',
    'right: 0',
    'bottom: 0',
    `height: ${SCROLL_BAR_HEIGHT}px`,
    'z-index: 2147483647',
    'pointer-events: none',
    'opacity: 0',
    'transition: opacity 120ms ease'
  ].join(';')
  const shadow = host.attachShadow({ mode: 'closed' })
  const thumb = document.createElement('div')
  thumb.style.cssText = [
    'position: absolute',
    'top: 2px',
    'left: 0',
    'height: 6px',
    'border-radius: 3px',
    'background: rgba(110, 110, 110, 0.55)',
    'pointer-events: auto',
    'cursor: grab',
    'transition: background 120ms ease'
  ].join(';')

  thumb.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    dragging = true
    dragStartX = event.clientX
    dragStartScroll = pageScroller().scrollLeft
    thumb.setPointerCapture(event.pointerId)
    thumb.style.cursor = 'grabbing'
    thumb.style.background = 'rgba(80, 80, 80, 0.8)'
  })
  thumb.addEventListener('pointermove', (event) => {
    if (!dragging) return
    const el = pageScroller()
    const maxScroll = el.scrollWidth - el.clientWidth
    const travel = Math.max(1, el.clientWidth - barThumbWidth)
    el.scrollLeft = dragStartScroll + ((event.clientX - dragStartX) / travel) * maxScroll
    scheduleMeasure()
  })
  const stopDrag = (event: PointerEvent): void => {
    dragging = false
    if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId)
    thumb.style.cursor = 'grab'
    thumb.style.background = 'rgba(110, 110, 110, 0.55)'
  }
  thumb.addEventListener('pointerup', stopDrag)
  thumb.addEventListener('pointercancel', stopDrag)

  shadow.appendChild(thumb)
  document.documentElement.appendChild(host)
  barHost = host
  barThumb = thumb
}

function updateBar(): void {
  const el = pageScroller()
  const maxScroll = el.scrollWidth - el.clientWidth
  if (maxScroll <= MIN_HORIZONTAL_OVERFLOW) {
    if (barHost) barHost.style.opacity = '0'
    return
  }

  enablePageScroll()
  ensureBar()
  if (!barHost || !barThumb) return

  const viewport = el.clientWidth
  barThumbWidth = Math.max(48, Math.round((viewport * viewport) / el.scrollWidth))
  const thumbLeft = Math.max(
    0,
    Math.min(viewport - barThumbWidth, (el.scrollLeft / maxScroll) * (viewport - barThumbWidth))
  )
  barThumb.style.width = `${barThumbWidth}px`
  barThumb.style.transform = `translateX(${thumbLeft}px)`
  barHost.style.opacity = '1'
}

function measureNow(): void {
  measureFrame = 0
  updateBar()
}

function scheduleMeasure(): void {
  if (measureFrame) return
  measureFrame = requestAnimationFrame(measureNow)
}

/** 布局变化（懒加载、SPA 切换）不触发 resize，延迟再量一次。 */
function scheduleMeasureSoon(): void {
  if (measureTimer !== null) return
  measureTimer = window.setTimeout(() => {
    measureTimer = null
    scheduleMeasure()
  }, 250)
}

function onWheel(event: WheelEvent): void {
  // 触控板捏合会以 ctrlKey 的 wheel 事件出现，别吃掉缩放
  if (event.ctrlKey || event.metaKey) return
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
  const shiftWheel = event.shiftKey && event.deltaX === 0 && event.deltaY !== 0
  if (!horizontal && !shiftWheel) return
  if (insideHorizontalScroller(event.target)) return

  const el = pageScroller()
  if (el.scrollWidth <= el.clientWidth + MIN_HORIZONTAL_OVERFLOW) return

  enablePageScroll()
  const delta = horizontal ? event.deltaX : event.deltaY
  if (!delta) return
  el.scrollLeft += delta
  // 到边缘也拦住：宁可不动，也别误触"前后退"的页面滑动
  event.preventDefault()
  scheduleMeasure()
}

function startHorizontalFallback(): void {
  if (window.top !== window) return
  window.addEventListener('wheel', onWheel, { capture: true, passive: false })
  window.addEventListener('scroll', scheduleMeasure, { capture: true, passive: true })
  window.addEventListener('resize', scheduleMeasure, { passive: true })
  window.addEventListener('load', scheduleMeasure)

  if (typeof MutationObserver !== 'undefined' && document.body) {
    new MutationObserver(scheduleMeasureSoon).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    })
  }

  // 图片/字体加载完成后宽度可能才定下来
  scheduleMeasure()
  setTimeout(scheduleMeasure, 400)
  setTimeout(scheduleMeasure, 1200)
  setTimeout(scheduleMeasure, 3000)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startHorizontalFallback, { once: true })
} else {
  startHorizontalFallback()
}
