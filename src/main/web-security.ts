import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, Session } from 'electron'

/**
 * 第三方网页零权限：摄像头、麦克风、定位、通知、蓝牙、USB、串口等一律拒绝。
 * 全屏和「复制后写剪贴板」是正常浏览需要的能力，且不涉及隐私数据。
 */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

export function hardenThirdPartySession(sess: Session): void {
  sess.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  sess.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
}

export interface IpcSenderGuardOptions {
  /** 开发模式下界面的地址；生产传 null */
  rendererUrl: string | null
  /** 允许第三方网页自己发起的频道：目前只有智能采集的点击坐标 */
  webPageChannels?: ReadonlySet<string>
}

const RENDERER_PAGES = new Set(['/', '/index.html', '/snapshot.html', '/snapshot-menu.html'])

/** 只有打包进 out/renderer 的本地页面，或开发服务器上的同名页面，才算可信界面。 */
export function isTrustedRendererUrl(raw: string, rendererUrl: string | null): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (url.protocol === 'file:') {
    const path = decodeURIComponent(url.pathname)
    return /\/out\/renderer\/(?:index|snapshot|snapshot-menu)\.html$/.test(path)
  }

  if (!rendererUrl) return false
  try {
    const dev = new URL(rendererUrl)
    if (url.origin !== dev.origin) return false
    return RENDERER_PAGES.has(url.pathname)
  } catch {
    return false
  }
}

/**
 * 给 ipcMain 全局加一道来源校验：只有 InsPin 自己的界面能读写文件、数据库和素材。
 *
 * 在注册任何 handler 之前调用，之后 `ipcMain.handle/on` 都会被包一层。第三方网页
 * 即使拿到 preload 里的接口，发出的请求也会被丢弃。智能采集的点击是唯一例外，
 * 它的 handler 自己会核对「发送者是不是当前激活的网页」。
 */
export function installIpcSenderGuard(ipc: IpcMain, options: IpcSenderGuardOptions): void {
  const webPageChannels = options.webPageChannels ?? new Set<string>()
  const allows = (channel: string, event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    if (webPageChannels.has(channel)) return true
    const frame = event.senderFrame
    return frame ? isTrustedRendererUrl(frame.url, options.rendererUrl) : false
  }

  const originalHandle = ipc.handle.bind(ipc)
  ipc.handle = ((channel: string, listener: (...args: any[]) => unknown) =>
    originalHandle(channel, (event, ...args) => {
      if (!allows(channel, event)) throw new Error(`拒绝来自非 InsPin 界面的请求：${channel}`)
      return listener(event, ...args)
    })) as typeof ipc.handle

  const originalOn = ipc.on.bind(ipc)
  ipc.on = ((channel: string, listener: (...args: any[]) => void) =>
    originalOn(channel, (event, ...args) => {
      if (!allows(channel, event)) return
      listener(event, ...args)
    })) as typeof ipc.on
}
