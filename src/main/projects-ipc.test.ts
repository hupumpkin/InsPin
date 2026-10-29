import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  IpcChannel,
  type CreateProjectResult,
  type DeleteProjectResult,
  type ProjectSummary,
  type RenameProjectResult
} from '../shared/ipc'
import { migrate } from './db'
import {
  createProjectForRenderer,
  deleteProjectForRenderer,
  listProjectsForRenderer,
  logProjectSwitched,
  renameProjectForRenderer,
  registerProjectIpc,
  type IpcHandlerRegistrar,
  type ProjectLogSink
} from './projects-ipc'

interface LogCall {
  level: 'info' | 'error'
  event: string
  fields?: Record<string, unknown>
}

function fakeLogger(): { sink: ProjectLogSink; calls: LogCall[] } {
  const calls: LogCall[] = []
  const sink: ProjectLogSink = {
    info: (event, fields) => calls.push({ level: 'info', event, fields }),
    error: (event, fields) => calls.push({ level: 'error', event, fields })
  }
  return { sink, calls }
}

type Listener = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc(): {
  ipc: IpcHandlerRegistrar
  handlers: Map<string, Listener>
  listeners: Map<string, Listener>
} {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()
  const ipc: IpcHandlerRegistrar = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    on(channel, listener) {
      listeners.set(channel, listener)
    }
  }
  return { ipc, handlers, listeners }
}

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
})

describe('listProjectsForRenderer', () => {
  it('空库返回空数组', () => {
    expect(listProjectsForRenderer(db)).toEqual([])
  })

  it('只把界面需要的字段送出去，不带视图位置等内部状态', () => {
    createProjectForRenderer(db, '灵感收集', fakeLogger().sink)

    const [project] = listProjectsForRenderer(db)
    expect(project).toBeDefined()
    expect(Object.keys(project ?? {}).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt'])
  })
})

describe('createProjectForRenderer', () => {
  it('成功时返回项目并记一条日志', () => {
    const { sink, calls } = fakeLogger()
    const result = createProjectForRenderer(db, '  项目一 ', sink)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.project.name).toBe('项目一')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ level: 'info', event: 'project.created' })
    expect(calls[0]?.fields).toMatchObject({ name: '项目一' })
  })

  it('空名字返回可读提示，且不落库', () => {
    const { sink, calls } = fakeLogger()
    const result = createProjectForRenderer(db, '   ', sink)

    expect(result).toEqual({ ok: false, message: '项目名不能为空' })
    expect(listProjectsForRenderer(db)).toEqual([])
    expect(calls[0]).toMatchObject({ level: 'error', event: 'project.create.failed' })
  })

  it('超长名字同样被挡下', () => {
    const { sink } = fakeLogger()
    const result = createProjectForRenderer(db, 'x'.repeat(101), sink)
    expect(result.ok).toBe(false)
  })

  it('非字符串输入按空名处理，而不是抛异常穿过 IPC', () => {
    const { sink } = fakeLogger()
    expect(createProjectForRenderer(db, 42, sink)).toEqual({
      ok: false,
      message: '项目名不能为空'
    })
  })
})

describe('renameProjectForRenderer', () => {
  it('更新名称并把更新后的项目回给界面', () => {
    const { sink } = fakeLogger()
    const created = createProjectForRenderer(db, '旧名', sink)
    if (!created.ok) throw new Error('fixture failed')

    const result = renameProjectForRenderer(db, created.project.id, '新名', sink)
    expect(result).toMatchObject({ ok: true, project: { id: created.project.id, name: '新名' } })
  })
})

describe('deleteProjectForRenderer', () => {
  it('删除最后一个项目后立即补回默认项目', () => {
    const { sink } = fakeLogger()
    const created = createProjectForRenderer(db, '唯一项目', sink)
    if (!created.ok) throw new Error('fixture failed')

    const result = deleteProjectForRenderer(db, created.project.id, sink)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.replacement?.name).toBe('画布1')
    expect(listProjectsForRenderer(db)).toHaveLength(1)
  })

  it('删除非最后一个项目时不额外生成默认项目', () => {
    const { sink } = fakeLogger()
    const a = createProjectForRenderer(db, 'A', sink)
    const b = createProjectForRenderer(db, 'B', sink)
    if (!a.ok || !b.ok) throw new Error('fixture failed')

    const result = deleteProjectForRenderer(db, a.project.id, sink)
    expect(result).toEqual({ ok: true, replacement: null })
    expect(listProjectsForRenderer(db).map((project) => project.name)).toEqual(['B'])
  })
})

describe('logProjectSwitched', () => {
  it('记录项目 id 与名字', () => {
    const { sink, calls } = fakeLogger()
    logProjectSwitched(sink, { id: 'p1', name: '项目一' })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      event: 'project.switched',
      fields: { projectId: 'p1', name: '项目一' }
    })
  })

  it('负载不合法时静默忽略', () => {
    const { sink, calls } = fakeLogger()
    logProjectSwitched(sink, null)
    logProjectSwitched(sink, 'p1')
    logProjectSwitched(sink, { name: '没有 id' })
    expect(calls).toEqual([])
  })
})

describe('registerProjectIpc', () => {
  it('注册列表、新建、改名、删除与切换通道', () => {
    const { ipc, handlers, listeners } = fakeIpc()
    registerProjectIpc({ ipc, db, logger: fakeLogger().sink })

    expect([...handlers.keys()].sort()).toEqual(
      [
        IpcChannel.projectsList,
        IpcChannel.projectsCreate,
        IpcChannel.projectsRename,
        IpcChannel.projectsDelete
      ].sort()
    )
    expect([...listeners.keys()]).toEqual([IpcChannel.projectsSwitched])
  })

  it('通过注册的通道能改名与删除项目', async () => {
    const { ipc, handlers } = fakeIpc()
    registerProjectIpc({ ipc, db, logger: fakeLogger().sink })
    const created = (await handlers.get(IpcChannel.projectsCreate)?.(null, '初始名')) as CreateProjectResult
    if (!created.ok) throw new Error('fixture failed')

    const renamed = (await handlers.get(IpcChannel.projectsRename)?.(null, created.project.id, '改后名')) as RenameProjectResult
    expect(renamed).toMatchObject({ ok: true, project: { name: '改后名' } })

    const deleted = (await handlers.get(IpcChannel.projectsDelete)?.(null, created.project.id)) as DeleteProjectResult
    expect(deleted).toMatchObject({ ok: true, replacement: { name: '画布1' } })
  })

  it('通过注册的通道能真的建出项目并读到', async () => {
    const { ipc, handlers } = fakeIpc()
    registerProjectIpc({ ipc, db, logger: fakeLogger().sink })

    const created = (await handlers.get(IpcChannel.projectsCreate)?.(null, '通过 IPC 建的项目')) as
      | CreateProjectResult
      | undefined
    expect(created?.ok).toBe(true)

    const listed = (await handlers.get(IpcChannel.projectsList)?.(null)) as
      | ProjectSummary[]
      | undefined
    expect(listed).toHaveLength(1)
    expect(listed?.[0]).toMatchObject({ name: '通过 IPC 建的项目' })
  })
})
