import { describe, expect, it } from 'vitest'
import { CaptureSession } from './capture'

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
