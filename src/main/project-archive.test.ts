import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAssetNode, createGroupNode, type ProjectGraph } from '../shared/node'
import { sha256Of } from './assets'
import { openDatabase } from './db'
import { loadGraph, saveGraph } from './nodes'
import { createProject } from './projects'
import {
  ASSETS_DIR_NAME,
  exportProject,
  importProject,
  MANIFEST_NAME,
  sanitizeManifest,
  type ArchiveDeps
} from './project-archive'

/**
 * 这一组测试用**真的临时目录**。
 *
 * 本来想把文件系统抽成内存实现来测，但 `saveAsset`（素材落盘、格式校验、按哈希去重）
 * 是直接按真实文件系统写的——为了这个测试把它也改成注入式，是为了可测性去动生产代码，
 * 不划算。真临时目录一样快，而且测的就是真实路径拼法。
 */

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ins-pin-archive-'))
  tempDirs.push(dir)
  return dir
}

/** 真实文件系统版的 ArchiveFs。 */
const nodeFs = {
  mkdir: (path: string) => mkdir(path, { recursive: true }).then(() => undefined),
  writeFile: (path: string, bytes: Uint8Array) => writeFile(path, bytes),
  readFile: async (path: string) => new Uint8Array(await readFile(path)),
  exists: (path: string) =>
    stat(path).then(
      () => true,
      () => false
    )
}

/** 一张最小的合法 PNG（1×1），能过 saveAsset 的文件头与结构校验。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
])

let idSeq = 0
const newId = (): string => `new-${++idSeq}`

/** 造一个项目：两张图（一张在组里），素材文件按内容哈希落在素材目录里。 */
async function seed(): Promise<{
  db: ReturnType<typeof openDatabase>
  projectId: string
  fileName: string
  assetsDir: string
}> {
  const db = openDatabase(':memory:')
  const project = createProject(db, '项目A', { id: 'p1' })
  const assetsDir = await makeTempDir()

  const sha = sha256Of(PNG_BYTES)
  const fileName = `${sha}.png`
  db.prepare(
    `INSERT INTO assets (id, sha256, mime, bytes, width, height, file_name, import_method,
       source_url, resource_url, page_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
  ).run('a1', sha, 'image/png', PNG_BYTES.length, 1, 1, fileName, 'drag', '2026-10-15T00:00:00.000Z')
  await writeFile(join(assetsDir, fileName), PNG_BYTES)

  const img = createAssetNode({
    id: 'n1',
    projectId: project.id,
    name: '图',
    x: 10,
    y: 20,
    w: 100,
    h: 80,
    assetId: 'a1',
    naturalWidth: 1,
    naturalHeight: 1
  })
  const group = createGroupNode({ id: 'g1', projectId: project.id, name: '组', x: 0, y: 0, w: 10, h: 10 })
  const inner = createAssetNode({
    id: 'n2',
    projectId: project.id,
    name: '组里的图',
    parentId: 'g1',
    x: 1,
    y: 2,
    w: 5,
    h: 5,
    assetId: 'a1',
    naturalWidth: 1,
    naturalHeight: 1
  })
  group.childIds = ['n2']
  const graph: ProjectGraph = {
    projectId: project.id,
    rootIds: ['n1', 'g1'],
    nodes: { n1: img, g1: group, n2: inner }
  }
  saveGraph(db, graph)

  return { db, projectId: project.id, fileName, assetsDir }
}

function depsFor(db: ReturnType<typeof openDatabase>, assetsDir: string): ArchiveDeps {
  return { db, assetsDir, fs: nodeFs, newId, now: () => '2026-10-15T10:00:00.000Z' }
}

describe('exportProject / importProject', () => {
  it('导出清单 + 素材，导回来是一份等价的项目（节点换新 id）', async () => {
    const { db, projectId, assetsDir } = await seed()
    const out = await makeTempDir()
    const deps = depsFor(db, assetsDir)

    const exported = await exportProject(deps, projectId, join(out, '项目A.ins-pin'))
    expect(exported.ok).toBe(true)
    expect(exported.ok && exported.assetCount).toBe(1)

    const manifest = JSON.parse(
      new TextDecoder().decode(await readFile(join(out, '项目A.ins-pin', MANIFEST_NAME)))
    )
    expect(manifest.format).toBe('ins-pin-project')
    expect(manifest.graph.projectId).toBe('') // 本机 id 不外泄
    expect(manifest.assets).toHaveLength(1)
    expect(await nodeFs.exists(join(out, '项目A.ins-pin', ASSETS_DIR_NAME, manifest.assets[0].fileName))).toBe(
      true
    )

    // 导成新项目：id 全部换新，原项目原样不动
    const imported = await importProject(deps, join(out, '项目A.ins-pin'), '搬过来的项目')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.name).toBe('搬过来的项目')
    expect(imported.nodeCount).toBe(3)
    expect(imported.assetCount).toBe(1)

    const graph = loadGraph(db, imported.projectId)
    expect(graph.rootIds).toHaveLength(2)
    expect(Object.keys(graph.nodes).every((id) => !['n1', 'n2', 'g1'].includes(id))).toBe(true)
    // 父子关系与 childIds 一起搬过来了
    const group = Object.values(graph.nodes).find((n) => n.type === 'group')
    expect(group?.childIds).toHaveLength(1)
    expect(graph.nodes[group!.childIds[0]!]?.parentId).toBe(group!.id)
    // 素材按内容哈希去重：同一张图不重复落盘
    expect(db.prepare('SELECT COUNT(*) c FROM assets').get()).toMatchObject({ c: 1 })
  })

  it('素材文件不在了：跳过它，但项目照样导出来', async () => {
    const { db, projectId, fileName, assetsDir } = await seed()
    const out = await makeTempDir()
    const deps = depsFor(db, assetsDir)
    await rm(join(assetsDir, fileName))

    const exported = await exportProject(deps, projectId, join(out, 'p'))
    expect(exported.ok).toBe(true)
    expect(exported.ok && exported.assetCount).toBe(0)
  })

  it('目录里没有清单 / 格式不对：给一句人话，不抛异常', async () => {
    const { db, assetsDir } = await seed()
    const out = await makeTempDir()
    const deps = depsFor(db, assetsDir)

    expect(await importProject(deps, join(out, '空目录'))).toMatchObject({ ok: false })

    const other = join(out, '别的')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, MANIFEST_NAME), JSON.stringify({ format: 'zip', version: 1 }))
    expect(await importProject(deps, other)).toMatchObject({ ok: false })
  })

  it('清单里带路径穿越的文件名会被丢掉', () => {
    const manifest = sanitizeManifest({
      format: 'ins-pin-project',
      version: 1,
      name: 'x',
      graph: { rootIds: [], nodes: {} },
      assets: [
        { id: 'a', fileName: '../../etc/passwd' },
        { id: 'b', fileName: 'ok.png' }
      ]
    })
    expect(manifest?.assets.map((a) => a.fileName)).toEqual(['ok.png'])
  })

  it('超长项目名被截到上限内，不会抛', async () => {
    const { db, projectId, assetsDir } = await seed()
    const out = await makeTempDir()
    const deps = depsFor(db, assetsDir)
    await exportProject(deps, projectId, join(out, 'p'))

    const imported = await importProject(deps, join(out, 'p'), 'x'.repeat(500))
    expect(imported.ok).toBe(true)
    expect(imported.ok && imported.name.length).toBeLessThanOrEqual(100)
  })
})
