import type { AssetCrop } from './node'

export const FULL_CROP: AssetCrop = { x: 0, y: 0, w: 1, h: 1 }
const MIN_CROP = 0.02

export function cropOf(value: AssetCrop | undefined): AssetCrop {
  return value ? normalizeCrop(value) : { ...FULL_CROP }
}

export function normalizeCrop(value: AssetCrop): AssetCrop {
  const left = clamp(value.x, 0, 1 - MIN_CROP)
  const top = clamp(value.y, 0, 1 - MIN_CROP)
  const right = clamp(value.x + value.w, left + MIN_CROP, 1)
  const bottom = clamp(value.y + value.h, top + MIN_CROP, 1)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export function isFullCrop(value: AssetCrop): boolean {
  const crop = normalizeCrop(value)
  return crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1
}

/** 快捷裁切：把缩放框的变化映射回当前可见的原图区域。 */
export function cropFromResize(
  before: AssetCrop,
  base: { x: number; y: number; w: number; h: number },
  next: { x: number; y: number; w: number; h: number }
): AssetCrop {
  if (base.w <= 0 || base.h <= 0) return normalizeCrop(before)
  const x = before.x + ((next.x - base.x) / base.w) * before.w
  const y = before.y + ((next.y - base.y) / base.h) * before.h
  const w = (next.w / base.w) * before.w
  const h = (next.h / base.h) * before.h
  return normalizeCrop({ x, y, w, h })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
