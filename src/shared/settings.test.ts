import { describe, expect, it } from 'vitest'
import {
  cleanupWindowMs,
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings
} from './settings'

describe('normalizeSettings', () => {
  it('空数据回到完整默认值', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('坏值逐项回默认，不整份丢掉', () => {
    const result = normalizeSettings({
      copyConvertToPng: false,
      canvasColor: 'red',
      libraryView: 'tiles',
      assetCleanup: { enabled: false, graceDays: 999, trashDays: 0 }
    })
    expect(result.copyConvertToPng).toBe(false)
    expect(result.canvasColor).toBe(DEFAULT_SETTINGS.canvasColor)
    expect(result.libraryView).toBe('grid')
    expect(result.assetCleanup.enabled).toBe(false)
    expect(result.assetCleanup.graceDays).toBe(90)
    expect(result.assetCleanup.trashDays).toBe(2)
  })

  it('画布底色统一成小写十六进制', () => {
    expect(normalizeSettings({ canvasColor: '#FFFFFF' }).canvasColor).toBe('#ffffff')
  })

  it('启动时打开浏览器默认开，坏值回默认', () => {
    expect(normalizeSettings(null).openBrowserOnLaunch).toBe(true)
    expect(normalizeSettings({ openBrowserOnLaunch: false }).openBrowserOnLaunch).toBe(false)
    expect(normalizeSettings({ openBrowserOnLaunch: 'yes' }).openBrowserOnLaunch).toBe(true)
  })

  it('智能采集默认冻结网页，也只接受布尔设置', () => {
    expect(normalizeSettings(null).freezeSmartCollection).toBe(true)
    expect(normalizeSettings({ freezeSmartCollection: false }).freezeSmartCollection).toBe(false)
    expect(normalizeSettings({ freezeSmartCollection: 'yes' }).freezeSmartCollection).toBe(true)
  })
})

describe('mergeSettings', () => {
  it('只改带上来的字段', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { libraryView: 'list' })
    expect(next.libraryView).toBe('list')
    expect(next.copyConvertToPng).toBe(DEFAULT_SETTINGS.copyConvertToPng)
  })

  it('能单独更新智能采集冻结设置', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { freezeSmartCollection: true }).freezeSmartCollection).toBe(true)
  })

  it('嵌套的清理策略按字段合并', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { assetCleanup: { graceDays: 7 } })
    expect(next.assetCleanup.graceDays).toBe(7)
    expect(next.assetCleanup.trashDays).toBe(DEFAULT_SETTINGS.assetCleanup.trashDays)
    expect(next.assetCleanup.enabled).toBe(true)
  })

  it('嵌套的快捷键按动作合并；没带到的保持原样', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { shortcuts: { toolHand: 'J' } })
    expect(next.shortcuts.toolHand).toBe('J')
    expect(next.shortcuts.commandPalette).toBe('Meta+K')
  })

  it('非法补丁不动原设置', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, 'nope')).toEqual(DEFAULT_SETTINGS)
  })
})

describe('cleanupWindowMs', () => {
  it('把天数换成毫秒', () => {
    const windows = cleanupWindowMs({ enabled: true, graceDays: 3, trashDays: 30 })
    expect(windows.graceMs).toBe(3 * 24 * 60 * 60 * 1000)
    expect(windows.trashMs).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
