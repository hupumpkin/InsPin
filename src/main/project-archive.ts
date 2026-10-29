import type { DatabaseSync } from 'node:sqlite'
import type { AssetInfo, ImportMethod } from '../shared/ipc'
import type { Node, ProjectGraph } from '../shared/node'
import { getAsset, saveAsset, type Asset } from './assets'
import { createProject, getProject, PROJECT_NAME_MAX } from './projects'
import { loadGraph, saveGraph } from './nodes'

/**
 * 项目导出 / 导入（路线图 D6a.2：换台机器也能把项目搬过去）。
 *
 * **形态是一个文件夹**（`<项目名>.ins-pin/`），里面一份 `project.json` 加一个
 * `assets/`。没用压缩包是因为项目里没有 zip 依赖，为这一个功能引一个库不划算
 * （用户的规矩：加依赖先问）；文件夹照样能整个拷走。
 *
 * 文件读写抽成 `ArchiveFs` 注入：归档逻辑本身能在内存文件系统上单测，
 * 不用真的碰磁盘。
 */

export const ARCHIVE_FORMAT = 'ins-pin-project'
export const ARCHIVE_VERSION = 1
export const MANIFEST_NAME = 'project.json'
export const ASSETS_DIR_NAME = 'assets'

export interface ArchiveFs {
  mkdir(path: string): Promise<void>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  readFile(path: string): Promise<Uint8Array>
}

/** 归档里的素材条目（就是 assets 表那一行的可搬运版本）。 */
export interface ArchiveAsset {
  id: string
  fileName: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  importMethod: ImportMethod
  sourceUrl: string | null
  resourceUrl: string | null
  pageUrl: string | null
  createdAt: string
}

export interface ArchiveManifest {
  format: string
  version: number
  name: string
  exportedAt: string
  graph: ProjectGraph
  assets: ArchiveAsset[]
}

export type ExportResult =
  | { ok: true; dir: string; assetCount: number }
  | { ok: false; message: string }

export type ImportResult =
  | { ok: true; projectId: string; name: string; nodeCount: number; assetCount: number }
  | { ok: false; message: string }

export interface ArchiveDeps {
  db: DatabaseSync
  /** 本机的素材目录（导出时从这儿读、导入时往这儿写） */
  assetsDir: string
  fs: ArchiveFs
  newId: () => string
  now: () => string
}

/** 只保留文件名，挡掉归档里被塞进路径分隔符的脏数据。 */
function safeName(name: string): string | null {
  if (name.length === 0) return null
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  if (name === '.' || name === '..') return null
  return name
}

function toArchiveAsset(asset: Asset): ArchiveAsset {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mime: asset.mime,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    importMethod: asset.importMethod,
    sourceUrl: asset.sourceUrl,
    resourceUrl: asset.resourceUrl,
    pageUrl: asset.pageUrl,
    createdAt: asset.createdAt
  }
}

/** 一个项目用到的 assetId（去重）。 */
function usedAssetIds(graph: ProjectGraph): string[] {
  const ids = new Set<string>()
  for (const node of Object.values(graph.nodes)) {
    if (node.type === 'asset') ids.add(node.props.assetId)
  }
  return [...ids]
}

/**
 * 导出：写一份 manifest，再把用到的素材原图拷进 `assets/`。
 *
 * 素材是**按内容哈希命名**的，所以拷过去天然去重；清单里记的是文件名，
 * 导入侧不信任它，会再走一遍 `saveAsset` 的格式校验。
 */
export async function exportProject(
  deps: ArchiveDeps,
  projectId: string,
  targetDir: string
): Promise<ExportResult> {
  const project = getProject(deps.db, projectId)
  if (!project) return { ok: false, message: '这个项目已经不在了' }

  const graph = loadGraph(deps.db, projectId)
  const assets: ArchiveAsset[] = []
  const files: { name: string; bytes: Uint8Array }[] = []

  for (const assetId of usedAssetIds(graph)) {
    const asset = getAsset(deps.db, assetId)
    if (!asset) continue
    const name = safeName(asset.fileName)
    if (!name) continue
    let bytes: Uint8Array
    try {
      bytes = await deps.fs.readFile(joinPath(deps.assetsDir, name))
    } catch {
      // 原图已经不在了：跳过它，节点导入后会显示成"素材缺失"占位，
      // 而不是让整次导出失败
      continue
    }
    assets.push(toArchiveAsset(asset))
    files.push({ name, bytes })
  }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    name: project.name,
    exportedAt: deps.now(),
    // 项目 id 是本机的，搬过去没有意义，抹掉
    graph: { ...graph, projectId: '' },
    assets
  }

  await deps.fs.mkdir(targetDir)
  await deps.fs.mkdir(joinPath(targetDir, ASSETS_DIR_NAME))
  for (const file of files) {
    await deps.fs.writeFile(joinPath(joinPath(targetDir, ASSETS_DIR_NAME), file.name), file.bytes)
  }
  await deps.fs.writeFile(
    joinPath(targetDir, MANIFEST_NAME),
    new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  )

  return { ok: true, dir: targetDir, assetCount: files.length }
}

/** 路径拼接：归档内部只有一两层，不引 node:path（这样内存 fs 也好用）。 */
function joinPath(...parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .filter((part) => part.length > 0)
    .join('/')
}

const IMPORT_METHODS: ImportMethod[] = ['drag', 'pin', 'clipboard', 'capture', 'collect', 'file']

function sanitizeAsset(raw: unknown): ArchiveAsset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = value['id']
  const fileName = value['fileName']
  if (typeof id !== 'string' || typeof fileName !== 'string') return null
  if (!safeName(fileName)) return null

  const text = (input: unknown): string | null =>
    typeof input === 'string' && input.length > 0 ? input : null
  const num = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) ? input : null
  const method = value['importMethod']
  const width = num(value['width'])
  const height = num(value['height'])

  return {
    id,
    fileName,
    mime: typeof value['mime'] === 'string' ? value['mime'] : 'application/octet-stream',
    bytes: num(value['bytes']) ?? 0,
    width: width !== null && width > 0 ? width : null,
    height: height !== null && height > 0 ? height : null,
    importMethod:
      typeof method === 'string' && (IMPORT_METHODS as string[]).includes(method)
        ? (method as ImportMethod)
        : 'file',
    sourceUrl: text(value['sourceUrl']),
    resourceUrl: text(value['resourceUrl']),
    pageUrl: text(value['pageUrl']),
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : new Date(0).toISOString()
  }
}

/** 清单来自外部文件，形状一律先校验，坏数据宁可整份拒绝。 */
export function sanitizeManifest(raw: unknown): ArchiveManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (value['format'] !== ARCHIVE_FORMAT) return null
  if (value['version'] !== ARCHIVE_VERSION) return null

  const graph = value['graph']
  if (typeof graph !== 'object' || graph === null) return null
  const g = graph as { rootIds?: unknown; nodes?: unknown }
  if (!Array.isArray(g.rootIds) || typeof g.nodes !== 'object' || g.nodes === null) return null

  const assets = Array.isArray(value['assets'])
    ? value['assets'].map(sanitizeAsset).filter((a): a is ArchiveAsset => a !== null)
    : []

  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    name: typeof value['name'] === 'string' && value['name'].trim().length > 0 ? value['name'] : '导入的项目',
    exportedAt: typeof value['exportedAt'] === 'string' ? value['exportedAt'] : '',
    graph: graph as ProjectGraph,
    assets
  }
}

/**
 * 导入：**新建一个项目**，把图搬进去。
 *
 * 每个节点都换新 id（免得和本机已有的撞上），素材则按内容哈希重新落盘——
 * 同一张图在本机已经有的话，`saveAsset` 会自动去重、不重复占地方。
 */
export async function importProject(
  deps: ArchiveDeps,
  sourceDir: string,
  nameOverride?: string
): Promise<ImportResult> {
  let manifest: ArchiveManifest | null
  try {
    const bytes = await deps.fs.readFile(joinPath(sourceDir, MANIFEST_NAME))
    manifest = sanitizeManifest(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  } catch {
    manifest = null
  }
  if (!manifest) return { ok: false, message: '这不是一个 InsPin 项目文件夹' }

  // 名字来自外部文件，长的、空的都挡住——`createProject` 会直接抛
  const wanted = (nameOverride ?? manifest.name).trim().slice(0, PROJECT_NAME_MAX)
  const project = createProject(deps.db, wanted.length > 0 ? wanted : '导入的项目')
  const assetsDir = joinPath(sourceDir, ASSETS_DIR_NAME)

  // 素材按哈希重新落盘，顺手记下旧 id → 新 id 的对应
  const idMap = new Map<string, string>()
  let assetCount = 0
  for (const asset of manifest.assets) {
    try {
      const bytes = await deps.fs.readFile(joinPath(assetsDir, asset.fileName))
      const saved = await saveAsset(deps.db, deps.assetsDir, {
        bytes,
        importMethod: asset.importMethod,
        sourceUrl: asset.sourceUrl,
        resourceUrl: asset.resourceUrl,
        pageUrl: asset.pageUrl,
        width: asset.width,
        height: asset.height
      })
      idMap.set(asset.id, saved.asset.id)
      assetCount++
    } catch {
      // 这个素材文件缺了/读不出来：对应的节点导入后落到"素材缺失"占位
      continue
    }
  }

  // 节点换新 id，并把父子关系、childIds、素材引用一起改过去
  const nodeIdMap = new Map<string, string>()
  for (const oldId of Object.keys(manifest.graph.nodes)) nodeIdMap.set(oldId, deps.newId())

  const nodes: Record<string, Node> = {}
  for (const [oldId, node] of Object.entries(manifest.graph.nodes)) {
    const id = nodeIdMap.get(oldId)
    if (!id) continue
    const props =
      node.type === 'asset'
        ? { ...node.props, assetId: idMap.get(node.props.assetId) ?? node.props.assetId }
        : { ...node.props }
    nodes[id] = {
      ...node,
      id,
      projectId: project.id,
      parentId: node.parentId ? (nodeIdMap.get(node.parentId) ?? null) : null,
      childIds: node.childIds.flatMap((childId) => {
        const mapped = nodeIdMap.get(childId)
        return mapped ? [mapped] : []
      }),
      props
    } as Node
  }

  const rootIds = manifest.graph.rootIds.flatMap((oldId) => {
    const mapped = nodeIdMap.get(oldId)
    return mapped && nodes[mapped] ? [mapped] : []
  })

  saveGraph(deps.db, { projectId: project.id, rootIds, nodes })

  return {
    ok: true,
    projectId: project.id,
    name: project.name,
    nodeCount: Object.keys(nodes).length,
    assetCount
  }
}

/** 项目用到的、但文件已经不在磁盘上的素材（D6a.3 的体检数据来源）。 */
export interface MissingAsset {
  assetId: string
  fileName: string
  projectId: string
  nodeId: string
  nodeName: string
}
