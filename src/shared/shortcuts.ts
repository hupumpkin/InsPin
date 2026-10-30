/**
 * 可改键的快捷键：定义、解析、匹配与显示。
 *
 * 存下来的格式是稳定的 ASCII 组合（如 `Shift+Meta+Z`），显示时才换成 macOS
 * 的符号（`⇧⌘Z`）。主进程只负责保存，不关心它是怎么按的；界面和画布共用这里的
 * 匹配函数，保证"设置页显示什么、实际就响应什么"。
 */

import { currentPlatform, type Platform } from './platform'

export type ShortcutAction =
  | 'commandPalette'
  | 'toggleBrowser'
  | 'toggleLayers'
  | 'toolSelect'
  | 'toolHand'
  | 'undo'
  | 'redo'
  | 'delete'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'copyToApps'
  | 'renameLayer'
  | 'toggleLayerVisibility'
  | 'toggleLayerLock'
  | 'autoLayout'
  | 'removeAutoLayout'
  | 'group'
  | 'ungroup'
  | 'layerForward'
  | 'layerBackward'
  | 'layerFront'
  | 'layerBack'
  | 'smartCollect'
  | 'toggleCollectMode'
  | 'newTab'

export type ShortcutBindings = Record<ShortcutAction, string | null>

/**
 * 鼠标中键的存储写法。和键盘共用一个字段，所以仍然能带修饰键
 * （例如 `Alt+MouseMiddle`），设置页与实际响应也就不用两套数据。
 */
export const MOUSE_MIDDLE = 'MouseMiddle'

const MOUSE_KEYS = new Set([MOUSE_MIDDLE])

/** 这个绑定是不是鼠标动作（而不是键盘组合）。 */
export function isMouseAccelerator(accelerator: string | null | undefined): boolean {
  const parsed = parseAccelerator(accelerator)
  return parsed !== null && MOUSE_KEYS.has(parsed.key)
}

/** 有些动作只由某个面板的键盘监听处理，绑定鼠标也不会触发，录制时要挡住。 */
export function supportsMouseBinding(action: ShortcutAction): boolean {
  // 切换采集模式只在采集进行中有效，绑到中键容易在别的场景误触。
  return action !== 'renameLayer' && action !== 'toggleCollectMode'
}

export interface ShortcutDefinition {
  action: ShortcutAction
  label: string
  group: string
  defaultAccelerator: string
  hint?: string
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { action: 'commandPalette', label: '命令面板', group: '项目与面板', defaultAccelerator: 'Meta+K' },
  { action: 'toggleBrowser', label: '打开 / 收起浏览器', group: '项目与面板', defaultAccelerator: 'Tab' },
  { action: 'toggleLayers', label: '打开 / 收起图层', group: '项目与面板', defaultAccelerator: 'Meta+Alt+L' },
  { action: 'toolSelect', label: '选择工具', group: '工具', defaultAccelerator: 'V' },
  { action: 'toolHand', label: '抓手工具', group: '工具', defaultAccelerator: 'H' },
  { action: 'undo', label: '撤销', group: '编辑', defaultAccelerator: 'Meta+Z' },
  { action: 'redo', label: '重做', group: '编辑', defaultAccelerator: 'Shift+Meta+Z' },
  { action: 'delete', label: '删除选中', group: '编辑', defaultAccelerator: 'Backspace' },
  { action: 'copy', label: '复制画布对象', group: '编辑', defaultAccelerator: 'Meta+C' },
  { action: 'cut', label: '剪切画布对象', group: '编辑', defaultAccelerator: 'Meta+X' },
  { action: 'paste', label: '粘贴画布对象 / 图片', group: '编辑', defaultAccelerator: 'Meta+V' },
  { action: 'duplicate', label: '创建副本', group: '编辑', defaultAccelerator: 'Meta+D' },
  { action: 'copyToApps', label: '复制到其他软件', group: '编辑', defaultAccelerator: 'Shift+Meta+C' },
  { action: 'renameLayer', label: '重命名图层', group: '编辑', defaultAccelerator: 'Meta+R' },
  { action: 'toggleLayerVisibility', label: '显示 / 隐藏图层', group: '编辑', defaultAccelerator: 'Shift+Meta+H' },
  { action: 'toggleLayerLock', label: '锁定 / 解锁图层', group: '编辑', defaultAccelerator: 'Shift+Meta+L' },
  { action: 'autoLayout', label: '套上自动布局', group: '布局', defaultAccelerator: 'Shift+A' },
  { action: 'removeAutoLayout', label: '移除自动布局', group: '布局', defaultAccelerator: 'Alt+Shift+A' },
  { action: 'group', label: '编组', group: '布局', defaultAccelerator: 'Meta+G' },
  { action: 'ungroup', label: '取消编组', group: '布局', defaultAccelerator: 'Shift+Meta+G' },
  { action: 'layerForward', label: '上移一层', group: '布局', defaultAccelerator: 'Meta+]' },
  { action: 'layerBackward', label: '下移一层', group: '布局', defaultAccelerator: 'Meta+[' },
  { action: 'layerFront', label: '置于顶层', group: '布局', defaultAccelerator: 'Alt+Meta+]' },
  { action: 'layerBack', label: '置于底层', group: '布局', defaultAccelerator: 'Alt+Meta+[' },
  { action: 'smartCollect', label: '智能采集', group: '浏览器', defaultAccelerator: 'Meta+1' },
  {
    action: 'toggleCollectMode',
    label: '切换锁定 / 滚动屏幕',
    group: '浏览器',
    defaultAccelerator: 'Shift+Meta+M',
    hint: '仅在智能采集进行中生效'
  },
  { action: 'newTab', label: '新建浏览器标签', group: '浏览器', defaultAccelerator: 'Meta+T' }
] as const

export const DEFAULT_SHORTCUTS: ShortcutBindings = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.action, definition.defaultAccelerator])
) as ShortcutBindings

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

interface ParsedAccelerator {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

/** 键盘事件只用到这几个字段，测试里不用造一个完整的 KeyboardEvent。 */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const NAMED_KEYS = new Set([
  'Backspace',
  'Delete',
  'Enter',
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert'
])

/** 这些键单独按没有意义，不能成为快捷键（只按修饰键、Esc 留给"取消"）。 */
const RESERVED_KEYS = new Set([
  'Meta',
  'Control',
  'Alt',
  'Shift',
  'CapsLock',
  'Dead',
  'Escape',
  'Space'
])

/** 把事件的 key 归一成存储格式；不是可绑定的键时返回 null。 */
export function keyFromEvent(event: Pick<KeyEventLike, 'key'>): string | null {
  const key = event.key
  if (!key || key === 'Unidentified' || key === ' ') return null
  if (RESERVED_KEYS.has(key)) return null
  if (key.length === 1) {
    // 字母统一成大写：按 Shift 时 event.key 本来就是大写，避免同一次按键存出两种写法。
    return /[a-z]/i.test(key) ? key.toUpperCase() : key
  }
  if (key === 'Del') return 'Delete'
  return NAMED_KEYS.has(key) ? key : null
}

/** 一次按键 → 存储格式；只按了修饰键时返回 null。 */
export function acceleratorFromEvent(event: KeyEventLike): string | null {
  const key = keyFromEvent(event)
  if (!key) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

export function parseAccelerator(accelerator: string | null | undefined): ParsedAccelerator | null {
  if (typeof accelerator !== 'string' || accelerator.trim() === '') return null
  const parts = accelerator.split('+')
  const key = parts.pop()
  if (!key) return null
  const parsed: ParsedAccelerator = { ctrl: false, alt: false, shift: false, meta: false, key }
  for (const part of parts) {
    if (!MODIFIER_ORDER.includes(part as Modifier)) return null
    if (part === 'Ctrl') parsed.ctrl = true
    if (part === 'Alt') parsed.alt = true
    if (part === 'Shift') parsed.shift = true
    if (part === 'Meta') parsed.meta = true
  }
  // 存进来的键也必须是我们认识的；否则界面上显示得出、实际按不出来。
  if (MOUSE_KEYS.has(parsed.key)) return parsed
  if (!keyFromEvent({ key: parsed.key === 'Delete' ? 'Delete' : parsed.key })) return null
  return parsed
}

function sameKey(a: string, b: string): boolean {
  if (a === b) return true
  // Mac 键盘上这两个物理键都写作删除；绑定其中一个时两个都认。
  return (a === 'Backspace' || a === 'Delete') && (b === 'Backspace' || b === 'Delete')
}

/** 鼠标事件只用到这几个字段，测试里不用造一个完整的 MouseEvent。 */
export interface MouseEventLike {
  /** 0 = 左键，1 = 中键，2 = 右键 */
  button: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * 一次鼠标按下 → 存储格式。目前只把中键当作可绑定动作：
 * 左键是画布/面板的正常交互，右键留给上下文菜单，绑上去只会互相打架。
 */
export function acceleratorFromMouseEvent(event: MouseEventLike): string | null {
  if (event.button !== 1) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(MOUSE_MIDDLE)
  return parts.join('+')
}

/** 两个已存格式是不是同一个组合（键盘与鼠标都适用）。 */
export function sameAccelerator(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseAccelerator(a)
  const right = parseAccelerator(b)
  if (!left || !right) return false
  return (
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta &&
    sameKey(left.key, right.key)
  )
}

/** 这次按键是不是这个快捷键。留空（null）的绑定永远不匹配。 */
export function matchesAccelerator(event: KeyEventLike, accelerator: string | null): boolean {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return false
  const key = keyFromEvent(event)
  if (!key) return false
  return (
    parsed.ctrl === event.ctrlKey &&
    parsed.alt === event.altKey &&
    parsed.shift === event.shiftKey &&
    parsed.meta === event.metaKey &&
    sameKey(parsed.key, key)
  )
}

/**
 * Windows / Linux 没有 ⌘。存储层仍然用 `Meta` 表示"主修饰键"，
 * 读设置时统一换成 `Ctrl`——这样匹配、录制和浏览器 preload 都不用改。
 */
function toPlatformAccelerator(accelerator: string, platform: Platform): string {
  if (platform === 'darwin') return accelerator
  return accelerator
    .split('+')
    .map((part) => (part === 'Meta' ? 'Ctrl' : part))
    .join('+')
}

const KEY_LABELS: Record<string, string> = {
  Backspace: '⌫',
  Delete: '⌫',
  Enter: '↩',
  Tab: '⇥',
  Space: '空格',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
  [MOUSE_MIDDLE]: '中键'
}

/** Windows / Linux 的键名：不用 mac 的符号字。 */
const KEY_LABELS_WIN: Record<string, string> = {
  Backspace: 'Del',
  Delete: 'Del',
  Enter: 'Enter',
  Tab: 'Tab',
  Space: '空格',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  [MOUSE_MIDDLE]: '中键'
}

/** 当前按住的修饰键，用于录制过程中的实时预览。 */
export type HeldModifiers = Pick<ParsedAccelerator, 'ctrl' | 'alt' | 'shift' | 'meta'>

/** 按住的修饰键 → 逐颗键帽文本（顺序与存储格式一致）。 */
export function modifierLabels(
  held: HeldModifiers,
  platform: Platform = currentPlatform()
): string[] {
  if (platform === 'darwin') {
    const parts: string[] = []
    if (held.ctrl) parts.push('⌃')
    if (held.alt) parts.push('⌥')
    if (held.shift) parts.push('⇧')
    if (held.meta) parts.push('⌘')
    return parts
  }
  const parts: string[] = []
  if (held.ctrl) parts.push('Ctrl')
  if (held.alt) parts.push('Alt')
  if (held.shift) parts.push('Shift')
  if (held.meta) parts.push('Win')
  return parts
}

/**
 * 存储格式 → 逐颗键帽文本。设置页把每个键帽单独画出来，
 * 组合键比一串连写更容易一眼看清。
 */
export function formatAcceleratorParts(
  accelerator: string | null,
  platform: Platform = currentPlatform()
): string[] {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return []
  const labels = platform === 'darwin' ? KEY_LABELS : KEY_LABELS_WIN
  return [...modifierLabels(parsed, platform), labels[parsed.key] ?? parsed.key.toUpperCase()]
}

/** 存储格式 → 给用户看的组合（mac 用 ⌃⌥⇧⌘，Windows 用 Ctrl+Alt+Shift）。 */
export function formatAccelerator(
  accelerator: string | null,
  platform: Platform = currentPlatform()
): string {
  const parts = formatAcceleratorParts(accelerator, platform)
  if (parts.length === 0) return '未设置'
  return platform === 'darwin' ? parts.join('') : parts.join('+')
}

/** 某个组合是否和别的动作撞了；撞了返回那个动作。 */
export function shortcutConflict(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  accelerator: string,
  definitions: readonly ShortcutDefinition[] = SHORTCUT_DEFINITIONS
): ShortcutDefinition | null {
  if (!parseAccelerator(accelerator)) return null
  for (const definition of definitions) {
    if (definition.action === action) continue
    if (sameAccelerator(accelerator, bindings[definition.action])) return definition
  }
  return null
}

export interface ReservedShortcut {
  accelerator: string
  label: string
}

/**
 * 常见系统快捷键。这里只列"能录进 InsPin 的组合"——Esc、空格这类本来
 * 就不允许绑定的键不出现，免得给出永远不会触发的提醒。
 */
const SYSTEM_SHORTCUTS: Record<Platform, readonly ReservedShortcut[]> = {
  darwin: [
    { accelerator: 'Meta+Tab', label: '切换应用' },
    { accelerator: 'Meta+Q', label: '退出应用' },
    { accelerator: 'Meta+W', label: '关闭窗口' },
    { accelerator: 'Meta+H', label: '隐藏应用' },
    { accelerator: 'Meta+M', label: '最小化窗口' },
    { accelerator: 'Meta+`', label: '切换同一应用的窗口' },
    { accelerator: 'Ctrl+Meta+F', label: '进入全屏' },
    { accelerator: 'Shift+Meta+3', label: '截取整个屏幕' },
    { accelerator: 'Shift+Meta+4', label: '截取所选区域' },
    { accelerator: 'Shift+Meta+5', label: '截屏与录屏面板' },
    { accelerator: 'Ctrl+Meta+Q', label: '锁定屏幕' },
    { accelerator: 'Ctrl+ArrowUp', label: '调度中心' },
    { accelerator: 'Ctrl+ArrowDown', label: '应用窗口' },
    { accelerator: 'Ctrl+ArrowLeft', label: '向左切换空间' },
    { accelerator: 'Ctrl+ArrowRight', label: '向右切换空间' },
    { accelerator: 'Shift+Meta+Q', label: '退出登录' },
    { accelerator: 'Meta+,', label: '打开设置（InsPin 菜单）' },
    { accelerator: 'Shift+Meta+,', label: '打开快捷键设置（InsPin 菜单）' }
  ],
  win32: [
    // Windows 键组合（Win+D / Win+L 等）目前进不了 InsPin 的存储格式
    // （Windows 上主修饰键统一记作 Ctrl），这里只列真正能撞上的系统组合。
    { accelerator: 'Alt+Tab', label: '切换应用' },
    { accelerator: 'Ctrl+Alt+Delete', label: '安全选项' },
    { accelerator: 'Ctrl+,', label: '打开设置（InsPin 菜单）' },
    { accelerator: 'Shift+Ctrl+,', label: '打开快捷键设置（InsPin 菜单）' }
  ],
  linux: [
    { accelerator: 'Ctrl+Alt+T', label: '打开终端' },
    { accelerator: 'Ctrl+Alt+ArrowLeft', label: '向左切换工作区' },
    { accelerator: 'Ctrl+Alt+ArrowRight', label: '向右切换工作区' },
    { accelerator: 'Ctrl+,', label: '打开设置（InsPin 菜单）' },
    { accelerator: 'Shift+Ctrl+,', label: '打开快捷键设置（InsPin 菜单）' }
  ]
}

export function reservedShortcuts(
  platform: Platform = currentPlatform()
): readonly ReservedShortcut[] {
  return SYSTEM_SHORTCUTS[platform] ?? []
}

/** 这个组合是否被常见系统快捷键占用。 */
export function reservedShortcutConflict(
  accelerator: string | null | undefined,
  platform: Platform = currentPlatform()
): ReservedShortcut | null {
  if (!parseAccelerator(accelerator)) return null
  return (
    reservedShortcuts(platform).find((reserved) =>
      sameAccelerator(accelerator, reserved.accelerator)
    ) ?? null
  )
}

export interface ShortcutConflict {
  action: ShortcutAction
  label: string
  accelerator: string
  /** 冲突的另一方：另一个动作，或被占用的系统快捷键。 */
  otherLabel: string
  source: 'duplicate' | 'system'
}

/**
 * 一次算出当前配置里所有值得提醒的冲突：两个动作重复，或被常见系统快捷键占用。
 * 设置页顶部的检测条用它；录制时仍然单独拦截，不让冲突值写进配置。
 */
export function shortcutConflicts(
  bindings: ShortcutBindings,
  platform: Platform = currentPlatform()
): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = []
  for (let index = 0; index < SHORTCUT_DEFINITIONS.length; index += 1) {
    const definition = SHORTCUT_DEFINITIONS[index]!
    const accelerator = bindings[definition.action]
    if (!accelerator) continue

    for (let other = index + 1; other < SHORTCUT_DEFINITIONS.length; other += 1) {
      const candidate = SHORTCUT_DEFINITIONS[other]!
      if (sameAccelerator(accelerator, bindings[candidate.action])) {
        conflicts.push({
          action: definition.action,
          label: definition.label,
          accelerator,
          otherLabel: candidate.label,
          source: 'duplicate'
        })
      }
    }

    const reserved = reservedShortcutConflict(accelerator, platform)
    if (reserved) {
      conflicts.push({
        action: definition.action,
        label: definition.label,
        accelerator,
        otherLabel: reserved.label,
        source: 'system'
      })
    }
  }
  return conflicts
}

/**
 * 读回存过的快捷键：坏数据回到默认；互相撞车的条目宁可留空，也不让两个动作同时触发。
 *
 * 非 macOS 会在这一步把 `Meta` 换成 `Ctrl`。之后界面显示、键盘匹配、
 * 浏览器 preload 里的中键组合都用同一份 `Ctrl+…`，不需要各自判断平台。
 */
export function normalizeShortcutBindings(
  raw: unknown,
  platform: Platform = currentPlatform()
): ShortcutBindings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const result = {} as ShortcutBindings
  const used = new Set<string>()
  for (const definition of SHORTCUT_DEFINITIONS) {
    const custom = source[definition.action]
    const fallback = toPlatformAccelerator(definition.defaultAccelerator, platform)
    let candidate =
      typeof custom === 'string' && parseAccelerator(custom)
        ? toPlatformAccelerator(custom, platform)
        : fallback
    if (used.has(candidate)) {
      candidate = used.has(fallback) ? '' : fallback
    }
    if (candidate && used.has(candidate)) candidate = ''
    result[definition.action] = candidate || null
    if (candidate) used.add(candidate)
  }
  return result
}

/** 这个绑定还是出厂默认吗（用于显示"恢复默认"）。 */
export function isDefaultShortcut(
  action: ShortcutAction,
  accelerator: string | null,
  platform: Platform = currentPlatform()
): boolean {
  return defaultShortcut(action, platform) === accelerator
}

export function defaultShortcut(
  action: ShortcutAction,
  platform: Platform = currentPlatform()
): string {
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.action === action)
  return definition ? toPlatformAccelerator(definition.defaultAccelerator, platform) : ''
}
