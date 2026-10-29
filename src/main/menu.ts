import { app, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SettingsTab } from '../shared/ipc'
import type { MaintenanceResult } from '../shared/maintenance'
import {
  buildDiagnosticBundle,
  collectLogFiles,
  stampForFileName,
  type DiagnosticAppInfo
} from './diagnostics'
import { Logger, LogEvent } from './logger'

export interface MenuDeps {
  logger: Logger
  logDir: string
  dataRoot: string
  /** 打开设置（哪一页由调用方决定）；界面还没就绪时应当是安全的空操作 */
  openSettings?: (tab: SettingsTab) => void
}

export type { SettingsTab }

/** 有参考快照浮窗时才出现的兜底项。 */
export interface DockSnapshotActions {
  /** 当前有几条快照（0 就不放这一项） */
  count: number
  /** 所有浮窗解锁（锁定 = 钉住 + 鼠标穿透，解锁把鼠标还回来） */
  unlockAll: () => void
}

export interface DockMenuOptions {
  /** 打开设置（产品介绍 / 快捷键设置） */
  open: (tab: SettingsTab) => void
  snapshots?: DockSnapshotActions
}

/**
 * 程序坞右键菜单。
 *
 * 除了设置入口，还挂着**参考快照的逃生口**（D5.3）：鼠标穿透开着的浮窗点不到自己，
 * 所以关掉穿透必须有一条浮窗以外的路；锁定位置同理。只有真的有快照时才显示。
 */
export function buildDockMenu(options: DockMenuOptions): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: '通用', click: () => options.open('general') },
    { label: '产品介绍', click: () => options.open('about') },
    { label: '快捷键设置', click: () => options.open('shortcuts') },
    { label: '数据与备份', click: () => options.open('data') }
  ]

  const snapshots = options.snapshots
  if (snapshots && snapshots.count > 0) {
    template.push(
      { type: 'separator' },
      { label: '参考快照：全部解锁', click: () => snapshots.unlockAll() }
    )
  }

  return Menu.buildFromTemplate(template)
}

function currentAppInfo(): DiagnosticAppInfo {
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }
}

/** 生成诊断包并写入指定路径（不含任何弹窗，便于单独验证）。 */
export async function writeDiagnosticsTo(
  { logger, logDir, dataRoot }: MenuDeps,
  filePath: string
): Promise<void> {
  const logFiles = await collectLogFiles(logDir)
  const bundle = buildDiagnosticBundle({
    generatedAt: new Date().toISOString(),
    app: currentAppInfo(),
    dataRoot,
    logFiles
  })

  await writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf8')
  logger.info(LogEvent.diagnosticsExported, {
    filePath,
    logFiles: bundle.summary.logFiles,
    logLines: bundle.summary.logLines
  })
}

/**
 * 弹保存框 + 写诊断包，返回一句给用户看的话。
 *
 * 设置页的「导出诊断包」和「帮助」菜单里那一项都走这里，只是菜单那条
 * 再把结果弹个提示框（见下）。
 */
export async function runDiagnosticsExport(deps: MenuDeps): Promise<MaintenanceResult> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出诊断包',
    defaultPath: join(
      app.getPath('downloads'),
      `InsPin-诊断包-${stampForFileName(new Date())}.json`
    ),
    filters: [{ name: '诊断包', extensions: ['json'] }]
  })
  if (canceled || !filePath) return { ok: false, message: '没有选位置，这次没导出' }

  try {
    await writeDiagnosticsTo(deps, filePath)
  } catch (error) {
    deps.logger.error(LogEvent.diagnosticsExportFailed, {
      message: error instanceof Error ? error.message : String(error)
    })
    return { ok: false, message: '诊断包没能导出，稍后可以再试一次' }
  }

  return {
    ok: true,
    message: '诊断包已导出',
    detail: `${filePath}\n\n里面只有脱敏后的运行记录，不含图片和登录信息，可以放心发给开发者。`
  }
}

async function exportDiagnostics(deps: MenuDeps): Promise<void> {
  const result = await runDiagnosticsExport(deps)
  await dialog.showMessageBox({
    type: result.ok ? 'info' : 'error',
    message: result.message,
    ...(result.ok && result.detail ? { detail: result.detail } : {}),
    buttons: ['好']
  })
}

export function installAppMenu(deps: MenuDeps): void {
  const openSettings = deps.openSettings
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: '设置',
      submenu: [
        {
          label: '通用…',
          accelerator: 'CommandOrControl+,',
          click: () => openSettings?.('general')
        },
        {
          label: '产品介绍',
          click: () => openSettings?.('about')
        },
        {
          label: '快捷键设置…',
          accelerator: 'CommandOrControl+Shift+,',
          click: () => openSettings?.('shortcuts')
        },
        {
          label: '数据与备份…',
          click: () => openSettings?.('data')
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '导出诊断包…',
          click: () => {
            void exportDiagnostics(deps).catch((error: unknown) => {
              deps.logger.error(LogEvent.diagnosticsExportFailed, {
                message: error instanceof Error ? error.message : String(error)
              })
              void dialog.showMessageBox({
                type: 'error',
                message: '导出失败',
                detail: '诊断包没能导出，稍后可以再试一次。',
                buttons: ['好']
              })
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
