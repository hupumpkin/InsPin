import { describe, expect, it } from 'vitest'
import {
  activateTab,
  activeTab,
  addTab,
  canonicalTabUrl,
  closeTab,
  deserializeTabs,
  displayUrl,
  emptyBrowserState,
  findTab,
  isLocalStartPageUrl,
  moveTab,
  normalizeUrl,
  serializeTabs,
  START_PAGE_URL,
  updateTab,
  type BrowserState
} from './browser'

function seqIds(): () => string {
  let n = 0
  return () => `t${++n}`
}

function stateWith(...ids: string[]): BrowserState {
  return {
    tabs: ids.map((id) => ({ id, url: `https://${id}.com`, title: id })),
    activeId: ids[ids.length - 1] ?? null
  }
}

describe('addTab', () => {
  it('新标签插在当前标签右边并切过去', () => {
    const state = stateWith('a', 'b')
    // 当前是 b（最后），新标签接在 b 后面
    const next = addTab(state, { id: 'c', url: START_PAGE_URL, title: '' })
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
    expect(next.activeId).toBe('c')
  })

  it('当前在中间时，新标签插在它右边而不是末尾', () => {
    const state: BrowserState = { ...stateWith('a', 'b', 'c'), activeId: 'a' }
    const next = addTab(state, { id: 'new', url: START_PAGE_URL, title: '' })
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a', 'new', 'b', 'c'])
  })

  it('空状态时直接放第一个', () => {
    const next = addTab(emptyBrowserState(), { id: 'a', url: START_PAGE_URL, title: '' })
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a'])
    expect(next.activeId).toBe('a')
  })
})

describe('closeTab', () => {
  it('关当前标签：选右边那个', () => {
    const state: BrowserState = { ...stateWith('a', 'b', 'c'), activeId: 'b' }
    const next = closeTab(state, 'b')
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a', 'c'])
    expect(next.activeId).toBe('c')
  })

  it('关最右边时选左边', () => {
    const next = closeTab(stateWith('a', 'b'), 'b')
    expect(next.activeId).toBe('a')
  })

  it('关的不是当前标签时当前不变', () => {
    const state: BrowserState = { ...stateWith('a', 'b', 'c'), activeId: 'a' }
    const next = closeTab(state, 'c')
    expect(next.activeId).toBe('a')
  })

  it('关掉最后一个后没有当前标签', () => {
    const next = closeTab(stateWith('a'), 'a')
    expect(next.tabs).toEqual([])
    expect(next.activeId).toBeNull()
  })

  it('关不存在的标签是空操作', () => {
    const state = stateWith('a')
    expect(closeTab(state, '没有')).toBe(state)
  })
})

describe('activateTab / moveTab / updateTab', () => {
  it('切换只认存在的标签', () => {
    const state = stateWith('a', 'b')
    expect(activateTab(state, 'a').activeId).toBe('a')
    expect(activateTab(state, '没有').activeId).toBe('b')
  })

  it('拖动排序', () => {
    expect(moveTab(stateWith('a', 'b', 'c'), 'a', 2).tabs.map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(moveTab(stateWith('a', 'b', 'c'), 'c', 0).tabs.map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('更新某个标签的标题/进度', () => {
    const state = stateWith('a', 'b')
    const next = updateTab(state, 'a', { title: '新标题', progress: 0.5 })
    expect(findTab(next, 'a')).toMatchObject({ title: '新标题', progress: 0.5 })
    // 其他标签不受影响
    expect(findTab(next, 'b')?.title).toBe('b')
    // 不存在的标签不动
    expect(updateTab(state, '没有', { title: 'x' })).toBe(state)
  })

  it('activeTab 取当前标签', () => {
    expect(activeTab(stateWith('a', 'b'))?.id).toBe('b')
    expect(activeTab(emptyBrowserState())).toBeNull()
  })
})

describe('持久化', () => {
  it('存地址、标题、顺序与当前标签', () => {
    const state: BrowserState = { ...stateWith('a', 'b', 'c'), activeId: 'a' }
    const stored = serializeTabs(state)
    expect(stored.tabs.map((tab) => tab.url)).toEqual(['https://a.com', 'https://b.com', 'https://c.com'])
    expect(stored.activeIndex).toBe(0)
  })

  it('读回来：新 id、当前标签对上', () => {
    const state: BrowserState = { ...stateWith('a', 'b', 'c'), activeId: 'b' }
    const restored = deserializeTabs(serializeTabs(state), seqIds())
    expect(restored.tabs.map((tab) => tab.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com'
    ])
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['t1', 't2', 't3'])
    expect(restored.activeId).toBe('t2')
    expect(restored.tabs[1]).toMatchObject({ title: 'b', progress: null, error: null })
  })

  it('坏数据一律丢掉，回到空状态', () => {
    expect(deserializeTabs(null, seqIds()).tabs).toEqual([])
    expect(deserializeTabs({ tabs: '不是数组' }, seqIds()).tabs).toEqual([])
    expect(deserializeTabs({ tabs: [{ url: 123 }, {}, { url: '' }] }, seqIds()).tabs).toEqual([])
    expect(deserializeTabs({ tabs: [{ url: 'https://ok.com', title: 5 }] }, seqIds()).tabs).toHaveLength(1)
  })

  it('当前下标越界时夹回范围里', () => {
    const restored = deserializeTabs(
      { tabs: [{ url: 'https://a.com' }, { url: 'https://b.com' }], activeIndex: 99 },
      seqIds()
    )
    expect(restored.activeId).toBe('t2')
  })
})

describe('normalizeUrl / displayUrl', () => {
  it('域名补 https，起始页占位原样返回', () => {
    expect(normalizeUrl('huaban.com/pins/1')).toBe('https://huaban.com/pins/1')
    expect(normalizeUrl('https://a.com')).toBe('https://a.com')
    expect(normalizeUrl('http://a.com')).toBe('http://a.com')
    expect(normalizeUrl(START_PAGE_URL)).toBe(START_PAGE_URL)
    expect(normalizeUrl('  ')).toBe('')
  })

  it('起始页不显示地址', () => {
    expect(displayUrl({ id: 'a', url: START_PAGE_URL, title: '' })).toBe('')
    expect(displayUrl({ id: 'a', url: 'https://a.com', title: '' })).toBe('https://a.com')
    expect(displayUrl(null)).toBe('')
  })
})

describe('起始页地址规范化', () => {
  it('认得出本地起始页地址（端口会变，存了必然打不开）', () => {
    expect(isLocalStartPageUrl('http://127.0.0.1:57189/')).toBe(true)
    expect(isLocalStartPageUrl('http://127.0.0.1:57189')).toBe(true)
    expect(isLocalStartPageUrl('https://huaban.com/')).toBe(false)
    expect(isLocalStartPageUrl('http://localhost:1234/')).toBe(false)
  })

  it('规范化：起始页与本地起始页地址都收成占位符', () => {
    expect(canonicalTabUrl('http://127.0.0.1:57189/')).toBe(START_PAGE_URL)
    expect(canonicalTabUrl(START_PAGE_URL)).toBe(START_PAGE_URL)
    expect(canonicalTabUrl('https://huaban.com/')).toBe('https://huaban.com/')
  })
})
