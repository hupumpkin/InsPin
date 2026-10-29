import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

/** 事件类型表：新增事件只往这里加一条，日志里出现的事件名必须来自本表。 */
export const LogEvent = {
  /** 应用启动，记录版本与运行环境 */
  appStart: 'app.start',
  /** 主窗口创建完成 */
  windowCreated: 'window.created',
  /** 应用退出 */
  appQuit: 'app.quit',
  /** 主进程未捕获异常 */
  mainUncaught: 'error.main.uncaught',
  /** 主进程未处理的 Promise 拒绝 */
  mainRejection: 'error.main.rejection',
  /** 渲染进程（界面）未捕获异常 */
  rendererUncaught: 'error.renderer.uncaught',
  /** 界面进程崩溃/被杀 */
  rendererGone: 'error.renderer.gone',
  /** 子进程退出，含 GPU 进程退出 */
  processGone: 'error.process.gone',
  /** 诊断包导出成功 */
  diagnosticsExported: 'diagnostics.exported',
  /** 诊断包导出失败 */
  diagnosticsExportFailed: 'diagnostics.export.failed',
  /** 本地起始页服务就绪 */
  startPageReady: 'start-page.ready',
  /** 浏览器区域完成一次导航（**记完整 URL**） */
  browserNavigate: 'browser.navigate',
  /** 浏览器区域加载失败 */
  browserLoadFailed: 'browser.load.failed',
  /** 网页试图打开不支持的地址，已拦下 */
  browserWindowOpenBlocked: 'browser.window-open.blocked',
  /** 登录/授权弹窗：开成真实子窗口，保留 opener 回调 */
  browserWindowOpenPopup: 'browser.window-open.popup',
  /** 普通新窗口链接：开成应用内新标签 */
  browserWindowOpenTab: 'browser.window-open.tab',
  /** 自动自检结果 */
  smokeResult: 'smoke.result',
  /** 数据库已打开（记录文件位置与结构版本） */
  dbOpened: 'db.opened',
  /** 新建项目 */
  projectCreated: 'project.created',
  /** 新建项目失败（名字不合法或写库出错） */
  projectCreateFailed: 'project.create.failed',
  /** 界面切换到另一个项目 */
  projectSwitched: 'project.switched',
  /** 导入一份素材成功（本地文件） */
  assetImported: 'asset.imported',
  /** 导入某个文件失败（不是图片 / 损坏 / 读取失败） */
  assetImportFailed: 'asset.import.failed',
  /** 从网页拖来的图：某个候选地址取不回来（**记完整 URL**，排查站点问题全靠它） */
  webFetchFailed: 'asset.web.fetch.failed',
  /** 从网页拖来的图：定下用哪个地址、实际拿到多大（D3.11"明显大于 480px"的证据） */
  webImportResolved: 'asset.web.resolved',
  /** 以图搜图：收下当前可见结果的分段耗时（扫描 / 下载 / 入库） */
  imageSearchCollected: 'image.search.collected',
  /** 区域截图：开始框选（抓到了多大一张） */
  captureStarted: 'browser.capture.started',
  /** 区域截图：用户放弃了这一次 */
  captureCancelled: 'browser.capture.cancelled',
  /** 区域截图：框太小 / 没有可裁的图，这一次作废 */
  captureDiscarded: 'browser.capture.discarded',
  /** 参考快照：创建了一个浮窗（D5.5） */
  snapshotCreated: 'snapshot.created',
  /** 参考快照：没能创建（没选对象 / 项目不在了） */
  snapshotCreateFailed: 'snapshot.create.failed',
  /** 参考快照：关掉了一个浮窗 */
  snapshotClosed: 'snapshot.closed',
  /** 参考快照：手动刷新，源内容重新取了（D5.7） */
  snapshotRefreshed: 'snapshot.refreshed',
  /** 参考快照：重启后把上次的快照摆了回来（D5.6） */
  snapshotRestored: 'snapshot.restored',
  /** 备份完成 */
  dataBackupDone: 'data.backup.done',
  /** 备份失败（磁盘满 / 没权限 / 位置不可写） */
  dataBackupFailed: 'data.backup.failed',
  /** 项目导出成功 */
  dataProjectExported: 'data.project.exported',
  /** 项目导入成功 */
  dataProjectImported: 'data.project.imported',
  /** 素材体检跑了一次 */
  dataHealthChecked: 'data.health.checked',
  /** 清除浏览数据 */
  dataBrowsingCleared: 'data.browsing.cleared',
  /** 按清理策略整理了一次素材 */
  dataLibraryCleaned: 'data.library.cleaned'
} as const

export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent]

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogRecord {
  /** ISO 8601 时间戳 */
  ts: string
  level: LogLevel
  event: string
  [field: string]: unknown
}

/**
 * 删除超过保留期的日志文件。内置浏览器会记录每次导航的完整 URL，长期不清理
 * 会让日志目录无限增长；默认只留 14 天。
 */
export function pruneOldLogs(logDir: string, maxAgeDays = 14, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return 0
  }
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      if (statSync(join(logDir, name)).mtimeMs < cutoff) {
        unlinkSync(join(logDir, name))
        removed += 1
      }
    } catch {
      // 单个文件删不掉不影响启动
    }
  }
  return removed
}

/** 当天日志文件名，如 `ins-pin-2026-10-14.jsonl`。 */
export function logFileName(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `ins-pin-${y}-${m}-${d}.jsonl`
}

/**
 * 结构化日志（JSON Lines，一行一条）。默认只写本机、不上传。
 * 排查站点问题依赖完整 URL，所以这里**原样记录 URL**；脱敏只发生在导出诊断包时。
 */
export class Logger {
  private readonly stream: WriteStream

  constructor(logDir: string, fileName: string) {
    mkdirSync(logDir, { recursive: true })
    this.stream = createWriteStream(join(logDir, fileName), { flags: 'a' })
    // 日志写不进去（如磁盘满）不能反过来拖垮应用
    this.stream.on('error', () => {})
  }

  info(event: LogEventName, fields?: Record<string, unknown>): void {
    this.write('info', event, fields)
  }

  warn(event: LogEventName, fields?: Record<string, unknown>): void {
    this.write('warn', event, fields)
  }

  error(event: LogEventName, fields?: Record<string, unknown>): void {
    this.write('error', event, fields)
  }

  /**
   * 冲刷并关闭。退出前调用，避免丢最后几条。
   * 写盘出错或卡住时必须照常返回，否则会把应用退出一起卡住。
   */
  close(timeoutMs = 500): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      this.stream.once('finish', settle)
      this.stream.once('error', settle)
      setTimeout(settle, timeoutMs).unref()
      this.stream.end()
    })
  }

  private write(level: LogLevel, event: LogEventName, fields?: Record<string, unknown>): void {
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields
    }
    this.stream.write(`${JSON.stringify(record)}\n`)
  }
}
