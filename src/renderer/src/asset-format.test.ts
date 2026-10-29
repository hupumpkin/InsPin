import { describe, expect, it } from 'vitest'
import type { ImportMethod } from '../../shared/ipc'
import {
  assetBadgeLabel,
  formatBytes,
  formatDateTime,
  hostOf,
  importMethodLabel,
  nodeKindLabel
} from './asset-format'
import { createAssetNode, createCanvasElementNode, createGroupNode } from '../../shared/node'

describe('importMethodLabel', () => {
  it('每种来源都有中文说法', () => {
    expect(importMethodLabel('file')).toBe('从文件导入')
    expect(importMethodLabel('clipboard')).toBe('从剪贴板粘贴')
    expect(importMethodLabel('drag')).toBe('从网页拖入')
  })

  // D3.17：粘贴 / 截图 / 原图要能区分开
  it('五种来源的说法互不相同，不会混起来', () => {
    const methods: ImportMethod[] = ['file', 'clipboard', 'drag', 'pin', 'capture']
    const labels = methods.map(importMethodLabel)
    expect(new Set(labels).size).toBe(methods.length)
  })
})

describe('assetBadgeLabel', () => {
  it('两种"不是原图"的标签各说各的', () => {
    expect(assetBadgeLabel('low-res')).toBe('低清副本')
    expect(assetBadgeLabel('screenshot')).toBe('截图副本')
  })
})

describe('formatBytes', () => {
  it('小于 1MB 用 KB，至少显示 1KB', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(500)).toBe('1 KB')
    expect(formatBytes(2048)).toBe('2 KB')
  })

  it('超过 1MB 用 MB 一位小数', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })
})

describe('formatDateTime', () => {
  it('格式化成本地时间', () => {
    const iso = new Date(2026, 9, 14, 9, 5).toISOString()
    expect(formatDateTime(iso)).toBe('2026/10/14 09:05')
  })

  it('解不出来的原样返回', () => {
    expect(formatDateTime('不是时间')).toBe('不是时间')
  })
})

describe('hostOf', () => {
  it('取域名，非法或为空返回 null', () => {
    expect(hostOf('https://cdn.petals.com/pin/1.jpg')).toBe('cdn.petals.com')
    expect(hostOf('不是网址')).toBeNull()
    expect(hostOf(null)).toBeNull()
  })
})

describe('nodeKindLabel', () => {
  it('按类型给中文名', () => {
    expect(nodeKindLabel(createAssetNode({ id: 'a', projectId: 'p', name: 'a', assetId: 'x', naturalWidth: 1, naturalHeight: 1 }))).toBe('图片')
    expect(nodeKindLabel(createGroupNode({ id: 'g', projectId: 'p', name: 'g' }))).toBe('编组')
    expect(nodeKindLabel(createCanvasElementNode({ id: 't', projectId: 'p', name: 't', element: { kind: 'text', text: 'hi', color: '#000000', fontSize: 16 } }))).toBe('文本')
  })
})
