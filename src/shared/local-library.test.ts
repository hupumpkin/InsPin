import { describe, expect, it } from 'vitest'
import { isLibraryDragItem, parseLibraryDragPayload } from './local-library'

describe('素材拖拽负载', () => {
  it('解析批量格式', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'managed', assetId: 'a1' },
        { kind: 'linked', folderId: 'f1', relativePath: 'sub/a.png' }
      ]
    })
    expect(parseLibraryDragPayload(raw)).toEqual([
      { kind: 'managed', assetId: 'a1' },
      { kind: 'linked', folderId: 'f1', relativePath: 'sub/a.png' }
    ])
  })

  it('兼容早期的单张格式', () => {
    expect(parseLibraryDragPayload(JSON.stringify({ kind: 'managed', assetId: 'a1' }))).toEqual([
      { kind: 'managed', assetId: 'a1' }
    ])
  })

  it('丢弃格式不对的条目和坏 JSON', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'managed', assetId: 'a1' },
        { kind: 'managed' },
        { kind: 'linked', folderId: 'f1' },
        null,
        'nope'
      ]
    })
    expect(parseLibraryDragPayload(raw)).toEqual([{ kind: 'managed', assetId: 'a1' }])
    expect(parseLibraryDragPayload('{')).toEqual([])
  })

  it('isLibraryDragItem 校验必填字段', () => {
    expect(isLibraryDragItem({ kind: 'managed', assetId: 'a1' })).toBe(true)
    expect(isLibraryDragItem({ kind: 'linked', folderId: 'f1', relativePath: 'a.png' })).toBe(true)
    expect(isLibraryDragItem({ kind: 'linked', folderId: 'f1' })).toBe(false)
    expect(isLibraryDragItem({ kind: 'other' })).toBe(false)
  })
})
