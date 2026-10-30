/**
 * 平台判断与用户可见文案。
 *
 * 主进程直接用 `process.platform`；沙箱渲染层没有 `process`，退回
 * `navigator.userAgent`。测试跑在 Node 里，所以两边都能用。
 */

export type Platform = 'darwin' | 'win32' | 'linux'

export function currentPlatform(): Platform {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    if (process.platform === 'darwin') return 'darwin'
    if (process.platform === 'win32') return 'win32'
    return 'linux'
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent
    if (/Windows/i.test(ua)) return 'win32'
    if (/Mac/i.test(ua)) return 'darwin'
  }
  return 'linux'
}

export function isMacPlatform(platform: Platform = currentPlatform()): boolean {
  return platform === 'darwin'
}

/** 主修饰键：mac 是 ⌘，Windows / Linux 是 Ctrl。 */
export function primaryModifierLabel(platform: Platform = currentPlatform()): string {
  return isMacPlatform(platform) ? '⌘' : 'Ctrl'
}

export function shiftLabel(platform: Platform = currentPlatform()): string {
  return isMacPlatform(platform) ? '⇧' : 'Shift'
}

/** 文件管理器的名字，用在按钮和提示里。 */
export function fileManagerName(platform: Platform = currentPlatform()): string {
  return isMacPlatform(platform) ? '访达' : '资源管理器'
}

export function revealInFileManagerLabel(platform: Platform = currentPlatform()): string {
  return isMacPlatform(platform) ? '在访达中显示' : '在资源管理器中显示'
}

export function openFileManagerLabel(platform: Platform = currentPlatform()): string {
  return isMacPlatform(platform) ? '打开访达' : '打开资源管理器'
}
