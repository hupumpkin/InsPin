import { describe, expect, it } from 'vitest'
import {
  captureCandidatesAt,
  preferredCaptureCandidate,
  stepCaptureCandidate,
  type CaptureCandidate
} from './capture-candidates'

const image: CaptureCandidate = { id: 'image', x: 100, y: 100, width: 180, height: 120, priority: 40 }
const shell: CaptureCandidate = { id: 'shell', x: 88, y: 88, width: 204, height: 144, priority: 120 }
const outer: CaptureCandidate = { id: 'outer', x: 70, y: 70, width: 260, height: 200, priority: 60 }
const candidates = [image, shell, outer]
const point = { x: 150, y: 150 }

describe('capture candidates', () => {
  it('优先命中语义更强的外壳框', () => {
    expect(captureCandidatesAt(candidates, point).map((candidate) => candidate.id)).toEqual([
      'shell',
      'outer',
      'image'
    ])
    expect(preferredCaptureCandidate(candidates, point)?.id).toBe('shell')
  })

  it('按面积在内外框之间切换且不循环', () => {
    expect(stepCaptureCandidate(candidates, point, shell, 'inner')?.id).toBe('image')
    expect(stepCaptureCandidate(candidates, point, shell, 'outer')?.id).toBe('outer')
    expect(stepCaptureCandidate(candidates, point, image, 'inner')?.id).toBe('image')
    expect(stepCaptureCandidate(candidates, point, outer, 'outer')?.id).toBe('outer')
  })

  it('指针不在候选框内时不返回误吸附', () => {
    expect(preferredCaptureCandidate(candidates, { x: 20, y: 20 })).toBeNull()
  })
})
