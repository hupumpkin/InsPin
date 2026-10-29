import { describe, expect, it } from 'vitest'
import {
  acceleratorFromEvent,
  acceleratorFromMouseEvent,
  DEFAULT_SHORTCUTS,
  formatAccelerator,
  isDefaultShortcut,
  isMouseAccelerator,
  matchesAccelerator,
  normalizeShortcutBindings,
  parseAccelerator,
  sameAccelerator,
  shortcutConflict,
  supportsMouseBinding,
  type KeyEventLike,
  type MouseEventLike
} from './shortcuts'

function key(key: string, modifiers: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers
  }
}

describe('acceleratorFromEvent', () => {
  it('把 Command 组合写成稳定格式', () => {
    expect(acceleratorFromEvent(key('k', { metaKey: true }))).toBe('Meta+K')
  })

  it('Shift 字母只存一份大写，不因键盘状态写出两种值', () => {
    expect(acceleratorFromEvent(key('A', { shiftKey: true }))).toBe('Shift+A')
    expect(acceleratorFromEvent(key('a', { shiftKey: true }))).toBe('Shift+A')
  })

  it('单键快捷键也能存（V / H / Tab）', () => {
    expect(acceleratorFromEvent(key('v'))).toBe('V')
    expect(acceleratorFromEvent(key('Tab'))).toBe('Tab')
  })

  it('只按修饰键不产生绑定', () => {
    expect(acceleratorFromEvent(key('Meta', { metaKey: true }))).toBeNull()
  })

  it('Esc 和空格留给应用自己的行为', () => {
    expect(acceleratorFromEvent(key('Escape'))).toBeNull()
    expect(acceleratorFromEvent(key(' '))).toBeNull()
  })
})

describe('matchesAccelerator', () => {
  it('修饰键必须完全一致', () => {
    expect(matchesAccelerator(key('k', { metaKey: true }), 'Meta+K')).toBe(true)
    expect(matchesAccelerator(key('k', { metaKey: true, shiftKey: true }), 'Meta+K')).toBe(false)
    expect(matchesAccelerator(key('k'), 'Meta+K')).toBe(false)
  })

  it('Mac 的 Backspace / Delete 视为同一个删除键', () => {
    expect(matchesAccelerator(key('Delete'), 'Backspace')).toBe(true)
    expect(matchesAccelerator(key('Backspace'), 'Delete')).toBe(true)
  })

  it('留空的绑定永远不触发', () => {
    expect(matchesAccelerator(key('k', { metaKey: true }), null)).toBe(false)
  })
})

describe('formatAccelerator', () => {
  it('显示成 macOS 的符号顺序', () => {
    expect(formatAccelerator('Shift+Meta+Z')).toBe('⇧⌘Z')
    expect(formatAccelerator('Meta+Alt+L')).toBe('⌥⌘L')
    expect(formatAccelerator('Backspace')).toBe('⌫')
    expect(formatAccelerator('Tab')).toBe('⇥')
  })

  it('坏值显示为未设置', () => {
    expect(formatAccelerator('Nope')).toBe('未设置')
  })
})

describe('Figma 图层快捷键', () => {
  it('使用 Figma 官方的默认组合', () => {
    expect(DEFAULT_SHORTCUTS.renameLayer).toBe('Meta+R')
    expect(DEFAULT_SHORTCUTS.duplicate).toBe('Meta+D')
    expect(DEFAULT_SHORTCUTS.cut).toBe('Meta+X')
    expect(DEFAULT_SHORTCUTS.toggleLayerVisibility).toBe('Shift+Meta+H')
    expect(DEFAULT_SHORTCUTS.toggleLayerLock).toBe('Shift+Meta+L')
    expect(DEFAULT_SHORTCUTS.autoLayout).toBe('Shift+A')
    expect(DEFAULT_SHORTCUTS.removeAutoLayout).toBe('Alt+Shift+A')
    expect(DEFAULT_SHORTCUTS.group).toBe('Meta+G')
    expect(DEFAULT_SHORTCUTS.ungroup).toBe('Shift+Meta+G')
    expect(DEFAULT_SHORTCUTS.layerForward).toBe('Meta+]')
    expect(DEFAULT_SHORTCUTS.layerBackward).toBe('Meta+[')
    expect(DEFAULT_SHORTCUTS.layerFront).toBe('Alt+Meta+]')
    expect(DEFAULT_SHORTCUTS.layerBack).toBe('Alt+Meta+[')
  })
})

describe('智能采集快捷键', () => {
  it('默认是 ⌘1，且不与任何默认快捷键冲突', () => {
    expect(DEFAULT_SHORTCUTS.smartCollect).toBe('Meta+1')
    expect(shortcutConflict(DEFAULT_SHORTCUTS, 'smartCollect', 'Meta+1')).toBeNull()
  })
})

describe('parseAccelerator', () => {
  it('认出修饰键与键名', () => {
    expect(parseAccelerator('Meta+]')).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      meta: true,
      key: ']'
    })
  })

  it('拒绝不认识的修饰键', () => {
    expect(parseAccelerator('Hyper+K')).toBeNull()
  })
})

describe('shortcutConflict', () => {
  it('撞到别的动作时返回那个动作', () => {
    const bindings = { ...DEFAULT_SHORTCUTS, toolHand: 'Meta+K' }
    expect(shortcutConflict(bindings, 'toolHand', 'Meta+K')?.action).toBe('commandPalette')
  })

  it('自己原来用的组合不算冲突', () => {
    expect(shortcutConflict(DEFAULT_SHORTCUTS, 'commandPalette', 'Meta+K')).toBeNull()
  })
})

describe('normalizeShortcutBindings', () => {
  it('缺项回默认', () => {
    const result = normalizeShortcutBindings({ toolHand: 'J' })
    expect(result.toolHand).toBe('J')
    expect(result.commandPalette).toBe('Meta+K')
  })

  it('坏值回默认', () => {
    expect(normalizeShortcutBindings({ toolHand: 'not-a-key' }).toolHand).toBe('H')
  })

  it('重复键位不会让两个动作同时触发', () => {
    const result = normalizeShortcutBindings({
      toolHand: 'Meta+K',
      toolSelect: 'Meta+K'
    })
    const values = Object.values(result)
    expect(new Set(values.filter(Boolean)).size).toBe(values.filter(Boolean).length)
    expect(result.commandPalette).toBe('Meta+K')
  })
})

describe('鼠标快捷键', () => {
  function mouse(button: number, modifiers: Partial<Omit<MouseEventLike, 'button'>> = {}): MouseEventLike {
    return { button, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers }
  }

  it('中键存成 MouseMiddle，可带修饰键', () => {
    expect(acceleratorFromMouseEvent(mouse(1))).toBe('MouseMiddle')
    expect(acceleratorFromMouseEvent(mouse(1, { altKey: true }))).toBe('Alt+MouseMiddle')
  })

  it('左右键不参与绑定', () => {
    expect(acceleratorFromMouseEvent(mouse(0))).toBeNull()
    expect(acceleratorFromMouseEvent(mouse(2))).toBeNull()
  })

  it('显示成中键', () => {
    expect(formatAccelerator('MouseMiddle')).toBe('中键')
    expect(formatAccelerator('Meta+MouseMiddle')).toBe('⌘中键')
  })

  it('键盘事件不会误触鼠标绑定', () => {
    expect(matchesAccelerator(key('MouseMiddle'), 'MouseMiddle')).toBe(false)
    expect(isMouseAccelerator('MouseMiddle')).toBe(true)
    expect(isMouseAccelerator('Meta+K')).toBe(false)
  })

  it('冲突检查同时覆盖键盘与鼠标', () => {
    const bindings = { ...DEFAULT_SHORTCUTS, smartCollect: 'MouseMiddle' }
    expect(shortcutConflict(bindings, 'smartCollect', 'MouseMiddle')).toBeNull()
    expect(shortcutConflict(bindings, 'newTab', 'MouseMiddle')?.action).toBe('smartCollect')
  })

  it('读回时保留鼠标绑定，并拒绝只支持键盘的动作', () => {
    expect(normalizeShortcutBindings({ smartCollect: 'MouseMiddle' }).smartCollect).toBe('MouseMiddle')
    expect(supportsMouseBinding('smartCollect')).toBe(true)
    expect(supportsMouseBinding('renameLayer')).toBe(false)
  })

  it('sameAccelerator 也认 Mac 上两个删除键', () => {
    expect(sameAccelerator('Backspace', 'Delete')).toBe(true)
    expect(sameAccelerator('MouseMiddle', 'MouseMiddle')).toBe(true)
    expect(sameAccelerator('MouseMiddle', 'Meta+MouseMiddle')).toBe(false)
  })
})

describe('isDefaultShortcut', () => {
  it('能判断某一项是否还是出厂值', () => {
    expect(isDefaultShortcut('commandPalette', 'Meta+K')).toBe(true)
    expect(isDefaultShortcut('commandPalette', 'Meta+J')).toBe(false)
  })
})
