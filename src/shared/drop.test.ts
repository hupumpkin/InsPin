import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities, extractCandidateUrls, isDownloadableUrl } from './drop'

describe('decodeHtmlEntities', () => {
  it('还原从 text/html 里抠出来的地址', () => {
    expect(decodeHtmlEntities('https://a.com/x?p=1&amp;q=2')).toBe('https://a.com/x?p=1&q=2')
    expect(decodeHtmlEntities('a&#x2f;b')).toBe('a/b')
    expect(decodeHtmlEntities('&#72;i')).toBe('Hi')
  })
})

describe('isDownloadableUrl', () => {
  it('只放行 http(s)', () => {
    expect(isDownloadableUrl('https://a.com/x.png')).toBe(true)
    expect(isDownloadableUrl('http://a.com/x.png')).toBe(true)
    expect(isDownloadableUrl('data:image/png;base64,AAA')).toBe(false)
    expect(isDownloadableUrl('blob:https://a.com/xxx')).toBe(false)
    expect(isDownloadableUrl('/relative/x.png')).toBe(false)
  })
})

describe('extractCandidateUrls', () => {
  it('花瓣那种情况：uri-list 是页面链接，真正的图在 text/html 里', () => {
    const urls = extractCandidateUrls({
      textUriList: 'https://www.huaban.com/pins/123456/',
      textHtml: '<meta charset="utf-8"><img src="https://hbimg.huabanimg.com/abc_fw658">'
    })

    expect(urls[0]).toBe('https://hbimg.huabanimg.com/abc_fw658')
    expect(urls).toContain('https://www.huaban.com/pins/123456/')
  })

  it('同一张图有 srcset 时取最大档，且排在 src 前面', () => {
    const urls = extractCandidateUrls({
      textHtml:
        '<img src="https://a.com/s.jpg" srcset="https://a.com/s.jpg 400w, https://a.com/l.jpg 1600w">'
    })

    expect(urls).toEqual(['https://a.com/l.jpg', 'https://a.com/s.jpg'])
  })

  it('按出现顺序处理多个 img', () => {
    const urls = extractCandidateUrls({
      textHtml:
        '<img src="https://a.com/1.jpg"><img src="https://a.com/2.jpg">'
    })
    expect(urls).toEqual(['https://a.com/1.jpg', 'https://a.com/2.jpg'])
  })

  it('地址里的 HTML 转义被还原', () => {
    const urls = extractCandidateUrls({
      textHtml: '<img src="https://a.com/x?w=1&amp;h=2">'
    })
    expect(urls).toEqual(['https://a.com/x?w=1&h=2'])
  })

  it('uri-list 里的注释行被跳过', () => {
    const urls = extractCandidateUrls({
      textUriList: '# 这是注释\r\nhttps://a.com/pic.png\r\n'
    })
    expect(urls).toEqual(['https://a.com/pic.png'])
  })

  it('text/plain 作为最后的兜底', () => {
    const urls = extractCandidateUrls({ textPlain: 'https://a.com/from-plain.png' })
    expect(urls).toEqual(['https://a.com/from-plain.png'])
  })

  it('去重，且丢掉不能直接下载的地址', () => {
    const urls = extractCandidateUrls({
      textHtml: '<img src="https://a.com/x.png"><img src="https://a.com/x.png">',
      textUriList: 'data:image/png;base64,AAA\nhttps://a.com/x.png'
    })
    expect(urls).toEqual(['https://a.com/x.png'])
  })

  it('什么都没有时返回空数组', () => {
    expect(extractCandidateUrls({})).toEqual([])
    expect(extractCandidateUrls({ textHtml: '没有图的一段文字' })).toEqual([])
  })
})
