import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { thumbnailNameFor } from '../shared/asset-url'
import { createRemoveNodesCommand } from '../shared/tree-commands'
import { listAssets, type Asset } from './assets'
import { loadGraph, saveGraph } from './nodes'

/**
 * 原图被外部删掉后的自动清理。
 *
 * 用户在 Finder 里删掉素材文件后，库里还留着素材记录、缩略图缓存和画布节点：
 * 侧栏靠缓存的缩略图继续显示预览，画布则画一块"素材缺失"的占位。这里把三者一起清掉，
 * 让"文件没了"直接等于"项目里也没有它"，而不是留下一个点不动的占位块。
 *
 * 只处理**托管素材**（`assets/` 下按内容哈希命名的文件）。外部链接文件夹里的图片由
 * Finder 自己管理，扫描列表时会自然消失，不归这里删。
 */
export interface PruneDeps {
  db: DatabaseSync
  assetsDir: string
  thumbnailsDir: string
  /** 文件在不在；注入进来便于测试 */
  exists?: (path: string) => boolean
}

export interface PruneResult {
  removedAssetIds: string[]
  removedNodes: number
  /** 节点被清掉的项目；界面据此决定要不要刷新当前画布 */
  projectIds: string[]
}

export function pruneMissingAssets(deps: PruneDeps): PruneResult {
  const exists = deps.exists ?? existsSync
  const result: PruneResult = { removedAssetIds: [], removedNodes: 0, projectIds: [] }

  const missing = new Map<string, Asset>()
  const present = new Set<string>()
  for (const asset of listAssets(deps.db)) {
    if (exists(join(deps.assetsDir, asset.fileName))) present.add(asset.id)
    else missing.set(asset.id, asset)
  }

  // 先按项目清节点：直接删行会留下父节点 childIds 里的悬空 id。
  // 连"素材记录都不存在"的节点也算在里面——它同样只会在画布上变成占位。
  //
  // **只查节点表、不把每个项目的图都读进来**：切回应用就会跑这一步，大库里
  // "所有项目 loadGraph → saveGraph" 才是卡顿来源。轻量查询先找出受影响的
  // 项目，没有受影响的项目就一个图都不用载入。
  const rows = deps.db
    .prepare("SELECT id, project_id, props FROM nodes WHERE type = 'asset'")
    .all() as unknown as { id: string; project_id: string; props: string }[]
  const doomedByProject = new Map<string, string[]>()
  for (const row of rows) {
    let assetId: unknown
    try {
      assetId = (JSON.parse(row.props) as { assetId?: unknown }).assetId
    } catch {
      assetId = null
    }
    // 素材文件没了、记录压根不存在、或 props 坏了，都只会在画布上变成占位
    if (typeof assetId === 'string' && present.has(assetId)) continue
    const doomed = doomedByProject.get(row.project_id)
    if (doomed) doomed.push(row.id)
    else doomedByProject.set(row.project_id, [row.id])
  }

  for (const [projectId, nodeIds] of doomedByProject) {
    const graph = loadGraph(deps.db, projectId)
    // 查询到载入之间可能有别的写入；只删此时真的还在图里的节点
    const alive = nodeIds.filter((id) => graph.nodes[id])
    if (alive.length === 0) continue

    saveGraph(deps.db, createRemoveNodesCommand(alive).apply(graph))
    result.removedNodes += alive.length
    result.projectIds.push(projectId)
  }

  const removeRow = deps.db.prepare('DELETE FROM assets WHERE id = ?')
  for (const [id, asset] of missing) {
    removeRow.run(id)
    result.removedAssetIds.push(id)
    // 缩略图缓存也删掉，否则它还会在侧栏里顶着一张已经不存在的原图
    void unlink(join(deps.thumbnailsDir, thumbnailNameFor(asset.fileName))).catch(() => undefined)
  }

  return result
}
