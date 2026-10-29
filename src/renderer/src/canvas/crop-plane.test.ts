import { describe, expect, it } from 'vitest'
import {
  commitCropBox,
  cropHandleAt,
  cropOfPlane,
  cropPixelSize,
  fitSelectionAspect,
  initialCropPlane,
  moveImage,
  moveSelection,
  resizeSelection,
  screenPointToLocal,
  zoomImage
} from './crop-plane'

describe('crop plane', () => {
  it('进入裁切时把当前裁切区域铺回整张原图，再算回去保持不变', () => {
    const plane = initialCropPlane(
      { x: 0, y: 0, w: 200, h: 100 },
      { x: 0.25, y: 0.1, w: 0.5, h: 0.4 }
    )
    expect(plane.image).toEqual({ x: -100, y: -25, w: 400, h: 250 })
    expect(plane.selection).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect(cropOfPlane(plane)).toEqual({ x: 0.25, y: 0.1, w: 0.5, h: 0.4 })
  })

  it('裁切框直接成为新的节点盒子（未旋转）', () => {
    expect(
      commitCropBox({ x: 100, y: 100, w: 200, h: 100 }, 0, { x: 100, y: 50, w: 100, h: 50 })
    ).toEqual({ x: 200, y: 150, w: 100, h: 50 })
  })

  it('旋转过的节点按中心位移，裁完不会跳', () => {
    expect(
      commitCropBox({ x: 0, y: 0, w: 100, h: 50 }, 90, { x: 50, y: 0, w: 50, h: 50 })
    ).toEqual({ x: 25, y: 25, w: 50, h: 50 })
  })

  it('拖框和拖图都被限制在图片范围内', () => {
    const image = { x: -100, y: -50, w: 300, h: 200 }
    const selection = { x: 0, y: 0, w: 100, h: 80 }
    expect(moveSelection(selection, 500, -500, image)).toEqual({ x: 100, y: -50, w: 100, h: 80 })
    expect(moveImage(image, 500, 500, selection)).toEqual({ x: 0, y: 0, w: 300, h: 200 })
  })

  it('滚轮缩放锚住光标，且缩到刚好盖住裁切框就停', () => {
    const image = { x: 0, y: 0, w: 400, h: 250 }
    const selection = { x: 0, y: 0, w: 200, h: 100 }
    expect(zoomImage(image, selection, { x: 100, y: 50 }, 2, 3200)).toEqual({
      x: -100, y: -50, w: 800, h: 500
    })
    expect(zoomImage(image, selection, { x: 100, y: 50 }, 0.1, 3200)).toEqual({
      x: 0, y: 0, w: 200, h: 125
    })
  })

  it('自由拖动边角，最小尺寸与图片边界都生效', () => {
    const image = { x: 0, y: 0, w: 200, h: 200 }
    expect(resizeSelection({ x: 0, y: 0, w: 100, h: 100 }, 'e', 50, 0, image, 1, null)).toEqual({
      x: 0, y: 0, w: 150, h: 100
    })
    expect(resizeSelection({ x: 0, y: 0, w: 100, h: 100 }, 'nw', -40, -40, image, 1, null)).toEqual({
      x: 0, y: 0, w: 100, h: 100
    })
  })

  it('固定比例时只按锚点等比缩放', () => {
    const image = { x: 0, y: 0, w: 400, h: 400 }
    expect(resizeSelection({ x: 0, y: 0, w: 100, h: 50 }, 'se', 50, 0, image, 1, 1)).toEqual({
      x: 0, y: 0, w: 150, h: 150
    })
    expect(resizeSelection({ x: 100, y: 100, w: 100, h: 100 }, 'n', 0, -50, image, 1, 1)).toEqual({
      x: 75, y: 50, w: 150, h: 150
    })
  })

  it('比例预设在当前框内居中取最大同比例区域', () => {
    expect(fitSelectionAspect({ x: 10, y: 10, w: 200, h: 100 }, 1)).toEqual({
      x: 60, y: 10, w: 100, h: 100
    })
  })

  it('手柄命中优先四角，框外不响应', () => {
    const selection = { x: 0, y: 0, w: 100, h: 100 }
    expect(cropHandleAt(selection, { x: 0, y: 0 }, 10)).toBe('nw')
    expect(cropHandleAt(selection, { x: 50, y: 0 }, 10)).toBe('n')
    expect(cropHandleAt(selection, { x: 0, y: 50 }, 10)).toBe('w')
    expect(cropHandleAt(selection, { x: 50, y: 50 }, 10)).toBeNull()
    expect(cropHandleAt(selection, { x: 200, y: 200 }, 10)).toBeNull()
  })

  it('指针坐标反向旋转回节点局部空间', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 }
    expect(screenPointToLocal({ x: 250, y: 175 }, { x: 200, y: 150 }, box, 0, 1)).toEqual({
      x: 100, y: 50
    })
    expect(screenPointToLocal({ x: 250, y: 175 }, { x: 200, y: 150 }, box, 90, 1)).toEqual({
      x: 75, y: -25
    })
  })

  it('按原图像素换算结果尺寸', () => {
    const plane = {
      image: { x: 0, y: 0, w: 400, h: 200 },
      selection: { x: 100, y: 50, w: 200, h: 100 }
    }
    expect(cropPixelSize(plane, 4000, 2000)).toEqual({ w: 2000, h: 1000 })
  })
})
