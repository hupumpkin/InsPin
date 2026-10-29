import type { DatabaseSync } from 'node:sqlite'

/**
 * 在画布图写入后立刻同步素材的引用时钟。这样 3 天从“最后一个画布引用消失”
 * 开始计算，而不是等用户下次打开素材侧栏才开始。
 *
 * 这是**每次画布保存都会走的热路径**，所以用两条批量 SQL，而不是把整张素材表
 * 读进 JS 逐个比对：素材上千张时，后者会明显拖慢主进程。
 */
export function updateAssetReferenceClocks(db: DatabaseSync, now = new Date()): void {
  // 仍被画布引用的素材：清掉无引用计时与回收站状态
  db.prepare(
    `UPDATE assets
     SET unreferenced_since = NULL, trashed_at = NULL
     WHERE (unreferenced_since IS NOT NULL OR trashed_at IS NOT NULL)
       AND id IN (
         SELECT json_extract(props, '$.assetId')
         FROM nodes
         WHERE type = 'asset' AND json_extract(props, '$.assetId') IS NOT NULL
       )`
  ).run()

  // 临时素材第一次失去全部引用：从这一刻开始计 3 天
  db.prepare(
    `UPDATE assets
     SET unreferenced_since = ?
     WHERE retention_policy = 'temporary'
       AND trashed_at IS NULL
       AND unreferenced_since IS NULL
       AND id NOT IN (
         SELECT json_extract(props, '$.assetId')
         FROM nodes
         WHERE type = 'asset' AND json_extract(props, '$.assetId') IS NOT NULL
       )`
  ).run(now.toISOString())
}
