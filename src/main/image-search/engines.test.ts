import { describe, expect, it } from 'vitest'
import { adapterFor, catalogFor, IMAGE_SEARCH_ADAPTERS, validateAdapters } from './engines'

describe('image search adapters', () => {
  it('配置合法', () => {
    expect(validateAdapters(IMAGE_SEARCH_ADAPTERS)).toEqual([])
  })

  it('引擎 id 唯一', () => {
    const ids = IMAGE_SEARCH_ADAPTERS.map((adapter) => adapter.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('目录按优先级暴露四个可用站点', () => {
    expect(catalogFor().map((item) => item.id)).toEqual(['pinterest', 'huaban', 'google', 'zcool'])
  })

  it('Pinterest 用实测到的稳定选择器', () => {
    const adapter = adapterFor('pinterest')
    expect(adapter?.openUpload?.selectors).toContain('[aria-label="上传图片"]')
    expect(adapter?.fileInput.selectors).toContain('#lens-file-upload')
    expect(adapter?.requiresLogin).toBe(true)
  })

  it('花瓣用 aria-label 而不是哈希 class', () => {
    const adapter = adapterFor('huaban')
    expect(adapter?.openUpload?.selectors).toContain('button[aria-label="以图搜索"]')
    expect(adapter?.requiresLogin).toBe(true)
  })

  it('Google 不需要先点入口', () => {
    const adapter = adapterFor('google')
    expect(adapter?.openUpload).toBeUndefined()
    expect(adapter?.fileInput.selectors).toContain('input[name=encoded_image]')
    expect(adapter?.requiresLogin).toBe(false)
  })

  it('Google 必须等跳转到 google.com 之后再注入', () => {
    const entryUrl = adapterFor('google')?.entryUrl
    expect(entryUrl).toBeTruthy()
    const pattern = new RegExp(entryUrl!)
    expect(pattern.test('https://lens.google.com/')).toBe(false)
    expect(pattern.test('https://www.google.com/?olud=')).toBe(true)
    expect(pattern.test('https://www.google.com/search?vsrid=abc')).toBe(true)
  })

  it('结果页正则能命中实测 URL', () => {
    const cases: [string, string][] = [
      ['pinterest', 'https://www.pinterest.com/lens-search/'],
      ['huaban', 'https://huaban.com/similar?bucket=gd-hbimg-other&key=imagerec/abc'],
      ['google', 'https://www.google.com/search?vsrid=abc&udm=26'],
      ['zcool', 'https://www.zcool.com.cn/search/image?album=ZMTAzMDAzNjA=_1']
    ]
    for (const [id, url] of cases) {
      const adapter = adapterFor(id as 'pinterest' | 'huaban' | 'google' | 'zcool')
      expect(adapter?.result.url).toBeTruthy()
      expect(new RegExp(adapter!.result.url!).test(url)).toBe(true)
    }
  })

  it('无效配置会被指出来', () => {
    const errors = validateAdapters([
      {
        ...IMAGE_SEARCH_ADAPTERS[0]!,
        startUrl: 'http://example.com',
        findTimeoutMs: 0,
        resultTimeoutMs: -1
      }
    ])
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})
