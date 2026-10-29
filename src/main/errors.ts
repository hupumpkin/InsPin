import { app, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import { describeReason, describeRendererPayload } from './error-format'
import { Logger, LogEvent } from './logger'

/**
 * 全局异常捕获：任何一处崩溃都要在日志里留下证据，而不是窗口默默消失。
 * 注册后主进程不会因未捕获异常直接退出——先记日志，保持可诊断。
 */
export function installErrorHandlers(logger: Logger): void {
  process.on('uncaughtException', (error) => {
    logger.error(LogEvent.mainUncaught, {
      name: error.name,
      message: error.message,
      stack: error.stack
    })
  })

  process.on('unhandledRejection', (reason) => {
    logger.error(LogEvent.mainRejection, describeReason(reason))
  })

  app.on('render-process-gone', (_event, _webContents, details) => {
    logger.error(LogEvent.rendererGone, {
      reason: details.reason,
      exitCode: details.exitCode
    })
  })

  app.on('child-process-gone', (_event, details) => {
    logger.error(LogEvent.processGone, {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName
    })
  })

  ipcMain.on(IpcChannel.rendererError, (_event, payload: unknown) => {
    logger.error(LogEvent.rendererUncaught, describeRendererPayload(payload))
  })
}
