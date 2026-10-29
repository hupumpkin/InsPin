import { describe, expect, it } from 'vitest'
import {
  applyPanelPatch,
  clampPanelWidth,
  COLLAPSE_WIDTH,
  DEFAULT_PANEL_PREFS,
  DEGRADE_WIDTH,
  MAX_PANEL_RATIO,
  MIN_BROWSER_WIDTH,
  normalizePanelPrefs,
  panelEdgeX,
  ratioForWidth,
  resolvePanelLayout,
  type PanelPrefs
} from './panel'

const prefs = (over: Partial<PanelPrefs> = {}): PanelPrefs => ({ ...DEFAULT_PANEL_PREFS, ...over })

describe('resolvePanelLayout · 正常宽度', () => {
  it('默认从左侧揭开，画布可同步让位', () => {
    expect(DEFAULT_PANEL_PREFS.dock).toBe('left')
  })

  it('按比例给宽度，默认 52.24%', () => {
    const layout = resolvePanelLayout({ windowWidth: 1500, prefs: prefs() })
    expect(layout.open).toBe(true)
    expect(layout.width).toBe(Math.round(1500 * (1003 / 1920)))
    expect(layout.windowWidth).toBe(1500)
  })

  it('收起时宽度归零，但 openWidth 留着给滑出动画用', () => {
    const layout = resolvePanelLayout({ windowWidth: 1500, prefs: prefs({ open: false }) })
    expect(layout.open).toBe(false)
    expect(layout.width).toBe(0)
    expect(layout.openWidth).toBe(Math.round(1500 * (1003 / 1920)))
    expect(layout.requested).toBe(false)
  })
})

describe('resolvePanelLayout · 约束（D3.5）', () => {
  it('比例过大时最多只占窗口 80%', () => {
    const layout = resolvePanelLayout({ windowWidth: 1500, prefs: prefs({ ratio: 0.89 }) })
    expect(layout.width).toBe(Math.round(1500 * MAX_PANEL_RATIO))
  })

  it('比例过小时浏览器仍留够 420', () => {
    const layout = resolvePanelLayout({ windowWidth: 1500, prefs: prefs({ ratio: 0.11 }) })
    expect(layout.width).toBe(MIN_BROWSER_WIDTH)
  })
})

describe('resolvePanelLayout · 窄窗口降级（D3.7）', () => {
  it('窄于 1060 直接收到 420', () => {
    const layout = resolvePanelLayout({ windowWidth: DEGRADE_WIDTH - 40, prefs: prefs() })
    expect(layout.open).toBe(true)
    expect(layout.width).toBe(MIN_BROWSER_WIDTH)
  })

  it('再窄于 900 自动收起，画布占满', () => {
    const layout = resolvePanelLayout({ windowWidth: COLLAPSE_WIDTH - 40, prefs: prefs() })
    expect(layout.open).toBe(false)
    expect(layout.width).toBe(0)
    // 意愿还在：窗口拉宽后要能自己回来
    expect(layout.requested).toBe(true)
  })

  it('变宽回去会自己展开（意愿没丢）', () => {
    const narrow = resolvePanelLayout({ windowWidth: 800, prefs: prefs() })
    expect(narrow.open).toBe(false)
    const wide = resolvePanelLayout({ windowWidth: 1500, prefs: prefs() })
    expect(wide.open).toBe(true)
  })
})

describe('clampPanelWidth / ratioForWidth', () => {
  it('夹进 [420, 窗口 80%]', () => {
    expect(clampPanelWidth(100, 1500)).toBe(MIN_BROWSER_WIDTH)
    expect(clampPanelWidth(1400, 1500)).toBe(1200)
    expect(clampPanelWidth(700, 1500)).toBe(700)
  })

  it('换算出来的比例再算回宽度是同一个值（能来回）', () => {
    const ratio = ratioForWidth(700, 1500)
    expect(clampPanelWidth(1500 * ratio, 1500)).toBe(700)
  })
})

describe('panelEdgeX', () => {
  it('左/浮动贴面板右边', () => {
    expect(panelEdgeX({ dock: 'float', open: true, width: 784 }, 1500)).toBe(784)
    expect(panelEdgeX({ dock: 'left', open: true, width: 784 }, 1500)).toBe(784)
  })

  it('右停靠贴面板左边', () => {
    expect(panelEdgeX({ dock: 'right', open: true, width: 784 }, 1500)).toBe(716)
  })

  it('收起时没有分栏线', () => {
    expect(panelEdgeX({ dock: 'float', open: false, width: 0 }, 1500)).toBe(0)
  })
})

describe('normalizePanelPrefs · 坏数据', () => {
  it('不是对象 → 默认值', () => {
    expect(normalizePanelPrefs(null)).toEqual(DEFAULT_PANEL_PREFS)
    expect(normalizePanelPrefs('x')).toEqual(DEFAULT_PANEL_PREFS)
  })

  it('字段非法 → 逐项退回默认', () => {
    expect(normalizePanelPrefs({ dock: 'nope', ratio: 5, open: 'yes' })).toEqual(DEFAULT_PANEL_PREFS)
  })

  it('旧版右侧停靠迁回左侧揭开，避免原生网页层占住右侧画布', () => {
    expect(normalizePanelPrefs({ dock: 'right', ratio: 0.4, open: false })).toEqual({
      dock: 'left',
      ratio: 0.4,
      open: false
    })
  })
})

describe('applyPanelPatch', () => {
  it('只改传进来的那一项', () => {
    const before = prefs({ dock: 'left', ratio: 0.4, open: true })
    expect(applyPanelPatch(before, { open: false })).toEqual({ dock: 'left', ratio: 0.4, open: false })
    expect(applyPanelPatch(before, { dock: 'right' })).toEqual({ dock: 'right', ratio: 0.4, open: true })
  })

  it('非法补丁原样返回', () => {
    const before = prefs()
    expect(applyPanelPatch(before, { dock: 'nope' })).toEqual(before)
    expect(applyPanelPatch(before, null)).toEqual(before)
  })
})
