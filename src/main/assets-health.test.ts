import { describe, expect, it } from 'vitest'
import { createAssetNode, type ProjectGraph } from '../shared/node'
import { openDatabase } from './db'
import { saveGraph } from './nodes'
import { createProject } from './projects'
import { checkAssetHealth } from './assets-health'

function seed(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:')
  const project = createProject(db, '项目A', { id: 'p1' })
  db.prepare(
    `INSERT INTO assets (id, sha256, mime, bytes, width, height, file_name, import_method,
       source_url, resource_url, page_url, created_at)
     VALUES ('a1', 'sha1', 'image/png', 1000, 10, 10, 'a1.png', 'drag', NULL, NULL, NULL, 't'),
            ('a2', 'sha2', 'image/png', 2000, 10, 10, 'a2.png', 'drag', NULL, NULL, NULL, 't')`
  ).run()

  const graph: ProjectGraph = {
    projectId: project.id,
    rootIds: ['n1', 'n2', 'n3'],
    nodes: {
      n1: createAssetNode({
        id: 'n1',
        projectId: 'p1',
        name: '在的图',
        assetId: 'a1',
        naturalWidth: 10,
        naturalHeight: 10
      }),
      n2: createAssetNode({
        id: 'n2',
        projectId: 'p1',
        name: '丢了的图',
        assetId: 'a2',
        naturalWidth: 10,
        naturalHeight: 10
      }),
      n3: createAssetNode({
        id: 'n3',
        projectId: 'p1',
        name: '指向不存在的素材',
        assetId: 'a-not-exist',
        naturalWidth: 10,
        naturalHeight: 10
      })
    }
  }
  saveGraph(db, graph)
  return db
}

describe('checkAssetHealth', () => {
  it('把"文件不在磁盘上"和"素材记录都没了"都找出来', () => {
    const db = seed()
    // 只让 a1 的文件存在
    const report = checkAssetHealth({
      db,
      assetsDir: '/assets',
      exists: (path) => path === '/assets/a1.png'
    })

    expect(report.checkedNodes).toBe(3)
    expect(report.checkedAssets).toBe(2)
    expect(report.missing.map((m) => m.nodeName).sort()).toEqual(['丢了的图', '指向不存在的素材'].sort())
    // 缺失字节只算"记录还在、文件没了"的那一张
    expect(report.missingBytes).toBe(2000)
    expect(report.missing.every((m) => m.projectName === '项目A')).toBe(true)
  })

  it('都在的时候报告是干净的', () => {
    const db = seed()
    const report = checkAssetHealth({
      db,
      assetsDir: '/assets',
      exists: (path) => path.startsWith('/assets/') && !path.endsWith('/a-not-exist')
    })
    // 只有那条指向不存在素材的还会被算出来
    expect(report.missing).toHaveLength(1)
    expect(report.missing[0]?.assetId).toBe('a-not-exist')
  })

  it('体检是只读的：不改库也不动文件', () => {
    const db = seed()
    const before = db.prepare('SELECT COUNT(*) c FROM nodes').get()
    checkAssetHealth({ db, assetsDir: '/assets', exists: () => false })
    expect(db.prepare('SELECT COUNT(*) c FROM nodes').get()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) c FROM assets').get()).toMatchObject({ c: 2 })
  })
})
