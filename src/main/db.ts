import { DatabaseSync } from 'node:sqlite'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

/**
 * SQLite 接入（路线图 D1.1）。
 *
 * 用 Node 24+ 内置的 `node:sqlite`，**不需要 better-sqlite3**：
 * 没有原生模块，也就不需要编译、不需要签名时额外操心。
 */

export type Database = DatabaseSync

/** 读当前结构版本（`PRAGMA user_version`）。 */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

/**
 * 依次应用未执行过的迁移。每条迁移各自一个事务：中途失败会整条回滚，
 * 版本号不会停在"改了一半"的中间态。
 */
export function migrate(db: DatabaseSync): number {
  let current = schemaVersion(db)

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue

    db.exec('BEGIN')
    try {
      migration.up(db)
      // PRAGMA 不支持占位符；version 是代码里的常量整数，不来自外部输入
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
      current = migration.version
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return current
}

/** 打开数据库并保证结构是最新的。文件不存在会自动创建。 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)

  // WAL：读写不互相阻塞，异常退出也不容易损坏数据
  db.exec('PRAGMA journal_mode = WAL')
  // 外键约束默认是关的，必须显式打开，否则 ON DELETE CASCADE 不生效
  db.exec('PRAGMA foreign_keys = ON')
  // 被别的连接占用时等一会儿再报错，而不是立刻失败
  db.exec('PRAGMA busy_timeout = 5000')

  migrate(db)
  return db
}

export { LATEST_SCHEMA_VERSION }
