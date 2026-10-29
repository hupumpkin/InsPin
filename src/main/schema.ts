import type { DatabaseSync } from 'node:sqlite'

/**
 * 数据库结构（路线图 §1.2：schema v1 一次性容纳图层 / 编组 / 自动布局字段，
 * 后续不触发破坏性迁移）。
 *
 * 迁移是**只增不改**的：已经发布的版本永不改动，只能在后面追加新的 version。
 */

export interface Migration {
  version: number
  description: string
  up: (db: DatabaseSync) => void
}

/**
 * v1 结构。
 *
 * 与内存对象模型（`src/shared/node.ts`）的对应关系：
 *   - 内存里的 `childIds[]` 顺序 = 绘制顺序 = 图层顺序
 *   - 落库时不用数组，而是每个节点带 `parent_id` + `ordinal`：
 *     `ORDER BY ordinal` 还原顺序，`WHERE parent_id IS NULL` 就是顶层节点
 *     （这样层级、顺序都只有一份事实来源，避免数组与字段不同步）
 *   - 类型特有字段一律进 `props`（JSON），加字段不改表
 *   - 视图位置（画布平移缩放）也放在项目上，D2.12 直接用
 */
const V1 = `
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  viewport_x    REAL NOT NULL DEFAULT 0,
  viewport_y    REAL NOT NULL DEFAULT 0,
  viewport_zoom REAL NOT NULL DEFAULT 1
);

CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  visible    INTEGER NOT NULL DEFAULT 1,
  locked     INTEGER NOT NULL DEFAULT 0,
  x          REAL NOT NULL DEFAULT 0,
  y          REAL NOT NULL DEFAULT 0,
  w          REAL NOT NULL DEFAULT 0,
  h          REAL NOT NULL DEFAULT 0,
  rotation   REAL NOT NULL DEFAULT 0,
  props      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_nodes_project ON nodes(project_id);
CREATE INDEX idx_nodes_parent ON nodes(parent_id, ordinal);

CREATE TABLE assets (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  file_name     TEXT NOT NULL,
  import_method TEXT NOT NULL,
  source_url    TEXT,
  resource_url  TEXT,
  page_url      TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_assets_created ON assets(created_at);
`

const V2 = `
ALTER TABLE assets ADD COLUMN original_name TEXT;
ALTER TABLE assets ADD COLUMN retention_policy TEXT NOT NULL DEFAULT 'permanent';
ALTER TABLE assets ADD COLUMN unreferenced_since TEXT;
ALTER TABLE assets ADD COLUMN trashed_at TEXT;

CREATE INDEX idx_assets_trash ON assets(trashed_at);
CREATE INDEX idx_assets_cleanup ON assets(retention_policy, unreferenced_since);

CREATE TABLE linked_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: '初始结构：项目 / 节点 / 素材',
    up: (db) => db.exec(V1)
  },
  {
    version: 2,
    description: '本地素材库：文件夹链接、引用宽限期与回收站',
    up: (db) => db.exec(V2)
  }
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0
)
