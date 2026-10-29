import { describe, expect, it } from 'vitest'
import { describeLoadError, errorPageDataUrl, errorPageHtml } from './browser-error'

describe('describeLoadError', () => {
  it('常见错误码给对应的中文说法', () => {
    expect(describeLoadError(-105).title).toBe('打不开这个网址')
    expect(describeLoadError(-106).title).toBe('网络好像断了')
    expect(describeLoadError(-102).title).toBe('网站拒绝了连接')
  })

  it('没收录的码走通用文案，不暴露底层报错', () => {
    const copy = describeLoadError(-999)
    expect(copy.title).toBe('打不开这个页面')
    expect(JSON.stringify(copy)).not.toContain('ERR')
  })
})

describe('错误页 HTML', () => {
  const html = errorPageHtml(-105, 'https://nope.invalid/x')

  it('是完整的网页，含三句话与网址', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('打不开这个网址')
    expect(html).toContain('https://nope.invalid/x')
    expect(html).not.toContain('ERR_')
  })

  it('网址里的尖括号会被剥掉，不会注入标签', () => {
    const dirty = errorPageHtml(-105, 'https://x.com/<script>alert(1)</script>')
    expect(dirty).not.toContain('<script>')
  })

  it('data URL 可直接当地址用', () => {
    expect(errorPageDataUrl(-106, 'https://x.com')).toMatch(/^data:text\/html;charset=utf-8,/)
  })
})
