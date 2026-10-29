import { describe, expect, it } from 'vitest'
import { PAGE_CANDIDATES_SCRIPT, toCaptureCandidates } from './capture-candidates'

const BOX = { x: 100, y: 200, width: 800, height: 600 }

describe('toCaptureCandidates', () => {
  it('注入网页的候选脚本本身必须能被浏览器解析', () => {
    expect(() => new Function(PAGE_CANDIDATES_SCRIPT)).not.toThrow()
  })

  it('把网页视口坐标按浏览区比例换到主窗口坐标', () => {
    const collection = toCaptureCandidates(
      {
        viewportWidth: 400,
        viewportHeight: 300,
        candidates: [{ x: 20, y: 30, width: 100, height: 80, priority: 90 }]
      },
      BOX
    )
    expect(collection.candidates).toEqual([
      { id: 'capture-0', x: 140, y: 260, width: 200, height: 160, priority: 90 }
    ])
    expect(collection.originalUrls.size).toBe(0)
  })

  it('夹紧越界或异常数据，不让第三方页面制造窗口外的选框', () => {
    const collection = toCaptureCandidates(
      {
        viewportWidth: 400,
        viewportHeight: 300,
        candidates: [
          { x: -20, y: -10, width: 500, height: 400, priority: 60 },
          { x: 0, y: 0, width: 'bad', height: 90, priority: 80 }
        ]
      },
      BOX
    )
    expect(collection.candidates).toEqual([
      { id: 'capture-0', x: 100, y: 200, width: 800, height: 600, priority: 60 }
    ])
  })

  it('无法解析页面结果时安全退回自由框选', () => {
    expect(toCaptureCandidates(null, BOX).candidates).toEqual([])
    expect(toCaptureCandidates({ viewportWidth: 0, viewportHeight: 20, candidates: [] }, BOX).candidates).toEqual([])
  })

  it('只向界面暴露原图可用性，原图与来源地址留在主进程映射里', () => {
    const collection = toCaptureCandidates(
      {
        viewportWidth: 400,
        viewportHeight: 300,
        candidates: [
          {
            x: 20,
            y: 30,
            width: 100,
            height: 80,
            priority: 90,
            originalUrl: 'https://cdn.example.com/work.png',
            sourceUrl: 'https://www.behance.net/gallery/123456/Example-project'
          }
        ]
      },
      BOX
    )
    expect(collection.candidates[0]).toMatchObject({ id: 'capture-0', originalAvailable: true })
    expect(collection.originalUrls.get('capture-0')).toBe('https://cdn.example.com/work.png')
    expect(collection.sourceUrls.get('capture-0')).toBe('https://www.behance.net/gallery/123456/Example-project')
  })
})
