import { describe, expect, it } from 'vitest'
import { largestFromSrcset, parseSrcset } from './srcset'

describe('parseSrcset', () => {
  it('解析宽度与倍率描述符', () => {
    expect(parseSrcset('a.jpg 400w, b.jpg 800w')).toEqual([
      { url: 'a.jpg', width: 400, density: null },
      { url: 'b.jpg', width: 800, density: null }
    ])
    expect(parseSrcset('a.jpg 1x, b.jpg 2x')).toEqual([
      { url: 'a.jpg', width: null, density: 1 },
      { url: 'b.jpg', width: null, density: 2 }
    ])
  })

  it('没有描述符的条目没有宽度也没有倍率', () => {
    expect(parseSrcset('a.jpg')).toEqual([{ url: 'a.jpg', width: null, density: null }])
  })

  it('跳过空条目', () => {
    expect(parseSrcset('a.jpg 1x, , b.jpg 2x')).toHaveLength(2)
    expect(parseSrcset('   ')).toEqual([])
  })
})

describe('largestFromSrcset', () => {
  it('取宽度最大的一档', () => {
    expect(largestFromSrcset('s.jpg 240w, l.jpg 1200w, m.jpg 658w')).toBe('l.jpg')
  })

  it('取倍率最大的一档', () => {
    expect(largestFromSrcset('a.jpg 1x, b.jpg 3x, c.jpg 2x')).toBe('b.jpg')
  })

  it('倍率档胜过没有描述符的档', () => {
    expect(largestFromSrcset('plain.jpg, big.jpg 2x')).toBe('big.jpg')
  })

  it('只有一档时就用它', () => {
    expect(largestFromSrcset('only.jpg 480w')).toBe('only.jpg')
  })

  it('空输入返回 null', () => {
    expect(largestFromSrcset(null)).toBeNull()
    expect(largestFromSrcset(undefined)).toBeNull()
    expect(largestFromSrcset('')).toBeNull()
  })
})
