import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * 一键备份（路线图 D6a.1）。
 *
 * 备份出来的是**一个自带自洽的文件夹**，不依赖 InsPin 就能看懂、能拷走：
 *   InsPin备份-20261015-1930/
 *   ├── ins-pin.db      项目 / 节点 / 素材（一致快照，见下）
 *   ├── assets/         素材原图
 *   └── backup.json     这次备份的时间与数量，给人看的
 *
 * **为什么不直接拷 .db 文件**：数据库开着 WAL，最近写入可能还在 -wal 里，
 * 单拷 .db 会漏掉最新数据。`VACUUM INTO` 由 SQLite 自己产出一份合并完毕的
 * 干净副本，中途断电也不会留下半个文件。
 *
 * 缩略图不备份：它是缓存，能从原图重建（丢了不影响数据，见 `paths.ts`）。
 */

export const BACKUP_DB_NAME = 'ins-pin.db'
export const BACKUP_ASSETS_DIR = 'assets'
export const BACKUP_META_NAME = 'backup.json'

export interface BackupMeta {
  /** 备份格式版本，将来要改结构时靠它认出来 */
  version: 1
  createdAt: string
  appVersion: string
  assetFiles: number
  assetBytes: number
}

export type BackupResult =
  | { ok: true; dir: string; assetFiles: number; bytes: number }
  | { ok: false; message: string }

export interface BackupDeps {
  db: DatabaseSync
  assetsDir: string
  /** 备份时间（ISO）；注入进来，测试里不必依赖真实时钟 */
  now: () => string
  appVersion: string
}

/** `2026-10-15T10:30:00.000Z` → `20261015-1030`，用作文件夹名。 */
export function backupStamp(iso: string): string {
  const day = iso.slice(0, 10).replace(/-/g, '')
  const hhmm = iso.slice(11, 16).replace(':', '')
  return day.length === 8 && hhmm.length === 4 ? `${day}-${hhmm}` : 'backup'
}

/** 磁盘满、没权限这类错误要给用户一句人话，而不是甩 ERR_ 码。 */
function describeFsError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (code === 'ENOSPC') return '磁盘空间不够，备份没写完'
  if (code === 'EACCES' || code === 'EPERM') return '这个位置没有写入权限，换一个文件夹再试'
  if (code === 'EROFS') return '这个位置是只读的，换一个文件夹再试'
  return '备份没能写完，换一个位置再试一次'
}

async function measureDir(dir: string): Promise<{ files: number; bytes: number }> {
  const { readdir } = await import('node:fs/promises')
  let files = 0
  let bytes = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { files: 0, bytes: 0 }
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    try {
      const info = await stat(join(dir, name))
      if (info.isFile()) {
        files++
        bytes += info.size
      }
    } catch {
      // 读不到就跳过，不因为一个文件算不出大小就整次失败
    }
  }
  return { files, bytes }
}

/**
 * 备份到 `parentDir/InsPin备份-<时间戳>/`。
 *
 * 目标文件夹若已存在会先删掉重来（同一个分钟里连点两次的重复备份），
 * 但**只删我们自己命名的那个文件夹**，不会碰用户的其它东西。
 */
export async function exportBackup(deps: BackupDeps, parentDir: string): Promise<BackupResult> {
  const createdAt = deps.now()
  const targetDir = join(parentDir, `InsPin备份-${backupStamp(createdAt)}`)

  try {
    await rm(targetDir, { recursive: true, force: true })
    await mkdir(targetDir, { recursive: true })

    // 一致快照：VACUUM INTO 由 SQLite 产出，WAL 里的最新写入也已合并进去
    const dbFile = join(targetDir, BACKUP_DB_NAME)
    deps.db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`)

    await cp(deps.assetsDir, join(targetDir, BACKUP_ASSETS_DIR), {
      recursive: true,
      force: true,
      errorOnExist: false
    })

    const counted = await measureDir(join(targetDir, BACKUP_ASSETS_DIR))
    const meta: BackupMeta = {
      version: 1,
      createdAt,
      appVersion: deps.appVersion,
      assetFiles: counted.files,
      assetBytes: counted.bytes
    }
    await writeFile(join(targetDir, BACKUP_META_NAME), JSON.stringify(meta, null, 2), 'utf8')

    return { ok: true, dir: targetDir, assetFiles: counted.files, bytes: counted.bytes }
  } catch (error) {
    return { ok: false, message: describeFsError(error) }
  }
}
