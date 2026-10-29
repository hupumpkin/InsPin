import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings'
import { loadSettings, saveSettings } from './settings-store'

let root: string
let file: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inspin-settings-'))
  file = join(root, 'settings.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('settings-store', () => {
  it('没存过时读到完整默认值', async () => {
    expect(await loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('坏文件也回到默认，不让应用起不来', async () => {
    writeFileSync(file, '{ 坏掉的 json')
    expect(await loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('写进去再读回来是同一份设置', async () => {
    const next = mergeSettings(DEFAULT_SETTINGS, {
      canvasColor: '#ffffff',
      assetCleanup: { graceDays: 7 },
      shortcuts: { commandPalette: 'Meta+J' }
    })
    await saveSettings(file, next)
    expect(await loadSettings(file)).toEqual(next)
  })

  it('连续写两次不会互相覆盖（后一次是最终结果）', async () => {
    const first = mergeSettings(DEFAULT_SETTINGS, { canvasColor: '#ffffff' })
    const second = mergeSettings(first, { canvasColor: '#20242e' })
    await Promise.all([saveSettings(file, first), saveSettings(file, second)])
    expect(JSON.parse(readFileSync(file, 'utf8')).canvasColor).toBe('#20242e')
  })
})
