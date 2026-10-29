import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db'
import { DownloadError, type FetchLike } from './download'
import {
  describeImportFailure,
  expandCandidates,
  fileNameFor,
  importFromWeb,
  MAX_CANDIDATES,
  NO_USABLE_ADDRESS,
  type WebImportDeps
} from './web-import'

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
])

/** 记录每次请求的地址，方便断言"先试高清、再退回原地址"。 */
function recordingFetch(handlers: (url: string) => Response | null): {
  fetchImpl: FetchLike
  calls: string[]
} {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    const response = handlers(url)
    if (!response) throw new Error('network down')
    return response
  }
  return { fetchImpl, calls }
}

const ok = (): Response => new Response(PNG, { headers: { 'content-type': 'image/png' } })
const notImage = (): Response =>
  new Response('<html></html>', { headers: { 'content-type': 'text/html' } })

const HUABAN_THUMB = 'https://gd.huaban.com/img/abc_fw480webp'
const HUABAN_HD = 'https://gd.huaban.com/img/abc'
const PIN_PAGE = 'https://huaban.com/pins/123456'

/** 模拟花瓣那条真实拖放数据：uri-list 是图钉页链接，真图在 text/html 里。 */
const HUABAN_PAYLOAD = {
  textHtml: `<img src="${HUABAN_THUMB}" srcset="${HUABAN_THUMB} 480w, ${HUABAN_THUMB} 960w">`,
  textUriList: PIN_PAGE,
  textPlain: PIN_PAGE
}

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    '测试项目',
    '2026-10-15T00:00:00.000Z',
    '2026-10-15T00:00:00.000Z'
  )
  dir = mkdtempSync(join(tmpdir(), 'ins-pin-web-'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function deps(fetchImpl: FetchLike, over: Partial<WebImportDeps> = {}): WebImportDeps {
  const logger = { info: (): void => {}, error: (): void => {} }
  // 测试里不真的解码图片（那是 Electron 的 nativeImage 干的），尺寸留空不影响这些断言
  return { db, assetsDir: dir, measure: () => null, fetchImpl, logger, ...over }
}

describe('expandCandidates', () => {
  it('每个地址先试高清、再退回原地址，并标明哪条是升级来的', () => {
    expect(expandCandidates([HUABAN_THUMB])).toEqual([
      { url: HUABAN_HD, upgraded: true },
      { url: HUABAN_THUMB, upgraded: false }
    ])
  })

  it('认不出来的地址原样保留，不会凭空多一条', () => {
    const plain = 'https://example.com/a.png'
    expect(expandCandidates([plain])).toEqual([{ url: plain, upgraded: false }])
  })

  it('去重', () => {
    expect(expandCandidates([HUABAN_THUMB, HUABAN_THUMB])).toEqual([
      { url: HUABAN_HD, upgraded: true },
      { url: HUABAN_THUMB, upgraded: false }
    ])
  })
})

describe('fileNameFor', () => {
  it('用地址最后一段做名字', () => {
    expect(fileNameFor('https://cdn.example.com/pic/小猫.jpg?x=1', 'jpg')).toBe('小猫.jpg')
  })

  it('抠不出来就用兜底名', () => {
    expect(fileNameFor('not a url', 'webp')).toBe('网页图片.webp')
    expect(fileNameFor('https://cdn.example.com/', 'png')).toBe('网页图片.png')
  })
})

describe('describeImportFailure（D3.14 发生了什么 → 为什么 → 可以怎么做）', () => {
  it('不把 ERR_ 之类的底层报错甩给用户', () => {
    const text = describeImportFailure(new DownloadError('network', 'ERR_CONNECTION_RESET'))
    expect(text.message).not.toContain('ERR_')
    expect(text.message).toContain('没能连上')
    expect(text.hint.length).toBeGreaterThan(0)
  })

  it('每种失败都给得出"下一步能做什么"', () => {
    const reasons = [
      new DownloadError('http', 'x', 403),
      new DownloadError('http', 'x', 404),
      new DownloadError('http', 'x', 500),
      new DownloadError('not-image', 'x'),
      new DownloadError('too-large', '图片太大'),
      new DownloadError('timeout', '下载超时'),
      new DownloadError('network', 'x'),
      new Error('别的什么错')
    ]
    for (const error of reasons) {
      const text = describeImportFailure(error)
      expect(text.message.trim().length).toBeGreaterThan(0)
      expect(text.hint.trim().length).toBeGreaterThan(0)
    }
  })

  it('403/401 指向"直接拖进来"，404 指向"图已经不在了"', () => {
    expect(describeImportFailure(new DownloadError('http', 'x', 403)).message).toContain('不让外部取图')
    expect(describeImportFailure(new DownloadError('http', 'x', 404)).message).toContain('已经不在了')
  })
})

describe('importFromWeb · 花瓣那条路', () => {
  it('拿高清而不是 480 的缩略图，并把来源记进素材', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => (url === HUABAN_HD ? ok() : null))

    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: HUABAN_PAYLOAD,
      pageUrl: 'https://huaban.com/pins/123456',
      position: { x: 300, y: 200 }
    })

    expect(result.imported).toHaveLength(1)
    expect(result.upgraded).toBe(true)
    expect(result.resourceUrl).toBe(HUABAN_HD)
    // 先试的高清地址，缩略图压根没请求
    expect(calls).toEqual([HUABAN_HD])

    const asset = result.imported[0]!.asset
    expect(asset.resourceUrl).toBe(HUABAN_HD)
    expect(asset.pageUrl).toBe('https://huaban.com/pins/123456')
    expect(asset.importMethod).toBe('drag')
  })

  it('落在用户松手的位置，不是按序号错开的地方', async () => {
    const { fetchImpl } = recordingFetch(() => ok())
    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: HUABAN_PAYLOAD,
      pageUrl: null,
      position: { x: 512, y: 384 }
    })

    const node = result.imported[0]!.node
    expect({ x: node.x, y: node.y }).toEqual({ x: 512, y: 384 })
  })

  it('没给落点就按序号错开摆', async () => {
    const { fetchImpl } = recordingFetch(() => ok())
    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: HUABAN_PAYLOAD,
      pageUrl: null,
      position: null
    })
    expect(result.imported[0]!.node.x).toBe(120)
  })

  it('高清取不回来就退回原地址，并老实标上「低清副本」（D3.13）', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => (url === HUABAN_THUMB ? ok() : null))

    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: HUABAN_PAYLOAD,
      pageUrl: 'https://huaban.com/pins/123456',
      position: null
    })

    expect(result.imported).toHaveLength(1)
    expect(result.upgraded).toBe(false)
    expect(result.resourceUrl).toBe(HUABAN_THUMB)
    expect(calls).toEqual([HUABAN_HD, HUABAN_THUMB])
    expect(result.imported[0]!.node.props.badge).toBe('low-res')
  })

  it('拿到高清就不标低清（宁可不标，也不给好图贴低清）', async () => {
    const { fetchImpl } = recordingFetch(() => ok())
    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: HUABAN_PAYLOAD,
      pageUrl: null,
      position: null
    })
    expect(result.imported[0]!.node.props.badge).toBeUndefined()
  })

  it('认不出来的站点不给任何标签（拿不准一律不标）', async () => {
    const { fetchImpl } = recordingFetch(() => ok())
    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: { textPlain: 'https://cdn.example.com/a.png' },
      pageUrl: null,
      position: null
    })
    expect(result.imported[0]!.node.props.badge).toBeUndefined()
  })
})

describe('importFromWeb · 坏输入', () => {
  it('只有网页链接时不生成坏卡片，给一句人话', async () => {
    const { fetchImpl } = recordingFetch(() => notImage())

    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: { textUriList: PIN_PAGE, textPlain: PIN_PAGE },
      pageUrl: null,
      position: null
    })

    expect(result.imported).toHaveLength(0)
    expect(result.errors[0]!.message).toContain('不是图片')
  })

  it('一条可用地址都没有时直接说清楚，一个请求都不发', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ok())

    const result = await importFromWeb(deps(fetchImpl), 'p1', {
      payload: { textPlain: '随便一段没有地址的文字' },
      pageUrl: null,
      position: null
    })

    expect(result.errors[0]!.message).toBe(NO_USABLE_ADDRESS)
    expect(calls).toHaveLength(0)
  })

  it('最多只试前几个候选，不会一路试下去', async () => {
    const many = Array.from(
      { length: 6 },
      (_, i) => `<img src="https://cdn.example.com/p${i}.png">`
    ).join('')
    const { fetchImpl, calls } = recordingFetch(() => null)

    await importFromWeb(deps(fetchImpl), 'p1', {
      payload: { textHtml: many },
      pageUrl: null,
      position: null
    })

    expect(calls.length).toBe(MAX_CANDIDATES)
  })

  it('referer 用来源页面地址（图床靠它防盗链）', async () => {
    const seen: (RequestInit | undefined)[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init)
      return ok()
    }

    await importFromWeb(deps(fetchImpl), 'p1', {
      payload: { textPlain: 'https://cdn.example.com/a.png' },
      pageUrl: 'https://huaban.com/pins/9',
      position: null
    })

    expect(seen[0]?.referrer).toBe('https://huaban.com/pins/9')
    expect(seen[0]?.credentials).toBe('include')
  })
})
