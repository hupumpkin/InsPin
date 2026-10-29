import { describe, expect, it } from 'vitest'
import {
  extractPageOriginalCandidates,
  findAdapter,
  isLowResCopy,
  upgradeImageUrl
} from './sites'

describe('findAdapter', () => {
  it('按域名（含子域）匹配', () => {
    expect(findAdapter('https://hbimg.huabanimg.com/x_fw658')?.id).toBe('huaban')
    expect(findAdapter('https://www.huaban.com/pins/1')?.id).toBe('huaban')
    expect(findAdapter('https://sns-webpic-qc.xhscdn.com/a!nd_dft')?.id).toBe('xiaohongshu')
    expect(findAdapter('https://i.pinimg.com/236x/a/b/c.jpg')?.id).toBe('pinterest')
  })

  it('无关站点返回 null', () => {
    expect(findAdapter('https://example.com/a.png')).toBeNull()
    expect(findAdapter('不是网址')).toBeNull()
  })
})

describe('upgradeImageUrl', () => {
  it('花瓣：去掉规格后缀还原高清地址', () => {
    expect(upgradeImageUrl('https://hbimg.huabanimg.com/abc123_fw658').url).toBe(
      'https://hbimg.huabanimg.com/abc123'
    )
    expect(upgradeImageUrl('https://hbimg.huabanimg.com/abc123_fw480webp').url).toBe(
      'https://hbimg.huabanimg.com/abc123'
    )
    expect(upgradeImageUrl('https://hbimg.huabanimg.com/abc123_sq75').url).toBe(
      'https://hbimg.huabanimg.com/abc123'
    )
  })

  it('花瓣：没有规格就保持不变', () => {
    const result = upgradeImageUrl('https://hbimg.huabanimg.com/abc123')
    expect(result.changed).toBe(false)
    expect(result.url).toBe('https://hbimg.huabanimg.com/abc123')
  })

  it('花瓣：规格在查询串之前也能去掉，并保留查询串', () => {
    const result = upgradeImageUrl('https://hbimg.huabanimg.com/abc_fw240?x=1')
    expect(result.url).toBe('https://hbimg.huabanimg.com/abc?x=1')
  })

  it('小红书：去掉 ! 后面的参数', () => {
    expect(
      upgradeImageUrl('https://sns-webpic-qc.xhscdn.com/2026/abc!nd_dft_wlteh_webp_3').url
    ).toBe('https://sns-webpic-qc.xhscdn.com/2026/abc')
  })

  it('Pinterest：尺寸段换成 originals', () => {
    expect(upgradeImageUrl('https://i.pinimg.com/236x/aa/bb/cc/x.jpg').url).toBe(
      'https://i.pinimg.com/originals/aa/bb/cc/x.jpg'
    )
  })

  it('陌生站点不动它', () => {
    const result = upgradeImageUrl('https://example.com/a_fw480webp')
    expect(result).toEqual({ url: 'https://example.com/a_fw480webp', adapterId: null, changed: false })
  })

  // 2026-10-15 用户手测时日志里冒出一张 480×480 没被认成低清，查出来是这种路径段写法；
  // 实测去掉 `small/` 段能从 480×480/89KB 拿到 800×800/335KB
  describe('花瓣的 /small/ 路径段', () => {
    const SMALL = 'https://gd-hbimg-edge.huaban.com/small/50e688bc-WVCcJh?auth_key=abc'

    it('去掉尺寸段就是高清地址，查询串要留着', () => {
      expect(upgradeImageUrl(SMALL)).toEqual({
        url: 'https://gd-hbimg-edge.huaban.com/50e688bc-WVCcJh?auth_key=abc',
        adapterId: 'huaban',
        changed: true
      })
    })

    it('认得出这是缩略图', () => {
      expect(isLowResCopy(SMALL)).toBe(true)
    })

    it('去掉之后就不算低清了', () => {
      expect(isLowResCopy('https://gd-hbimg-edge.huaban.com/50e688bc-WVCcJh')).toBe(false)
    })

    it('路径中段的尺寸段也能去掉', () => {
      expect(upgradeImageUrl('https://hbimg.huabanimg.com/a/thumb/b.png').url).toBe(
        'https://hbimg.huabanimg.com/a/b.png'
      )
    })

    it('后缀和路径段同时出现时一起去掉', () => {
      expect(upgradeImageUrl('https://hbimg.huabanimg.com/small/abc_fw480webp').url).toBe(
        'https://hbimg.huabanimg.com/abc'
      )
    })
  })
})

describe('isLowResCopy', () => {
  it('地址上还留着降级标记才算', () => {
    expect(isLowResCopy('https://hbimg.huabanimg.com/abc_fw480webp')).toBe(true)
    expect(isLowResCopy('https://hbimg.huabanimg.com/abc')).toBe(false)
    expect(isLowResCopy('https://i.pinimg.com/236x/a/b/c.jpg')).toBe(true)
    expect(isLowResCopy('https://i.pinimg.com/originals/a/b/c.jpg')).toBe(false)
  })

  it('拿不准时不标（宁可不标，也不给高清图贴低清标签）', () => {
    expect(isLowResCopy('https://example.com/small.jpg')).toBe(false)
    expect(isLowResCopy('不是网址')).toBe(false)
  })
})

describe('extractPageOriginalCandidates', () => {
  const PAGE = 'https://www.huaban.com/pins/123456/'

  it('优先取 data-origin-src 这类原图属性', () => {
    const html = '<img src="https://a.com/thumb.jpg" data-origin-src="https://a.com/original.jpg">'
    expect(extractPageOriginalCandidates(html, PAGE)[0]).toBe('https://a.com/original.jpg')
  })

  it('认得灯箱：指向图片文件的链接', () => {
    const html = '<a href="https://a.com/big.jpg"><img src="https://a.com/small.jpg"></a>'
    const urls = extractPageOriginalCandidates(html, PAGE)
    expect(urls[0]).toBe('https://a.com/big.jpg')
  })

  it('回落到 img 的 srcset 最大档', () => {
    const html = '<img srcset="https://a.com/s.jpg 400w, https://a.com/l.jpg 1200w">'
    expect(extractPageOriginalCandidates(html, PAGE)).toContain('https://a.com/l.jpg')
  })

  it('相对地址会按页面地址补全', () => {
    const html = '<img data-original="/pic/big.jpg">'
    expect(extractPageOriginalCandidates(html, PAGE)[0]).toBe('https://www.huaban.com/pic/big.jpg')
  })

  it('去重、且只保留 http(s)', () => {
    const html = `
      <img data-original="https://a.com/x.jpg" src="https://a.com/x.jpg">
      <img data-original="data:image/png;base64,AAA">
    `
    expect(extractPageOriginalCandidates(html, PAGE)).toEqual(['https://a.com/x.jpg'])
  })

  it('没有原图线索时返回空数组', () => {
    expect(extractPageOriginalCandidates('<p>一段文字</p>', PAGE)).toEqual([])
  })
})
