import { describe, expect, it } from 'vitest'
import type { NativeImage } from 'electron'
import { CaptureSession } from './capture'

const BOX = { x: 20, y: 120, width: 800, height: 600 }

function fakeImage(): NativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 1600, height: 1200 }),
    toDataURL: () => 'data:image/png;base64,',
    toPNG: () => Buffer.alloc(0)
  } as unknown as NativeImage
}

const EMPTY_COLLECTION = {
  candidates: [],
  originalUrls: new Map<string, string>(),
  sourceUrls: new Map<string, string>(),
  viewportWidth: 1,
  viewportHeight: 1
}

describe('CaptureSession continuous collection layout', () => {
  it('keeps the first collection centered, then anchors every later item to its right with 24px gap', () => {
    const session = new CaptureSession()
    const center = { x: 640, y: 400 }

    expect(session.collectionPlacement(center)).toEqual({ at: null, center })

    session.rememberCollectionNode({ x: 420, y: 250, width: 360, height: 240 })
    expect(session.collectionPlacement({ x: 1000, y: 800 })).toEqual({
      at: { x: 804, y: 250 },
      center: null
    })

    // 锚点只认首张；后续图片只接续横向位置，顶边始终对齐首张。
    session.rememberCollectionNode({ x: 804, y: 250, width: 120, height: 600 })
    expect(session.collectionPlacement({ x: 1000, y: 800 })).toEqual({
      at: { x: 948, y: 250 },
      center: null
    })
  })
})

describe('CaptureSession switch freeze mode', () => {
  it('switches live / frozen without resetting the continuous layout anchor', () => {
    const session = new CaptureSession()
    session.begin(fakeImage(), BOX, EMPTY_COLLECTION, 'https://example.com', 'collect', true)
    session.rememberCollectionNode({ x: 100, y: 100, width: 200, height: 150 })

    const live = session.switchMode(
      fakeImage(),
      BOX,
      EMPTY_COLLECTION,
      'https://example.com',
      false
    )
    expect(live).toMatchObject({ ok: true, mode: 'collect', live: true })
    expect(session.hidesBrowser).toBe(false)
    expect(session.collectionPlacement({ x: 0, y: 0 })).toEqual({
      at: { x: 324, y: 100 },
      center: null
    })

    const frozen = session.switchMode(
      fakeImage(),
      BOX,
      EMPTY_COLLECTION,
      'https://example.com',
      true
    )
    expect(frozen).toMatchObject({ ok: true, mode: 'collect' })
    expect(frozen && 'live' in frozen ? frozen.live : undefined).toBeUndefined()
    expect(session.hidesBrowser).toBe(true)
    expect(session.collectionPlacement({ x: 0, y: 0 })).toEqual({
      at: { x: 324, y: 100 },
      center: null
    })
  })

  it('refuses to switch a normal region-capture session', () => {
    const session = new CaptureSession()
    session.begin(fakeImage(), BOX, EMPTY_COLLECTION, null, 'capture', true)
    expect(session.switchMode(fakeImage(), BOX, EMPTY_COLLECTION, null, false)).toBeNull()
    expect(session.switchToLive()).toBeNull()
  })

  it('switches back to scrolling without replacing the pending frame', () => {
    const session = new CaptureSession()
    session.begin(fakeImage(), BOX, EMPTY_COLLECTION, 'https://example.com', 'collect', true)
    session.rememberCollectionNode({ x: 100, y: 100, width: 200, height: 150 })

    const live = session.switchToLive()
    expect(live).toMatchObject({ ok: true, mode: 'collect', live: true, dataUrl: '' })
    expect(session.hidesBrowser).toBe(false)
    // 轻量切换不该重置连续排布，也不该丢掉已采集的第一张锚点。
    expect(session.collectionPlacement({ x: 0, y: 0 })).toEqual({
      at: { x: 324, y: 100 },
      center: null
    })
  })
})
