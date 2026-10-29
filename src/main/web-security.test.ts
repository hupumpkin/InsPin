import { describe, expect, it } from 'vitest'
import { isTrustedRendererUrl } from './web-security'

describe('isTrustedRendererUrl', () => {
  it('接受打包后的本地界面页面', () => {
    const base = 'file:///Applications/InsPin.app/Contents/Resources/app.asar/out/renderer'
    expect(isTrustedRendererUrl(`${base}/index.html`, null)).toBe(true)
    expect(isTrustedRendererUrl(`${base}/snapshot.html`, null)).toBe(true)
    expect(isTrustedRendererUrl(`${base}/snapshot-menu.html`, null)).toBe(true)
  })

  it('拒绝第三方网页和其他本地文件', () => {
    expect(isTrustedRendererUrl('https://www.figma.com/file/abc', null)).toBe(false)
    expect(isTrustedRendererUrl('file:///Users/me/Downloads/evil.html', null)).toBe(false)
    expect(isTrustedRendererUrl('about:blank', null)).toBe(false)
    expect(isTrustedRendererUrl('', null)).toBe(false)
  })

  it('开发模式下只放行同源的渲染页面', () => {
    const dev = 'http://localhost:5173'
    expect(isTrustedRendererUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/index.html', dev)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/snapshot.html', dev)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173.evil.com/', dev)).toBe(false)
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', dev)).toBe(false)
  })
})
