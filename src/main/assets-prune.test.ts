import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAssetNode, type ProjectGraph } from '../shared/node'
import { pruneMissingAssets } from './assets-prune'
import { openDatabase } from './db'
import { saveGraph } from './nodes'
import { createProject } from './projects'

let db: ReturnType<typeof openDatabase>
let root: string
let assetsDir: string
let thumbnailsDir: string

beforeEach(() => {
  db = openDatabase(':memory:')
  root = mkdtempSync(join(tmpdir(), 'inspin-prune-'))
  assetsDir = join(root, 'assets')
  thumbnailsDir = join(root, 'thumbs')
  mkdirSync(assetsDir)
  mkdirSync(thumbnailsDir)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function seedAssets(): void {
  db.prepare(
    `INSERT INTO assets (id, sha256, mime, bytes, width, height, file_name, import_method,
       source_url, resource_url, page_url, created_at)
     VALUES ('a1', 'sha1', 'image/png', 1000, 10, 10, 'a1.png', 'drag', NULL, NULL, NULL, 't'),
            ('a2', 'sha2', 'image/png', 2000, 10, 10, 'a2.png', 'drag', NULL, NULL, NULL, 't')`
  ).run()
}

function assetGraph(projectId: string, ids: Record<string, string>): ProjectGraph {
  const nodes = Object.fromEntries(
    Object.entries(ids).map(([nodeId, assetId]) => [
      nodeId,
      createAssetNode({
        id: nodeId,
        projectId,
        name: nodeId,
        assetId,
        naturalWidth: 10,
        naturalHeight: 10
      })
    ])
  )
  return { projectId, rootIds: Object.keys(ids), nodes }
}

describe('pruneMissingAssets', () => {
  it('原图不在时，素材记录和所有项目里的节点一起清掉', () => {
    seedAssets()
    const p1 = createProject(db, '项目A', { id: 'p1' })
    const p2 = createProject(db, '项目B', { id: 'p2' })
    saveGraph(db, assetGraph(p1.id, { n1: 'a1', n2: 'a2' }))
    saveGraph(db, assetGraph(p2.id, { n3: 'a2' }))
    writeFileSync(join(thumbnailsDir, 'a2.thumb.png'), 'x')

    const result = pruneMissingAssets({
      db,
      assetsDir,
      thumbnailsDir,
      exists: (path) => path === join(assetsDir, 'a1.png')
    })

    expect(result.removedAssetIds).toEqual(['a2'])
    expect(result.removedNodes).toBe(2)
    expect(result.projectIds.sort()).toEqual(['p1', 'p2'])
    expect(db.prepare('SELECT id FROM assets ORDER BY id').all()).toEqual([{ id: 'a1' }])
    expect(db.prepare('SELECT id FROM nodes ORDER BY id').all()).toEqual([{ id: 'n1' }])
  })

  it('节点指向不存在的素材记录时也清掉（否则只会在画布上留占位）', () => {
    seedAssets()
    const p1 = createProject(db, '项目A', { id: 'p1' })
    saveGraph(db, assetGraph(p1.id, { n1: 'a1', n2: 'a-not-exist' }))

    const result = pruneMissingAssets({
      db,
      assetsDir,
      thumbnailsDir,
      exists: (path) => path.startsWith(assetsDir)
    })

    expect(result.removedAssetIds).toEqual([])
    expect(result.removedNodes).toBe(1)
    expect(db.prepare('SELECT id FROM nodes').all()).toEqual([{ id: 'n1' }])
  })

  it('文件都在时不动库', () => {
    seedAssets()
    const p1 = createProject(db, '项目A', { id: 'p1' })
    saveGraph(db, assetGraph(p1.id, { n1: 'a1', n2: 'a2' }))

    const result = pruneMissingAssets({
      db,
      assetsDir,
      thumbnailsDir,
      exists: (path) => path.startsWith(assetsDir)
    })

    expect(result).toEqual({ removedAssetIds: [], removedNodes: 0, projectIds: [] })
    expect(db.prepare('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 2 })
  })
})
