import type { ImageSearchFailureReason, ImageSearchStage } from '../../shared/image-search'
import type { ImageSearchAdapter } from './engines'

export class ImageSearchError extends Error {
  constructor(
    readonly reason: ImageSearchFailureReason,
    message: string
  ) {
    super(message)
    this.name = 'ImageSearchError'
  }
}

export interface InjectOptions {
  /** 用户取消或开始下一次搜索后返回 true，所有等待都会尽快退出 */
  isCancelled: () => boolean
  /** 上传已经发出、开始等结果时通知界面 */
  onStage?: (stage: ImageSearchStage) => void
}

/** 本地轮询，120ms 足够跟手，也不至于空转。 */
const POLL_MS = 120
/** 页面稳定后再给上传入口一点出现时间；点空了下一轮还会重试。 */
const PANEL_SETTLE_MS = 120
/**
 * 页面必须连续稳定这么久才注入，避开跳转中途的旧文档。
 * 有 entryUrl 的站点（Google）跳转更多，多等一会儿；其余站点页面早就完成加载了。
 */
const settleMsFor = (adapter: ImageSearchAdapter): number => (adapter.entryUrl ? 600 : 250)

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function evaluate<T>(wc: Electron.WebContents, script: string): Promise<T> {
  return (await wc.executeJavaScript(script)) as T
}

/** 页面跳转期间 executeJavaScript 会抛「context destroyed」，这时按"还没准备好"处理。 */
async function safeEvaluate<T>(wc: Electron.WebContents, script: string): Promise<T | null> {
  try {
    return await evaluate<T>(wc, script)
  } catch {
    return null
  }
}

/**
 * 等页面真正稳定：readyState 完成、URL 连续一小段时间不变、并且已经落到入口页。
 *
 * 只等 readyState 会踩到跳转中途的旧文档——Google 从 lens.google.com 跳到
 * google.com/?olud 时，旧页面上也有一个 encoded_image 文件框，注入进去页面不会响应。
 */
async function waitForPageReady(
  wc: Electron.WebContents,
  adapter: ImageSearchAdapter,
  options: InjectOptions
): Promise<void> {
  const entryPattern = adapter.entryUrl ? new RegExp(adapter.entryUrl) : null
  const settleMs = settleMsFor(adapter)
  const started = Date.now()
  let lastUrl = ''
  let stableSince = 0

  while (Date.now() - started < adapter.findTimeoutMs) {
    if (options.isCancelled()) throw new ImageSearchError('cancelled', '已取消')
    if (wc.isDestroyed()) throw new ImageSearchError('network', '页面已经关闭')

    const url = wc.getURL()
    const ready = await safeEvaluate<boolean>(wc, 'document.readyState === "complete"')
    // 复用标签时旧页面可能还停在原地址；isLoading 兜住"新导航刚要开始"的瞬间
    const settled =
      ready === true && !wc.isLoading() && url.length > 0 && (!entryPattern || entryPattern.test(url))
    if (settled && url === lastUrl) {
      if (stableSince === 0) stableSince = Date.now()
      if (Date.now() - stableSince >= settleMs) return
    } else {
      lastUrl = url
      stableSince = settled ? Date.now() : 0
    }
    await delay(POLL_MS)
  }
  throw new ImageSearchError('network', '页面加载超时')
}

/**
 * 登录态体检：页面停在登录地址，或首页上还摆着「登录」按钮，就别再等 12–30 秒。
 *
 * 只对 requiresLogin 的站点做，且只认可见的按钮/链接，避免页脚文字误判。
 */
const LOGIN_URL = /(?:^|\/)(?:login|signin|sign-in|accounts\/login)(?:[/?#]|$)/i

async function looksLoggedOut(wc: Electron.WebContents): Promise<boolean> {
  if (LOGIN_URL.test(wc.getURL())) return true
  return (
    (await safeEvaluate<boolean>(
      wc,
      `(() => {
        const wanted = ['登录', '登 录', 'Log in', 'Sign in', '登录/注册']
        return [...document.querySelectorAll('a, button, [role=button]')].some((node) => {
          const rect = node.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return false
          return wanted.includes((node.textContent || '').trim())
        })
      })()`
    )) === true
  )
}

function attachDebugger(wc: Electron.WebContents): void {
  if (wc.debugger.isAttached()) return
  try {
    wc.debugger.attach('1.3')
  } catch {
    throw new ImageSearchError('debugger-busy', '开发者工具占用了调试端口，关掉后再试')
  }
}

async function nodeFor(wc: Electron.WebContents, selector: string): Promise<number | null> {
  const { root } = (await wc.debugger.sendCommand('DOM.getDocument', { depth: 1 })) as {
    root: { nodeId: number }
  }
  const { nodeId } = (await wc.debugger.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId,
    selector
  })) as { nodeId: number }
  return nodeId > 0 ? nodeId : null
}

/** 真实鼠标点击：站点有时不认 `node.click()`。 */
async function clickAt(wc: Electron.WebContents, selector: string, text?: string): Promise<boolean> {
  const point = await evaluate<{ x: number; y: number } | null>(
    wc,
    `(() => {
      const selector = ${JSON.stringify(selector)}
      const wanted = ${JSON.stringify(text ?? null)}
      let node = selector ? document.querySelector(selector) : null
      if (!node && wanted) {
        node = [...document.querySelectorAll('button, [role=button], a, label')].find((candidate) => {
          const rect = candidate.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return false
          return (candidate.textContent || '').trim().includes(wanted)
        })
      }
      if (!node) return null
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`
  )
  if (!point) return false
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return true
}

/**
 * 找可注入的文件框：先看页面上有没有现成的，没有就点相机/上传入口，再等它出现。
 *
 * 每一步都必须有上限；站点改版时宁可报 engine-changed，也不无限等待。
 */
async function findFileInput(
  wc: Electron.WebContents,
  adapter: ImageSearchAdapter,
  options: InjectOptions
): Promise<number> {
  const started = Date.now()
  let clicked = false

  while (Date.now() - started < adapter.findTimeoutMs) {
    if (options.isCancelled()) throw new ImageSearchError('cancelled', '已取消')

    const urlBefore = wc.getURL()
    for (const selector of adapter.fileInput.selectors) {
      let nodeId: number | null = null
      try {
        nodeId = await nodeFor(wc, selector)
      } catch {
        // 正好赶上跳转，下一轮再看
        nodeId = null
      }
      if (!nodeId) continue
      // 命中后再确认一次：节点还在当前文档里，且页面没在查询期间跳走
      await delay(60)
      const connected = await safeEvaluate<boolean>(
        wc,
        `!!document.querySelector(${JSON.stringify(selector)})`
      )
      if (connected === true && wc.getURL() === urlBefore) return nodeId
    }

    if (!clicked && adapter.openUpload) {
      await delay(PANEL_SETTLE_MS)
      for (const selector of adapter.openUpload.selectors) {
        if (await clickAt(wc, selector)) {
          clicked = true
          break
        }
      }
      if (!clicked) {
        for (const text of adapter.openUpload.texts ?? []) {
          if (await clickAt(wc, '', text)) {
            clicked = true
            break
          }
        }
      }
    }

    await delay(POLL_MS)
  }

  throw new ImageSearchError(
    adapter.requiresLogin && !clicked ? 'login-required' : 'engine-changed',
    adapter.requiresLogin && !clicked ? '需要先登录，入口还没出现' : '页面结构变了，找不到上传入口'
  )
}

async function waitForResult(
  wc: Electron.WebContents,
  adapter: ImageSearchAdapter,
  options: InjectOptions
): Promise<void> {
  const urlPattern = adapter.result.url ? new RegExp(adapter.result.url) : null
  const started = Date.now()

  while (Date.now() - started < adapter.resultTimeoutMs) {
    if (options.isCancelled()) throw new ImageSearchError('cancelled', '已取消')
    if (wc.isDestroyed()) throw new ImageSearchError('network', '结果页已经关闭')

    if (urlPattern && urlPattern.test(wc.getURL())) return
    for (const selector of adapter.result.dom ?? []) {
      const found = await safeEvaluate<boolean>(wc, `!!document.querySelector(${JSON.stringify(selector)})`)
      if (found === true) return
    }
    await delay(POLL_MS)
  }

  if (adapter.requiresLogin) {
    throw new ImageSearchError('login-required', '等了 30 秒没有结果，可能需要先登录')
  }
  throw new ImageSearchError('timeout', '等了 30 秒没有出结果，可以在侧栏手动完成')
}

/**
 * 粘贴兜底：打开站点的上传入口并聚焦粘贴区。
 *
 * 不做自动 ⌘V——焦点和剪贴板都不可控；只把用户要按 ⌘V 的位置准备好。
 */
export async function preparePasteSurface(
  wc: Electron.WebContents,
  adapter: ImageSearchAdapter,
  options: InjectOptions
): Promise<void> {
  try {
    await waitForPageReady(wc, adapter, options)
  } catch {
    return
  }
  if (options.isCancelled()) return
  if (adapter.openUpload) {
    await delay(PANEL_SETTLE_MS)
    for (const selector of adapter.openUpload.selectors) {
      if (await clickAt(wc, selector)) break
    }
    for (const text of adapter.openUpload.texts ?? []) {
      if (await clickAt(wc, '', text)) break
    }
    await delay(PANEL_SETTLE_MS)
  }
  for (const selector of adapter.paste.focusSelectors) {
    const focused = await evaluate<boolean>(
      wc,
      `(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        if (!node) return false
        node.focus()
        return document.activeElement === node
      })()`
    )
    if (focused) break
  }
}

/** 打开站点后，把图片塞进文件框，并等结果页出现。 */
export async function injectImage(
  wc: Electron.WebContents,
  adapter: ImageSearchAdapter,
  filePath: string,
  options: InjectOptions
): Promise<void> {
  attachDebugger(wc)
  try {
    await wc.debugger.sendCommand('DOM.enable')
    await waitForPageReady(wc, adapter, options)
    if (adapter.requiresLogin && (await looksLoggedOut(wc))) {
      throw new ImageSearchError('login-required', '需要先登录')
    }
    const nodeId = await findFileInput(wc, adapter, options)
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId })
    options.onStage?.('waiting')
    await waitForResult(wc, adapter, options)
  } finally {
    if (wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // 页面已经先关掉了
      }
    }
  }
}
