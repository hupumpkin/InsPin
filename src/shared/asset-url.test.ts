import { describe, expect, it } from 'vitest'
import {
  ASSET_SCHEME,
  assetUrlFor,
  linkedAssetUrlFor,
  linkedThumbUrlFor,
  parseAssetUrl,
  thumbnailNameFor,
  thumbUrlFor
} from './asset-url'

describe('assetUrlFor / thumbUrlFor', () => {
  it('原图地址不含本机路径', () => {
    expect(assetUrlFor('ab12.png')).toBe(`${ASSET_SCHEME}:///ab12.png`)
  })

  it('缩略图地址把 bucket 放在主机名位置', () => {
    expect(thumbUrlFor('ab12.png')).toBe(`${ASSET_SCHEME}://thumb/ab12.png`)
  })

  it('往返：自己生成的地址能解析回自己', () => {
    expect(parseAssetUrl(assetUrlFor('9f.png'))).toEqual({ bucket: 'original', fileName: '9f.png' })
    expect(parseAssetUrl(thumbUrlFor('9f.png'))).toEqual({ bucket: 'thumb', fileName: '9f.png' })
  })

  it('外部文件夹地址保留文件夹 id 与相对路径', () => {
    expect(parseAssetUrl(linkedAssetUrlFor('folder-1', '子目录/灵感 图.png'))).toEqual({
      bucket: 'linked',
      folderId: 'folder-1',
      relativePath: '子目录/灵感 图.png'
    })
  })

  it('外部文件夹缩略图走独立桶，不会和原图地址混淆', () => {
    expect(parseAssetUrl(linkedThumbUrlFor('folder-1', '子目录/灵感 图.png'))).toEqual({
      bucket: 'linked-thumb',
      folderId: 'folder-1',
      relativePath: '子目录/灵感 图.png'
    })
  })
})

describe('thumbnailNameFor', () => {
  it('去掉扩展名再加 .thumb.png', () => {
    expect(thumbnailNameFor('9f.png')).toBe('9f.thumb.png')
    expect(thumbnailNameFor('9f.webp')).toBe('9f.thumb.png')
  })

  it('没有扩展名也能处理', () => {
    expect(thumbnailNameFor('9f')).toBe('9f.thumb.png')
  })
})

describe('parseAssetUrl', () => {
  it('认 Chromium 把首段提成主机名的写法', () => {
    expect(parseAssetUrl('ins-pin-asset://9f.png/')).toEqual({
      bucket: 'original',
      fileName: '9f.png'
    })
    expect(parseAssetUrl('ins-pin-asset://thumb/9f.png')).toEqual({
      bucket: 'thumb',
      fileName: '9f.png'
    })
  })

  it('带查询串不受影响', () => {
    expect(parseAssetUrl('ins-pin-asset:///a.png?v=2')).toEqual({
      bucket: 'original',
      fileName: 'a.png'
    })
  })

  it('拒绝目录穿越：解析出来的文件名永远不含路径分隔符', () => {
    const hostile = [
      'ins-pin-asset:///../../etc/passwd',
      `${ASSET_SCHEME}:///%2e%2e%2fsecret`,
      'ins-pin-asset://thumb/../secret',
      'ins-pin-asset:///sub/dir.png',
      'ins-pin-asset:///a\\b.png',
      `${ASSET_SCHEME}://thumb/%2e%2e%2f%2e%2e%2fetc%2fpasswd`
    ]
    for (const url of hostile) {
      const parsed = parseAssetUrl(url)
      if (parsed) {
        // 允许被 URL 规范化压平（如 thumb/../secret → secret），但绝不能留分隔符
        expect(parsed.fileName).not.toContain('/')
        expect(parsed.fileName).not.toContain('\\')
        expect(parsed.fileName).not.toContain('..')
      }
    }
  })

  it('拒绝空文件名与上级指针', () => {
    expect(parseAssetUrl('ins-pin-asset:///')).toBeNull()
    expect(parseAssetUrl('ins-pin-asset://thumb/')).toBeNull()
    expect(parseAssetUrl('ins-pin-asset:///..')).toBeNull()
  })

  it('非法地址返回 null 而不是抛异常', () => {
    expect(parseAssetUrl('not a url')).toBeNull()
    expect(parseAssetUrl('ins-pin-asset:///%E0%A4%A')).toBeNull()
  })
})
