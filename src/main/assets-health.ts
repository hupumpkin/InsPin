import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * 素材体检（路线图 D6a.3）。
 *
 * "库里记着这张图，磁盘上却没有"是真实会发生的事：用户手动清了素材目录、
 * 拷项目时漏了文件、磁盘出过错。这一趟就是把这种节点找出来，好让界面
 * 明确告诉用户"哪几张丢了"，而不是画布上凭空少了几块、谁也说不清。
 *
 * 检查是**只读**的：不删记录、不动文件——体检的结论要给人看，不是替人做决定。
 */

export interface MissingAsset {
  assetId: string
  fileName: string
  projectId: string
  projectName: string
  nodeId: string
  nodeName: string
}

export interface HealthReport {
  /** 检查了多少个素材节点 */
  checkedNodes: number
  /** 涉及多少个素材文件 */
  checkedAssets: number
  missing: MissingAsset[]
  /** 缺失素材占的字节数（按库里的记录算） */
  missingBytes: number
}

export interface HealthDeps {
  db: DatabaseSync
  assetsDir: string
  /** 文件在不在；注入进来便于测试 */
  exists?: (path: string) => boolean
}

interface NodeRow {
  id: string
  name: string
  project_id: string
  props: string
}

interface AssetRow {
  id: string
  file_name: string
  bytes: number
}

export function checkAssetHealth(deps: HealthDeps): HealthReport {
  const exists = deps.exists ?? existsSync
  const { db } = deps

  const projectNames = new Map<string, string>()
  for (const row of db.prepare('SELECT id, name FROM projects').all() as unknown as {
    id: string
    name: string
  }[]) {
    projectNames.set(row.id, row.name)
  }

  const assets = new Map<string, AssetRow>()
  for (const row of db
    .prepare('SELECT id, file_name, bytes FROM assets')
    .all() as unknown as AssetRow[]) {
    assets.set(row.id, row)
  }

  const missing: MissingAsset[] = []
  const missingIds = new Set<string>()
  let checkedNodes = 0
  let missingBytes = 0

  for (const node of db
    .prepare("SELECT id, name, project_id, props FROM nodes WHERE type = 'asset'")
    .all() as unknown as NodeRow[]) {
    let assetId: string | null = null
    try {
      const props = JSON.parse(node.props) as { assetId?: unknown }
      if (typeof props.assetId === 'string') assetId = props.assetId
    } catch {
      // props 坏了当没有素材，别让体检整趟挂掉
    }
    if (!assetId) continue
    checkedNodes++

    const asset = assets.get(assetId)
    // 连记录都没有：也算缺失（节点指向了一个不存在的素材）
    if (!asset) {
      if (!missingIds.has(assetId)) missingIds.add(assetId)
      missing.push({
        assetId,
        fileName: '',
        projectId: node.project_id,
        projectName: projectNames.get(node.project_id) ?? '（项目已删）',
        nodeId: node.id,
        nodeName: node.name
      })
      continue
    }

    if (!exists(join(deps.assetsDir, asset.file_name))) {
      if (!missingIds.has(assetId)) {
        missingIds.add(assetId)
        missingBytes += asset.bytes
      }
      missing.push({
        assetId,
        fileName: asset.file_name,
        projectId: node.project_id,
        projectName: projectNames.get(node.project_id) ?? '（项目已删）',
        nodeId: node.id,
        nodeName: node.name
      })
    }
  }

  return {
    checkedNodes,
    checkedAssets: assets.size,
    missing,
    missingBytes
  }
}
