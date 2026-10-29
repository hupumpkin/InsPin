import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { Node, NodeMap, NodeType, ProjectGraph } from '../shared/node'

/**
 * 画布对象的读写（路线图 D1.9 的持久化部分）。
 *
 * 内存模型 ↔ 数据库的映射（对应 `schema.ts` 里的设计说明）：
 *   - 内存里靠 `childIds[]` 表达顺序，库里靠 `ordinal`；两者在这里互相还原
 *   - `props` 整体存成 JSON，加字段不用改表
 *
 * 这里只做"存得下、读得回"。真正的编辑要走命令（D2 / D4a），
 * 自动保存的时机与去抖在接上画布时再定。
 */

interface NodeRow {
  id: string
  project_id: string
  parent_id: string | null
  ordinal: number
  type: string
  name: string
  visible: number
  locked: number
  x: number
  y: number
  w: number
  h: number
  rotation: number
  props: string
}

function toNode(row: NodeRow): Node {
  const base = {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    childIds: [] as string[],
    name: row.name,
    visible: row.visible === 1,
    locked: row.locked === 1,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    rotation: row.rotation
  }
  // props 是历史数据，坏掉时退回空对象，不让整个项目打不开
  let props: Record<string, unknown> = {}
  try {
    props = JSON.parse(row.props) as Record<string, unknown>
  } catch {
    props = {}
  }
  // props 从 JSON 读回来，类型上无法静态保证；缺字段时由各处的默认值兜底
  return { ...base, type: row.type as NodeType, props } as unknown as Node
}

function selectRows(db: DatabaseSync, projectId: string): NodeRow[] {
  return db
    .prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY parent_id, ordinal')
    .all(projectId) as unknown as NodeRow[]
}

/** 读出整个项目的画布。节点不存在就是一张空画布。 */
export function loadGraph(db: DatabaseSync, projectId: string): ProjectGraph {
  const rows = selectRows(db, projectId)
  const nodes: NodeMap = {}
  const childrenOf = new Map<string | null, NodeRow[]>()

  for (const row of rows) {
    nodes[row.id] = toNode(row)
    const bucket = childrenOf.get(row.parent_id) ?? []
    bucket.push(row)
    childrenOf.set(row.parent_id, bucket)
  }

  // 按 ordinal 还原顺序，写回各节点的 childIds
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.ordinal - b.ordinal)
  }
  for (const [parentId, bucket] of childrenOf) {
    if (parentId === null) continue
    const parent = nodes[parentId]
    if (parent) parent.childIds = bucket.map((row) => row.id)
  }

  const rootIds = (childrenOf.get(null) ?? []).map((row) => row.id)
  return { projectId, rootIds, nodes }
}

const NODE_UPSERT_SQL = `
INSERT INTO nodes
  (id, project_id, parent_id, ordinal, type, name, visible, locked, x, y, w, h, rotation, props)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  parent_id = excluded.parent_id,
  ordinal   = excluded.ordinal,
  type      = excluded.type,
  name      = excluded.name,
  visible   = excluded.visible,
  locked    = excluded.locked,
  x         = excluded.x,
  y         = excluded.y,
  w         = excluded.w,
  h         = excluded.h,
  rotation  = excluded.rotation,
  props     = excluded.props
`

function bindNode(statement: StatementSync, node: Node, ordinal: number): void {
  statement.run(
    node.id,
    node.projectId,
    node.parentId,
    ordinal,
    node.type,
    node.name,
    node.visible ? 1 : 0,
    node.locked ? 1 : 0,
    node.x,
    node.y,
    node.w,
    node.h,
    node.rotation,
    JSON.stringify(node.props)
  )
}

/** 新节点排在同层末尾；已有的保持原位置。 */
function ordinalFor(db: DatabaseSync, node: Node): number {
  const existing = db.prepare('SELECT ordinal FROM nodes WHERE id = ?').get(node.id) as
    | { ordinal: number }
    | undefined
  if (existing) return existing.ordinal

  const next = db
    .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM nodes WHERE parent_id IS ?')
    .get(node.parentId) as { next: number }
  return next.next
}

/**
 * 全量写入一个项目的画布（先清空再写），中途失败整条回滚。
 * 顺序由 `rootIds` 与各节点的 `childIds` 决定，只在这一处转成 ordinal。
 */
export function saveGraph(db: DatabaseSync, graph: ProjectGraph): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM nodes WHERE project_id = ?').run(graph.projectId)
    const upsert = db.prepare(NODE_UPSERT_SQL)

    const write = (id: string, parentId: string | null, ordinal: number): void => {
      const node = graph.nodes[id]
      if (!node) return
      bindNode(upsert, { ...node, projectId: graph.projectId, parentId }, ordinal)
      node.childIds.forEach((childId, index) => write(childId, id, index))
    }

    graph.rootIds.forEach((id, index) => write(id, null, index))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 单条写入或更新（已经有就不新增）。新节点排在同层末尾。 */
export function upsertNode(db: DatabaseSync, node: Node): void {
  bindNode(db.prepare(NODE_UPSERT_SQL), node, ordinalFor(db, node))
}

/** 删掉一个节点；它的子孙由外键 ON DELETE CASCADE 一并清掉。 */
export function deleteNode(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM nodes WHERE id = ?').run(id).changes > 0
}
