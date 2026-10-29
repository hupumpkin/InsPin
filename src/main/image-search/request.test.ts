import { describe, expect, it } from 'vitest'
import { imageSearchConsentDisclosure, parseImageSearchRequest } from '../../shared/image-search'

const valid = {
  engineId: 'google',
  assetFileName: 'abc.png',
  projectId: 'p1',
  mode: 'auto'
}

describe('parseImageSearchRequest', () => {
  it('接受合法请求', () => {
    expect(parseImageSearchRequest(valid)).toEqual(valid)
  })

  it('mode 缺省按 auto', () => {
    const { mode: _mode, ...rest } = valid
    expect(parseImageSearchRequest(rest)?.mode).toBe('auto')
  })

  it('拒绝未知引擎', () => {
    expect(parseImageSearchRequest({ ...valid, engineId: 'bing' })).toBeNull()
  })

  it('拒绝空文件名 / 空项目', () => {
    expect(parseImageSearchRequest({ ...valid, assetFileName: '' })).toBeNull()
    expect(parseImageSearchRequest({ ...valid, projectId: '' })).toBeNull()
  })

  it('拒绝未知 mode', () => {
    expect(parseImageSearchRequest({ ...valid, mode: 'magic' })).toBeNull()
  })

  it('拒绝非对象', () => {
    expect(parseImageSearchRequest(null)).toBeNull()
    expect(parseImageSearchRequest('x')).toBeNull()
  })

  it('接受局部搜索的归一化裁切框', () => {
    const crop = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    expect(parseImageSearchRequest({ ...valid, crop })).toEqual({ ...valid, crop })
  })

  it('裁切框越界时夹回 0–1', () => {
    expect(
      parseImageSearchRequest({ ...valid, crop: { x: -0.2, y: 0.8, w: 0.5, h: 0.5 } })?.crop
    ).toEqual({ x: 0, y: 0.8, w: 0.3, h: 0.2 })
  })

  it('拒绝缺字段 / 非数字 / 空宽高的裁切框', () => {
    expect(parseImageSearchRequest({ ...valid, crop: { x: 0, y: 0, w: 1 } })).toBeNull()
    expect(parseImageSearchRequest({ ...valid, crop: { x: 0, y: 0, w: Number.NaN, h: 1 } })).toBeNull()
    expect(parseImageSearchRequest({ ...valid, crop: { x: 0, y: 0, w: 0, h: 1 } })).toBeNull()
    expect(parseImageSearchRequest({ ...valid, crop: { x: 1, y: 0, w: 0.5, h: 1 } })).toBeNull()
    expect(parseImageSearchRequest({ ...valid, crop: 'all' })).toBeNull()
  })
})

describe('以图搜图首次授权披露', () => {
  it('说明 Pinterest 会保留镜头上传历史', () => {
    expect(imageSearchConsentDisclosure('pinterest')).toContain('镜头上传历史')
  })

  it('说明花瓣不会创建采集或画板', () => {
    expect(imageSearchConsentDisclosure('huaban')).toContain('不会在你的账号里创建采集或画板')
  })

  it('其他引擎没有未经确认的额外承诺', () => {
    expect(imageSearchConsentDisclosure('google')).toBeNull()
    expect(imageSearchConsentDisclosure('zcool')).toBeNull()
  })
})
