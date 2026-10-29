import { describe, expect, it } from 'vitest'
import { redactText, redactUrl, shortHash } from './redact'

describe('redactUrl', () => {
  it('保留域名，路径与查询串变成哈希', () => {
    const raw = 'https://www.pinterest.com/pin/123456/?utm=abc'
    const out = redactUrl(raw)
    expect(out).toBe(`www.pinterest.com/${shortHash(raw)}`)
    expect(out).not.toContain('123456')
    expect(out).not.toContain('utm')
  })

  it('同一个网址得到同一个哈希，不同网址不同', () => {
    const a = redactUrl('https://a.com/x')
    const b = redactUrl('https://a.com/x')
    const c = redactUrl('https://a.com/y')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('非 URL 输入也能兜底，不抛错', () => {
    expect(() => redactUrl('不是网址')).not.toThrow()
    expect(redactUrl('不是网址')).toBe(`<url:${shortHash('不是网址')}>`)
  })
})

describe('redactText', () => {
  it('替换文本中的全部网址', () => {
    const line =
      '{"event":"fetch","url":"https://cdn.example.com/a/b.jpg","referer":"http://site.cn/p?x=1"}'
    const out = redactText(line)
    expect(out).toBe(
      `{"event":"fetch","url":"cdn.example.com/${shortHash('https://cdn.example.com/a/b.jpg')}","referer":"site.cn/${shortHash('http://site.cn/p?x=1')}"}`
    )
  })

  it('脱敏结果可再次通过而不变（幂等）', () => {
    const once = redactText('看这个 https://x.com/a/b')
    expect(redactText(once)).toBe(once)
  })

  it('没有网址时原样返回', () => {
    const text = '{"level":"info","event":"app.start"}'
    expect(redactText(text)).toBe(text)
  })

  it('脱敏后仍是合法 JSON', () => {
    const line = '{"url":"https://x.com/a","msg":"打开 https://y.com/b 失败"}'
    const out = redactText(line)
    expect(() => JSON.parse(out)).not.toThrow()
    expect(JSON.parse(out).url).not.toContain('x.com/a')
  })
})
