import { describe, expect, it } from 'vitest'
import { DownloadError, downloadImage, type FetchLike } from './download'

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
])

const respond =
  (body: BodyInit | null, init: ResponseInit = {}): FetchLike =>
  async () =>
    new Response(body, init)

const INFO = { url: 'https://cdn.example.com/a.png' }

async function failure(options: Parameters<typeof downloadImage>[0]): Promise<DownloadError> {
  const error = await downloadImage(options).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(DownloadError)
  return error as DownloadError
}

describe('downloadImage 正常路径', () => {
  it('取回图片并识别出真实格式', async () => {
    const result = await downloadImage({
      ...INFO,
      fetchImpl: respond(PNG, { headers: { 'content-type': 'image/png' } })
    })

    expect(result.mime).toBe('image/png')
    expect(result.bytes).toEqual(PNG)
    expect(result.url).toBe(INFO.url)
  })

  it('服务端写成 octet-stream 时，以文件头为准', async () => {
    const result = await downloadImage({
      ...INFO,
      fetchImpl: respond(PNG, { headers: { 'content-type': 'application/octet-stream' } })
    })
    expect(result.mime).toBe('image/png')
  })

  it('完全没给 Content-Type 也能认出来', async () => {
    const result = await downloadImage({ ...INFO, fetchImpl: respond(PNG) })
    expect(result.mime).toBe('image/png')
  })
})

describe('referrer 的处理', () => {
  it('走 fetch 的 referrer 选项，而不是自己加 Referer 头', async () => {
    let captured: RequestInit | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = init
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    }

    await downloadImage({
      ...INFO,
      referer: 'https://www.huaban.com/pins/1',
      fetchImpl
    })

    expect(captured?.referrer).toBe('https://www.huaban.com/pins/1')
    expect(captured?.referrerPolicy).toBe('unsafe-url')
    // 手动设 Referer 头会被 Chromium 拦成 ERR_BLOCKED_BY_CLIENT，所以不该出现
    expect(captured?.headers).toBeUndefined()
  })

  it('没有来源页时不设 referrer', async () => {
    let captured: RequestInit | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = init
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    }

    await downloadImage({ ...INFO, fetchImpl })
    expect(captured?.referrer).toBeUndefined()
  })
})

describe('downloadImage 失败情况', () => {
  it('服务器报错', async () => {
    const error = await failure({
      ...INFO,
      fetchImpl: respond('nope', { status: 404 })
    })
    expect(error.reason).toBe('http')
    expect(error.status).toBe(404)
  })

  it('返回的是网页：提前拦掉，并说清楚是什么', async () => {
    const error = await failure({
      ...INFO,
      fetchImpl: respond('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    expect(error.reason).toBe('not-image')
    expect(error.message).toContain('网页')
    expect(error.message).toContain('text/html')
  })

  it('Content-Type 说是图片、内容却不是', async () => {
    const error = await failure({
      ...INFO,
      fetchImpl: respond('<html></html>', { headers: { 'content-type': 'image/png' } })
    })
    expect(error.reason).toBe('not-image')
  })

  it('内容为空', async () => {
    const error = await failure({
      ...INFO,
      fetchImpl: respond(new Uint8Array(), { headers: { 'content-type': 'image/png' } })
    })
    expect(error.reason).toBe('not-image')
    expect(error.message).toContain('没有返回内容')
  })

  it('按 Content-Length 提前拦掉超大文件', async () => {
    const error = await failure({
      ...INFO,
      maxBytes: 100,
      fetchImpl: respond(PNG, {
        headers: { 'content-type': 'image/png', 'content-length': '99999999' }
      })
    })
    expect(error.reason).toBe('too-large')
  })

  it('没有 Content-Length 时按实际大小拦', async () => {
    const big = new Uint8Array(2048)
    big.set(PNG.subarray(0, 8))
    const error = await failure({
      ...INFO,
      maxBytes: 100,
      fetchImpl: respond(big, { headers: { 'content-type': 'image/png' } })
    })
    expect(error.reason).toBe('too-large')
  })

  it('超时', async () => {
    const fetchImpl: FetchLike = async () => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    }
    const error = await failure({ ...INFO, fetchImpl, timeoutMs: 1000 })
    expect(error.reason).toBe('timeout')
  })

  it('网络错误', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const error = await failure({ ...INFO, fetchImpl })
    expect(error.reason).toBe('network')
    expect(error.message).toContain('ECONNREFUSED')
  })
})
