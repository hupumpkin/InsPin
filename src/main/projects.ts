import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * 项目仓库（路线图 D1.2）。
 *
 * 关于"命令化"：撤销/重做按 §1.2 只作用于**画布编辑**（节点增删改），
 * 项目的新建/改名/删除属于资料管理，不进画布历史栈——否则用户在画布上按 ⌘Z
 * 会把整个项目撤没了，那是灾难而不是功能。所以这里是一组集中、可测的仓储函数，
 * 接 IPC 时直接暴露即可。
 */

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  viewportX: number
  viewportY: number
  viewportZoom: number
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** 单条插桩点：测试传入固定值，生产环境用默认值。 */
export interface Clock {
  id?: string
  now?: Date
}

export const PROJECT_NAME_MAX = 100
/** 新用户、以及删掉最后一个项目后立刻可用的空白画布。 */
export const DEFAULT_PROJECT_NAME = '画布1'

interface ProjectRow {
  id: string
  name: string
  created_at: string
  updated_at: string
  viewport_x: number
  viewport_y: number
  viewport_zoom: number
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    viewportX: row.viewport_x,
    viewportY: row.viewport_y,
    viewportZoom: row.viewport_zoom
  }
}

/** 名称清洗：去首尾空白；空名或过长的名字在这里就挡住，不写进库。 */
export function normalizeProjectName(raw: string): string {
  const name = raw.trim()
  if (name.length === 0) throw new Error('项目名不能为空')
  if (name.length > PROJECT_NAME_MAX) {
    throw new Error(`项目名不能超过 ${PROJECT_NAME_MAX} 个字符`)
  }
  return name
}

export function createProject(db: DatabaseSync, rawName: string, clock: Clock = {}): Project {
  const name = normalizeProjectName(rawName)
  const now = (clock.now ?? new Date()).toISOString()
  const id = clock.id ?? randomUUID()

  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, name, now, now)

  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    viewportX: 0,
    viewportY: 0,
    viewportZoom: 1
  }
}

/** 保证任意新安装都有一张可以直接接收图片的画布。 */
export function ensureDefaultProject(db: DatabaseSync, clock: Clock = {}): Project | null {
  if (listProjects(db).length > 0) return null
  return createProject(db, DEFAULT_PROJECT_NAME, clock)
}

/** 最近改动的排前面，方便做"最近项目"。 */
export function listProjects(db: DatabaseSync): Project[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC')
    .all() as unknown as ProjectRow[]
  return rows.map(toProject)
}

export function getProject(db: DatabaseSync, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined
  return row ? toProject(row) : null
}

export function renameProject(
  db: DatabaseSync,
  id: string,
  rawName: string,
  clock: Clock = {}
): Project {
  const name = normalizeProjectName(rawName)
  const now = (clock.now ?? new Date()).toISOString()

  const result = db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(
    name,
    now,
    id
  )
  if (result.changes === 0) throw new Error('项目不存在')

  const project = getProject(db, id)
  if (!project) throw new Error('项目不存在')
  return project
}

/** 删除项目；它下面的节点由外键 ON DELETE CASCADE 一并清掉。 */
export function deleteProject(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  return result.changes > 0
}

/** 记录画布视图位置（D2.12 恢复视图时读它）。改动视图也算改动项目，会刷新 updated_at。 */
export function updateViewport(
  db: DatabaseSync,
  id: string,
  viewport: Viewport,
  clock: Clock = {}
): void {
  const now = (clock.now ?? new Date()).toISOString()
  const result = db
    .prepare(
      `UPDATE projects
       SET viewport_x = ?, viewport_y = ?, viewport_zoom = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(viewport.x, viewport.y, viewport.zoom, now, id)
  if (result.changes === 0) throw new Error('项目不存在')
}
