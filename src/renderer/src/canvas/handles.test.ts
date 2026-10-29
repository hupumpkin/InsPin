import { describe, expect, it } from 'vitest'
import {
  cursorForHandle,
  handleAtPoint,
  handleCenter,
  isCorner,
  movingEdges,
  rotateAround,
  rotateZoneAtPoint,
  screenBox,
  screenInsertionLine,
  toLocalPoint
} from './handles'
import { boundsOfItems, boxesOfItems, onBoxEdge } from './hit-test'
import { createAssetNode, type Node } from '../../../shared/node'
import { buildScene } from '../../../shared/scene'

const viewport = (x: number, y: number, zoom: number) => ({ x, y, zoom })
const box = { x: 100, y: 50, w: 200, h: 100 }

describe('cursorForHandle', () => {
  it('四角是对角光标，四边是单向光标', () => {
    expect(cursorForHandle('nw')).toBe('nwse-resize')
    expect(cursorForHandle('se')).toBe('nwse-resize')
    expect(cursorForHandle('ne')).toBe('nesw-resize')
    expect(cursorForHandle('sw')).toBe('nesw-resize')
    expect(cursorForHandle('n')).toBe('ns-resize')
    expect(cursorForHandle('s')).toBe('ns-resize')
    expect(cursorForHandle('e')).toBe('ew-resize')
    expect(cursorForHandle('w')).toBe('ew-resize')
  })

  it('只有四角算"角"（角优先于边）', () => {
    expect(isCorner('nw')).toBe(true)
    expect(isCorner('se')).toBe(true)
    expect(isCorner('n')).toBe(false)
    expect(isCorner('w')).toBe(false)
  })
})

describe('movingEdges', () => {
  it('四角各动两条边，四边各动一条', () => {
    expect(movingEdges('nw')).toEqual({ left: true, right: false, top: true, bottom: false })
    expect(movingEdges('se')).toEqual({ left: false, right: true, top: false, bottom: true })
    expect(movingEdges('ne')).toEqual({ left: false, right: true, top: true, bottom: false })
    expect(movingEdges('sw')).toEqual({ left: true, right: false, top: false, bottom: true })
    expect(movingEdges('n')).toEqual({ left: false, right: false, top: true, bottom: false })
    expect(movingEdges('e')).toEqual({ left: false, right: true, top: false, bottom: false })
    expect(movingEdges('s')).toEqual({ left: false, right: false, top: false, bottom: true })
    expect(movingEdges('w')).toEqual({ left: true, right: false, top: false, bottom: false })
  })
})

describe('handleCenter', () => {
  it('100% 缩放下四角在角上、四边在中点', () => {
    const v = viewport(0, 0, 1)
    expect(handleCenter(box, 'nw', v)).toEqual({ x: 100, y: 50 })
    expect(handleCenter(box, 'ne', v)).toEqual({ x: 300, y: 50 })
    expect(handleCenter(box, 'se', v)).toEqual({ x: 300, y: 150 })
    expect(handleCenter(box, 'sw', v)).toEqual({ x: 100, y: 150 })
    expect(handleCenter(box, 'n', v)).toEqual({ x: 200, y: 50 })
    expect(handleCenter(box, 'e', v)).toEqual({ x: 300, y: 100 })
    expect(handleCenter(box, 's', v)).toEqual({ x: 200, y: 150 })
    expect(handleCenter(box, 'w', v)).toEqual({ x: 100, y: 100 })
  })

  it('跟着视图平移缩放走', () => {
    const v = viewport(10, -20, 2)
    expect(handleCenter(box, 'nw', v)).toEqual({ x: 210, y: 80 })
    expect(handleCenter(box, 'se', v)).toEqual({ x: 610, y: 280 })
  })
})

describe('handleAtPoint', () => {
  it('压在角上能认出来', () => {
    const v = viewport(0, 0, 1)
    expect(handleAtPoint(box, v, { x: 300, y: 150 })).toBe('se')
    expect(handleAtPoint(box, v, { x: 103, y: 47 })).toBe('nw')
  })

  it('压在边的中段认成边', () => {
    const v = viewport(0, 0, 1)
    expect(handleAtPoint(box, v, { x: 200, y: 50 })).toBe('n')
    expect(handleAtPoint(box, v, { x: 300, y: 100 })).toBe('e')
    expect(handleAtPoint(box, v, { x: 200, y: 150 })).toBe('s')
    expect(handleAtPoint(box, v, { x: 100, y: 100 })).toBe('w')
  })

  it('角落附近按角处理（角优先于边）', () => {
    const v = viewport(0, 0, 1)
    // 靠近右上角、又同时贴着上边：应该是 ne 而不是 n
    expect(handleAtPoint(box, v, { x: 296, y: 52 })).toBe('ne')
  })

  it('离得远就不认（包括矩形中心）', () => {
    const v = viewport(0, 0, 1)
    expect(handleAtPoint(box, v, { x: 200, y: 100 })).toBeNull()
    expect(handleAtPoint(box, v, { x: 340, y: 150 })).toBeNull()
  })

  it('缩放下命中区不跟着放大', () => {
    const v = viewport(0, 0, 0.5)
    // 0.5 倍下 ne 角在屏幕 (150,25)；容差仍是屏幕 8px，不随缩放变
    expect(handleAtPoint(box, v, { x: 156, y: 25 })).toBe('ne')
    expect(handleAtPoint(box, v, { x: 170, y: 25 })).toBeNull()
  })
})

describe('toLocalPoint / rotateAround', () => {
  it('不旋转时原样返回', () => {
    expect(toLocalPoint(box, 0, { x: 300, y: 150 })).toEqual({ x: 300, y: 150 })
  })

  it('节点转了 90°：世界里的点要反向转回未旋转的坐标系', () => {
    // box 中心 (200,100)。节点 +90° 时，(300,50) 反算回局部应为 (150,0)
    const local = toLocalPoint(box, 90, { x: 300, y: 50 })
    expect(local.x).toBeCloseTo(150)
    expect(local.y).toBeCloseTo(0)
  })

  it('转过去再转回来 = 原位', () => {
    const once = toLocalPoint(box, 37, { x: 260, y: 40 })
    const back = rotateAround(once, { x: 200, y: 100 }, 37)
    expect(back.x).toBeCloseTo(260)
    expect(back.y).toBeCloseTo(40)
  })

  it('节点转了 45° 后，它"看起来"的 ne 角仍判成 ne', () => {
    const v = viewport(0, 0, 1)
    const center = { x: 200, y: 100 }
    const neLocal = handleCenter(box, 'ne', v)
    // 节点转 45° 后，这个角在屏幕上跑到这里：
    const neOnScreen = rotateAround(neLocal, center, 45)
    // 判定先把屏幕点转回局部，于是仍应命中 ne
    expect(handleAtPoint(box, v, toLocalPoint(box, 45, neOnScreen))).toBe('ne')
  })
})

describe('rotateZoneAtPoint', () => {
  const v = viewport(0, 0, 1)

  it('角外侧一小圈算旋转区', () => {
    // nw 角在 (100,50)；往左上 12px 处
    expect(rotateZoneAtPoint(box, v, { x: 92, y: 42 })).toBe(true)
  })

  it('角上（缩放区）与远处都不算', () => {
    expect(rotateZoneAtPoint(box, v, { x: 100, y: 50 })).toBe(false)
    expect(rotateZoneAtPoint(box, v, { x: 40, y: 40 })).toBe(false)
  })

  it('框内部不算', () => {
    expect(rotateZoneAtPoint(box, v, { x: 200, y: 100 })).toBe(false)
  })
})

describe('screenBox', () => {
  it('世界矩形换算成屏幕盒子', () => {
    expect(screenBox(box, viewport(0, 0, 1))).toEqual({ left: 100, top: 50, width: 200, height: 100 })
    expect(screenBox(box, viewport(5, 5, 2))).toEqual({ left: 205, top: 105, width: 400, height: 200 })
  })
})

describe('screenInsertionLine', () => {
  it('竖线：长度随缩放，厚度固定 2px', () => {
    // 世界线：x=10、宽 2（厚度）、高 200（长度）；缩到 25%
    expect(screenInsertionLine({ x: 10, y: 20, w: 2, h: 200 }, viewport(0, 0, 0.25))).toEqual({
      left: 1.75,
      top: 5,
      width: 2,
      height: 50
    })
  })

  it('横线：长度随缩放，厚度固定 2px', () => {
    expect(screenInsertionLine({ x: 10, y: 20, w: 200, h: 2 }, viewport(0, 0, 0.25))).toEqual({
      left: 2.5,
      top: 4.25,
      width: 50,
      height: 2
    })
  })

  it('放大时厚度也不会变粗', () => {
    expect(screenInsertionLine({ x: 0, y: 0, w: 2, h: 100 }, viewport(0, 0, 4))).toEqual({
      left: 3,
      top: 0,
      width: 2,
      height: 400
    })
  })
})

const asset = (id: string, x: number, y: number, w = 100, h = 50): Node =>
  createAssetNode({
    id,
    projectId: 'p1',
    name: id,
    x,
    y,
    w,
    h,
    assetId: `a-${id}`,
    naturalWidth: w,
    naturalHeight: h
  })

const sceneOf = (nodes: Node[]): ReturnType<typeof buildScene> => {
  const map: Record<string, Node> = {}
  for (const node of nodes) map[node.id] = node
  return buildScene({ projectId: 'p1', rootIds: nodes.map((n) => n.id), nodes: map })
}

describe('boxesOfItems', () => {
  it('一次取出多个选中项各自的盒子', () => {
    const items = sceneOf([asset('a', 0, 0), asset('b', 300, 100)])
    const boxes = boxesOfItems(items, ['a', 'b'])

    expect(boxes.get('a')).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(boxes.get('b')).toEqual({ x: 300, y: 100, w: 100, h: 50 })
  })

  it('不存在的 id 不会凭空造盒子', () => {
    const items = sceneOf([asset('a', 0, 0)])
    expect(boxesOfItems(items, ['nope']).size).toBe(0)
    expect(boundsOfItems(items, ['nope'])).toBeNull()
  })
})

describe('onBoxEdge', () => {
  it('压边算 true、在框内部算 false、在框外算 false', () => {
    expect(onBoxEdge(box, { x: 100, y: 100 })).toBe(true) // 左边框上
    expect(onBoxEdge(box, { x: 300, y: 50 })).toBe(true) // 右上角
    expect(onBoxEdge(box, { x: 200, y: 100 })).toBe(false) // 正中
    expect(onBoxEdge(box, { x: 400, y: 100 })).toBe(false) // 框外
  })
})
