import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 本机数据目录布局。所有数据都在同一个根目录下按用途隔离：
 * 删掉缩略图不影响素材，清空浏览器会话不影响项目。
 */
export interface DataPaths {
  /** 根目录 */
  root: string
  /** 素材原文件，按内容哈希命名，重复图片只存一份 */
  assets: string
  /** 缩略图缓存，可从原图重建，丢了不影响数据 */
  thumbnails: string
  /** 数据库目录 */
  database: string
  /** SQLite 数据库文件 */
  databaseFile: string
  /** 浏览器会话（登录态、缓存），可整体清除 */
  sessions: string
  /** 结构化日志（JSON Lines） */
  logs: string
}

export function resolveDataPaths(root: string): DataPaths {
  const database = join(root, 'database')
  return {
    root,
    assets: join(root, 'inspin-assets'),
    thumbnails: join(root, 'thumbnails'),
    database,
    databaseFile: join(database, 'ins-pin.db'),
    sessions: join(root, 'sessions'),
    logs: join(root, 'logs')
  }
}

/** 建立全部目录；已存在的原样保留，不会清空任何数据。 */
export function ensureDataDirs(paths: DataPaths): void {
  mkdirSync(paths.root, { recursive: true })

  // V2 把托管素材目录改为产品对用户承诺的 `inspin-assets`。迁移必须在窗口出现前
  // 完成，而复制几个 GB 的素材会让启动长时间无响应；新旧目录在同一个父目录下，
  // 直接改名是瞬时的，数据也没有丢失。只有在目标目录已经存在（上次迁移中断）时
  // 才退回逐文件复制。
  const legacyAssets = join(paths.root, 'assets')
  const migrationMarker = join(paths.root, '.inspin-assets-migrated')
  if (legacyAssets !== paths.assets && existsSync(legacyAssets) && !existsSync(migrationMarker)) {
    if (existsSync(paths.assets)) {
      // 哈希命名的素材不可变；允许覆盖可修复上次迁移中断留下的半文件。
      cpSync(legacyAssets, paths.assets, { recursive: true, force: true, errorOnExist: false })
    } else {
      try {
        renameSync(legacyAssets, paths.assets)
      } catch {
        // 极少数改不了名的情况（权限/跨卷）再走复制
        mkdirSync(paths.assets, { recursive: true })
        cpSync(legacyAssets, paths.assets, { recursive: true, force: true, errorOnExist: false })
      }
    }
    writeFileSync(migrationMarker, 'v2\n')
  }

  for (const dir of [
    paths.assets,
    paths.thumbnails,
    paths.database,
    paths.sessions,
    paths.logs
  ]) {
    mkdirSync(dir, { recursive: true })
  }
}
