/**
 * 区域截图的坐标换算（路线图 D3.16）。
 *
 * 网页是**原生视图**，界面上画不出盖在它上面的选框，所以流程是：
 * 先把浏览区抓成一张图 → 藏掉原生视图 → 在界面上显示这张图让用户框选 →
 * 按框选的位置从原图里裁下来。
 *
 * 换算里有两个坑，都在这里处理掉：
 *   1. 抓下来的图是**设备像素**（Retina 是 2 倍），选框是 **CSS 像素**，要按倍率放大；
 *   2. 选框可能超出图片边界（用户在边缘拖远了），要夹回去，否则裁出来是黑边。
 */

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureSize {
  width: number
  height: number
}

/**
 * 窗口坐标里的选框 → 截图像素里的裁剪矩形。
 *
 * `origin` 是截取区域在窗口里的左上角（CSS 像素）；`selection` 用窗口坐标给。
 * 返回的矩形已经夹在图片范围内、并取整（`crop` 只认整数像素）。
 */
export function toImageCrop(
  selection: CropRect,
  origin: { x: number; y: number },
  image: CaptureSize,
  box: CaptureSize
): CropRect {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scaleX = image.width / box.width
  const scaleY = image.height / box.height

  const left = clamp((selection.x - origin.x) * scaleX, 0, image.width)
  const top = clamp((selection.y - origin.y) * scaleY, 0, image.height)
  const right = clamp((selection.x + selection.width - origin.x) * scaleX, 0, image.width)
  const bottom = clamp((selection.y + selection.height - origin.y) * scaleY, 0, image.height)

  return {
    x: Math.round(Math.min(left, right)),
    y: Math.round(Math.min(top, bottom)),
    width: Math.max(0, Math.round(Math.abs(right - left))),
    height: Math.max(0, Math.round(Math.abs(bottom - top)))
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 太小的框没有意义（手抖一下就是 1×1），当作没框。 */
export const MIN_CAPTURE_EDGE = 8

export function isUsableCrop(rect: CropRect): boolean {
  return rect.width >= MIN_CAPTURE_EDGE && rect.height >= MIN_CAPTURE_EDGE
}
