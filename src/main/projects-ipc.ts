import type { DatabaseSync } from 'node:sqlite'
import {
  IpcChannel,
  type CreateProjectResult,
  type DeleteProjectResult,
  type ProjectSummary,
  type RenameProjectResult
} from '../shared/ipc'
import type { LogEventName } from './logger'
import { LogEvent } from './logger'
import { updateAssetReferenceClocks } from './asset-retention'
import {
  createProject,
  deleteProject,
  ensureDefaultProject,
  listProjects,
  renameProject,
  type Project
} from './projects'

/**
 * 项目相关的 IPC 通路（路线图 D1.3）。
 *
 * 主进程能力在 `projects.ts` 里早就齐了，这里只做两件事：把仓库函数包成
 * 界面能调用的通道、把失败变成一句给用户看的话。**不在这里做任何项目业务逻辑。**
 */

/** 只取界面需要的字段，主进程内部状态（视图位置等）不往渲染进程送。 */
function toSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }
}

/** 日志出口。用最小接口而不是 `Logger` 类，测试里可以塞一个假的。 */
export interface ProjectLogSink {
  info(event: LogEventName, fields?: Record<string, unknown>): void
  error(event: LogEventName, fields?: Record<string, unknown>): void
}

/**
 * 只用到 Electron `ipcMain` 的两个方法，抽成接口后测试不需要真的起 Electron。
 * 用方法语法声明（而非函数属性），这样真实 `ipcMain` 能靠参数双变直接传入。
 */
export interface IpcHandlerRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

export interface ProjectIpcDeps {
  ipc: IpcHandlerRegistrar
  db: DatabaseSync
  logger: ProjectLogSink
}

/** 项目列表，最近改动的在前。 */
export function listProjectsForRenderer(db: DatabaseSync): ProjectSummary[] {
  return listProjects(db).map(toSummary)
}

/**
 * 新建项目。名字不合法（空、过长）时 `createProject` 会抛出已经写好的中文提示，
 * 这里原样透出去；其它异常只记日志、给一句通用提示，不把底层报错甩给用户。
 */
export function createProjectForRenderer(
  db: DatabaseSync,
  rawName: unknown,
  logger: ProjectLogSink
): CreateProjectResult {
  const name = typeof rawName === 'string' ? rawName : ''
  try {
    const project = createProject(db, name)
    logger.info(LogEvent.projectCreated, { projectId: project.id, name: project.name })
    return { ok: true, project: toSummary(project) }
  } catch (error) {
    const message = error instanceof Error ? error.message : '新建项目失败'
    logger.error(LogEvent.projectCreateFailed, { message, name })
    return { ok: false, message }
  }
}

export function renameProjectForRenderer(
  db: DatabaseSync,
  rawId: unknown,
  rawName: unknown,
  logger: ProjectLogSink
): RenameProjectResult {
  const id = typeof rawId === 'string' ? rawId : ''
  const name = typeof rawName === 'string' ? rawName : ''
  try {
    const project = renameProject(db, id, name)
    return { ok: true, project: toSummary(project) }
  } catch (error) {
    const message = error instanceof Error ? error.message : '重命名失败'
    logger.error(LogEvent.projectCreateFailed, { message, id, name })
    return { ok: false, message }
  }
}

export function deleteProjectForRenderer(
  db: DatabaseSync,
  rawId: unknown,
  logger: ProjectLogSink
): DeleteProjectResult {
  const id = typeof rawId === 'string' ? rawId : ''
  if (!id || !deleteProject(db, id)) {
    return { ok: false, message: '项目不存在' }
  }
  updateAssetReferenceClocks(db)
  // 删除最后一项后即时补回默认项目：不让当前会话落到“无法拖图”的死状态。
  const replacement = ensureDefaultProject(db)
  if (replacement) {
    logger.info(LogEvent.projectCreated, { projectId: replacement.id, name: replacement.name, default: true })
  }
  return { ok: true, replacement: replacement ? toSummary(replacement) : null }
}

/** 记录"当前在用的项目"，纯诊断用，失败也不影响界面。 */
export function logProjectSwitched(logger: ProjectLogSink, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return
  const { id, name } = payload as { id?: unknown; name?: unknown }
  if (typeof id !== 'string') return
  logger.info(LogEvent.projectSwitched, { projectId: id, name: typeof name === 'string' ? name : '' })
}

export function registerProjectIpc({ ipc, db, logger }: ProjectIpcDeps): void {
  ipc.handle(IpcChannel.projectsList, () => listProjectsForRenderer(db))
  ipc.handle(IpcChannel.projectsCreate, (_event, rawName) =>
    createProjectForRenderer(db, rawName, logger)
  )
  ipc.handle(IpcChannel.projectsRename, (_event, id, rawName) =>
    renameProjectForRenderer(db, id, rawName, logger)
  )
  ipc.handle(IpcChannel.projectsDelete, (_event, id) => deleteProjectForRenderer(db, id, logger))
  ipc.on(IpcChannel.projectsSwitched, (_event, payload) => logProjectSwitched(logger, payload))
}
