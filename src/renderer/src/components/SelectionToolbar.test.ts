import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SearchMenu } from './SelectionToolbar'

describe('搜图菜单', () => {
  it('提供明确的手动粘贴模式入口', () => {
    const html = renderToStaticMarkup(
      createElement(SearchMenu, {
        engines: [{ id: 'google', label: 'Google Lens' }],
        mode: 'auto',
        onPick: vi.fn(),
        onModeChange: vi.fn(),
        onCropSearch: vi.fn()
      })
    )
    expect(html).toContain('复制图片并手动粘贴')
    expect(html).toContain('role="menuitemcheckbox"')
    expect(html).toContain('aria-checked="false"')
  })

  it('把已选中的手动模式明确标出来', () => {
    const html = renderToStaticMarkup(
      createElement(SearchMenu, {
        engines: [{ id: 'huaban', label: '花瓣' }],
        mode: 'paste',
        onPick: vi.fn(),
        onModeChange: vi.fn(),
        onCropSearch: vi.fn()
      })
    )
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('✓ 复制图片并手动粘贴')
  })
})
