import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSourceUrl, startStartPageServer, type StartPageServer } from './start-page'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

let root: string
let server: StartPageServer | null = null

async function authorizedHeaders(target: StartPageServer): Promise<Record<string, string>> {
  const html = await (await fetch(target.url)).text()
  const match = /const START_PAGE_TOKEN = ("[a-f0-9]{64}");/.exec(html)
  if (!match?.[1]) throw new Error('start page token missing')
  return {
    'Content-Type': 'application/json',
    'X-InsPin-Start-Token': JSON.parse(match[1]) as string
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inspin-start-page-'))
})

afterEach(() => {
  server?.close()
  server = null
  rmSync(root, { recursive: true, force: true })
})

describe('normalizeSourceUrl', () => {
  it('省略协议时补 https，保留已有的 http(s)', () => {
    expect(normalizeSourceUrl('www.baidu.com')).toBe('https://www.baidu.com')
    expect(normalizeSourceUrl('baidu.com/s?wd=ins')).toBe('https://baidu.com/s?wd=ins')
    expect(normalizeSourceUrl('  www.baidu.com  ')).toBe('https://www.baidu.com')
    expect(normalizeSourceUrl('https://www.baidu.com/')).toBe('https://www.baidu.com/')
    expect(normalizeSourceUrl('http://192.168.1.2:8080/')).toBe('http://192.168.1.2:8080/')
  })

  it('拒绝非 http(s) 协议与空地址', () => {
    expect(normalizeSourceUrl('javascript:alert(1)')).toBe('')
    expect(normalizeSourceUrl('file:///etc/passwd')).toBe('')
    expect(normalizeSourceUrl('ftp://example.com')).toBe('')
    expect(normalizeSourceUrl('   ')).toBe('')
  })
})

describe('起始页默认站点迁移', () => {
  it('把旧默认站点换成设计稿的六个，并保留用户自己加的站点', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    writeFileSync(
      sourcesFile,
      JSON.stringify([
        { name: '花瓣', url: 'https://huaban.com/', id: 'huaban', key: 'huaban' },
        { name: '站酷', url: 'https://www.zcool.com.cn/', id: 'zcool', key: 'zcool' },
        { name: '小红书', url: 'https://www.xiaohongshu.com/', id: 'xiaohongshu', key: 'xiaohongshu' },
        { name: 'Dribbble', url: 'https://dribbble.com/', id: 'dribbble', key: 'dribbble' },
        { name: 'Pinterest', url: 'https://www.pinterest.com/', id: 'pinterest', key: 'pinterest' },
        { name: 'Behance', url: 'https://www.behance.net/', id: 'behance', key: 'behance' },
        { name: '我的网站', url: 'https://example.com/', id: 'custom' }
      ])
    )

    server = await startStartPageServer({ sourcesFile })
    const listed = (await (await fetch(`${server.url}sources`)).json()) as Array<{ name: string }>
    expect(listed.map((item) => item.name)).toEqual([
      'Dribbble',
      'Behance',
      'Pinterest',
      'X',
      'Pixiv',
      'ArtStation',
      '我的网站'
    ])

    const saved = JSON.parse(readFileSync(sourcesFile, 'utf8')) as Array<{ name: string }>
    expect(saved.map((item) => item.name)).toEqual(listed.map((item) => item.name))
  })

  it('只迁移一次：用户之后删掉 X 也不会被加回来', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    writeFileSync(
      sourcesFile,
      JSON.stringify([
        { name: 'Dribbble', url: 'https://dribbble.com/' },
        { name: 'Behance', url: 'https://www.behance.net/' }
      ])
    )
    server = await startStartPageServer({ sourcesFile })
    expect(server.listSourceUrls().some((url) => url.includes('x.com'))).toBe(true)

    const withoutX = (
      (await (await fetch(`${server.url}sources`)).json()) as Array<{ url: string }>
    ).filter((item) => !item.url.includes('x.com'))
    await fetch(`${server.url}sources`, {
      method: 'POST',
      headers: await authorizedHeaders(server),
      body: JSON.stringify(withoutX)
    })

    server.close()
    server = await startStartPageServer({ sourcesFile })
    expect(server.listSourceUrls().some((url) => url.includes('x.com'))).toBe(false)
  })
})

describe('起始页自定义网站', () => {
  it('保存时补全省略协议的地址，页面注入的也是绝对地址', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    server = await startStartPageServer({ sourcesFile })

    const save = await fetch(`${server.url}sources`, {
      method: 'POST',
      headers: await authorizedHeaders(server),
      body: JSON.stringify([{ name: '百度', url: 'www.baidu.com' }])
    })
    expect(save.status).toBe(204)

    const listed = await (await fetch(`${server.url}sources`)).json()
    expect(listed).toEqual([{ name: '百度', url: 'https://www.baidu.com' }])

    const html = await (await fetch(server.url)).text()
    expect(html).toContain('https://www.baidu.com')
    expect(html).not.toContain('href="www.baidu.com"')

    // 页面脚本是内联字符串，至少保证它能被解析（模板转义写错时这里会失败）
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const code of scripts) expect(() => new Function(code ?? '')).not.toThrow()
  })

  it('拒绝脚本协议地址', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    server = await startStartPageServer({ sourcesFile })

    const bad = await fetch(`${server.url}sources`, {
      method: 'POST',
      headers: await authorizedHeaders(server),
      body: JSON.stringify([{ name: '坏站点', url: 'javascript:alert(1)' }])
    })
    expect(bad.status).toBe(400)
  })

  it('把网站列表写到磁盘，并在重新启动后注入页面', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    server = await startStartPageServer({ sourcesFile })
    const custom = [{ id: 'a', name: '我的网站', url: 'https://example.com/' }]

    const save = await fetch(`${server.url}sources`, {
      method: 'POST',
      headers: await authorizedHeaders(server),
      body: JSON.stringify(custom)
    })
    expect(save.status).toBe(204)

    // 端口每次都变：重启服务后仍应拿回同一份
    server.close()
    server = await startStartPageServer({ sourcesFile })

    const listed = await (await fetch(`${server.url}sources`)).json()
    expect(listed).toEqual(custom)

    const html = await (await fetch(server.url)).text()
    expect(html).toContain('我的网站')
    expect(html).not.toContain('__INSPIN_STORED_SOURCES__')
  })

  it('拒绝不合法的网站列表，保留原数据', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    server = await startStartPageServer({ sourcesFile })

    const bad = await fetch(`${server.url}sources`, {
      method: 'POST',
      headers: await authorizedHeaders(server),
      body: JSON.stringify([{ name: 1, url: [] }])
    })
    expect(bad.status).toBe(400)
    expect(await (await fetch(`${server.url}sources`)).json()).toBeNull()
  })
})

describe('起始页自动抓站点信息', () => {
  it('拒绝没有起始页令牌的写入和站点抓取请求', async () => {
    server = await startStartPageServer({ sourcesFile: join(root, 'sources.json') })
    const save = await fetch(`${server.url}sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([])
    })
    const meta = await fetch(`${server.url}site-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' })
    })
    expect(save.status).toBe(403)
    expect(meta.status).toBe(403)
  })

  it('默认不访问本机与局域网地址', async () => {
    let hits = 0
    const site = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<title>不该访问</title>')
    })
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    const address = site.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      server = await startStartPageServer({ sourcesFile: join(root, 'sources.json') })
      const response = await fetch(`${server.url}site-meta`, {
        method: 'POST',
        headers: await authorizedHeaders(server),
        body: JSON.stringify({ url: `http://127.0.0.1:${port}/` })
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ name: '', icon: null })
      expect(hits).toBe(0)
    } finally {
      site.close()
    }
  })

  it('名称留空时抓网页标题，并优先取 apple-touch-icon', async () => {
    const site = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          '<html><head><title>测试 &amp; 站点</title>' +
            '<link rel="icon" sizes="32x32" href="/small.png">' +
            '<link rel="apple-touch-icon" sizes="180x180" href="/icon.png"></head></html>'
        )
        return
      }
      if (req.url === '/icon.png' || req.url === '/small.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(TINY_PNG)
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    const address = site.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      server = await startStartPageServer({
        sourcesFile: join(root, 'sources.json'),
        allowPrivateSiteMetaForTests: true
      })
      const response = await fetch(`${server.url}site-meta`, {
        method: 'POST',
        headers: await authorizedHeaders(server),
        body: JSON.stringify({ url: `http://127.0.0.1:${port}/` })
      })
      expect(response.status).toBe(200)
      const meta = (await response.json()) as { name: string; icon: string | null }
      expect(meta.name).toBe('测试 & 站点')
      expect(meta.icon).toMatch(/^data:image\/png;base64,/)
    } finally {
      site.close()
    }
  })
})

describe('起始页取消收藏', () => {
  it('移除后写回文件，重启也不会再出现', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    server = await startStartPageServer({ sourcesFile })
    const target = server.listSourceUrls().find((url) => url.includes('pinterest'))
    expect(target).toBeTruthy()
    expect(server.removeSource(target!)).toBe(true)
    expect(server.listSourceUrls().some((url) => url.includes('pinterest'))).toBe(false)
    expect(server.removeSource(target!)).toBe(false)

    server.close()
    server = null
    server = await startStartPageServer({ sourcesFile })
    expect(server.listSourceUrls().some((url) => url.includes('pinterest'))).toBe(false)
  })
})

describe('起始页收藏', () => {
  it('addSource 保存网址、标题与 favicon，重复收藏时覆盖而不是新增', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    server = await startStartPageServer({ sourcesFile })
    const favicon = 'data:image/png;base64,AAAA'

    expect(server.listSourceUrls()).toContain('https://dribbble.com/')
    expect(await server.addSource({ url: 'https://example.com', title: 'Example', favicon })).toBe(true)
    expect(server.listSourceUrls()).toContain('https://example.com')
    const first = JSON.parse(readFileSync(sourcesFile, 'utf8')) as Array<Record<string, unknown>>
    const favorite = first.find((item) => item.url === 'https://example.com')
    expect(favorite).toMatchObject({ name: 'Example', url: 'https://example.com', thumbnail: favicon })

    expect(await server.addSource({ url: 'https://example.com', title: 'Example 2' })).toBe(true)
    const second = JSON.parse(readFileSync(sourcesFile, 'utf8')) as Array<Record<string, unknown>>
    const matched = second.filter((item) => item.url === 'https://example.com')
    expect(matched).toHaveLength(1)
    expect(matched[0]).toMatchObject({ name: 'Example 2' })
    expect(matched[0]?.thumbnail).toBeUndefined()
  })

  it('拒绝非 http(s) 地址', async () => {
    server = await startStartPageServer({ sourcesFile: join(root, 'start-page-sources.json') })
    expect(await server.addSource({ url: 'javascript:alert(1)', title: '坏站点' })).toBe(false)
    expect(await server.addSource({ url: '', title: '空地址' })).toBe(false)
  })

  it('最多 12 个站点，重复收藏不占新位置', async () => {
    const sourcesFile = join(root, 'start-page-sources.json')
    server = await startStartPageServer({ sourcesFile })
    const startCount = server.listSourceUrls().length
    expect(startCount).toBe(6)
    for (let index = startCount; index < 12; index++) {
      expect(
        await server.addSource({
          url: `https://example${index}.com/`,
          title: `站点 ${index}`,
          favicon: 'data:image/png;base64,AAAA'
        })
      ).toBe(true)
    }
    expect(server.listSourceUrls()).toHaveLength(12)
    expect(
      await server.addSource({
        url: 'https://example99.com/',
        title: '第 13 个',
        favicon: 'data:image/png;base64,AAAA'
      })
    ).toBe(false)
    expect(
      await server.addSource({
        url: 'https://example6.com/',
        title: '改个名字',
        favicon: 'data:image/png;base64,AAAA'
      })
    ).toBe(true)
    expect(server.listSourceUrls()).toHaveLength(12)
  })
})
