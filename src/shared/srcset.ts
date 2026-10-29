/**
 * `srcset` 解析（路线图 D3.11 的第一步）。
 *
 * 网站上同一个 `<img>` 常带好几档清晰度，拖放时要挑**最大**的那一档，
 * 否则拿到的永远是页面为了省流量给的缩略图。
 *
 * 纯函数，可直接单测。
 */

export interface SrcsetEntry {
  url: string
  /** `1200w` 这类宽度描述符 */
  width: number | null
  /** `2x` 这类倍率描述符 */
  density: number | null
}

/** 没有描述符的条目按规范算 1x，这里折算成可比较的权重。 */
function weightOf(entry: SrcsetEntry): number {
  if (entry.width !== null) return entry.width
  if (entry.density !== null) return entry.density * 1000
  return 1000
}

export function parseSrcset(srcset: string): SrcsetEntry[] {
  const entries: SrcsetEntry[] = []

  for (const part of srcset.split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/)
    if (!url) continue

    let width: number | null = null
    let density: number | null = null
    if (descriptor?.endsWith('w')) {
      const parsed = Number.parseFloat(descriptor)
      if (!Number.isNaN(parsed)) width = parsed
    } else if (descriptor?.endsWith('x')) {
      const parsed = Number.parseFloat(descriptor)
      density = Number.isNaN(parsed) ? 1 : parsed
    }

    entries.push({ url, width, density })
  }

  return entries
}

/** 挑最清晰的一档；空输入返回 null。 */
export function largestFromSrcset(srcset: string | null | undefined): string | null {
  if (!srcset) return null

  let best: SrcsetEntry | null = null
  for (const entry of parseSrcset(srcset)) {
    if (!best || weightOf(entry) >= weightOf(best)) best = entry
  }
  return best?.url ?? null
}
