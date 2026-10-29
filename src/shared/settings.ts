import {
  DEFAULT_SHORTCUTS,
  normalizeShortcutBindings,
  type ShortcutBindings
} from './shortcuts'

/**
 * 一份设置，存在数据目录的 `settings.json`。
 *
 * 为什么放在主进程而不是浏览器 localStorage：快捷键要主进程/浮窗也能读到，
 * 素材清理策略要在主进程执行；如果再分散在几处，加一项设置就得记两套存储。
 * 渲染层只拿这份数据做界面，改完通过 IPC 写回。
 */

export type LibraryView = 'grid' | 'list'

export interface AssetCleanupSettings {
  /** 关掉后只记录"多久没引用"，不自动移入回收站、也不删除。 */
  enabled: boolean
  /** 临时素材失去全部引用后，多少天进回收站 */
  graceDays: number
  /** 回收站里的素材再保留多少天 */
  trashDays: number
}

export interface AppSettings {
  /** 复制到其他软件时，把 webp / avif / gif 转成 PNG */
  copyConvertToPng: boolean
  canvasColor: string
  libraryView: LibraryView
  /** 每次进入 InsPin 都展开左侧浏览器（不沿用上次关掉的状态） */
  openBrowserOnLaunch: boolean
  /** 智能采集时把网页替换为静态截图（默认，稳定）；关闭后才是实验性的滚动采集。 */
  freezeSmartCollection: boolean
  /** 用户是否已确认「以图搜图会把图片上传到第三方站点」 */
  imageSearchConsent: boolean
  /** 一次最多收下多少张结果图（1–50） */
  imageSearchCollectLimit: number
  assetCleanup: AssetCleanupSettings
  shortcuts: ShortcutBindings
}

export const DEFAULT_ASSET_CLEANUP: AssetCleanupSettings = {
  enabled: true,
  graceDays: 3,
  trashDays: 30
}

export const DEFAULT_SETTINGS: AppSettings = {
  copyConvertToPng: true,
  canvasColor: '#f5f4f7',
  libraryView: 'grid',
  openBrowserOnLaunch: true,
  freezeSmartCollection: true,
  imageSearchConsent: false,
  imageSearchCollectLimit: 12,
  assetCleanup: { ...DEFAULT_ASSET_CLEANUP },
  shortcuts: { ...DEFAULT_SHORTCUTS }
}

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const MIN_GRACE_DAYS = 1
const MAX_GRACE_DAYS = 90
const MIN_TRASH_DAYS = 2
const MAX_TRASH_DAYS = 365

function clampDays(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 把磁盘上的内容收成一份可信设置。
 * 坏数据逐项回到默认，不因为某个字段坏了就让应用起不来。
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const data = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const cleanupRaw =
    typeof data.assetCleanup === 'object' && data.assetCleanup !== null
      ? (data.assetCleanup as Record<string, unknown>)
      : {}
  return {
    copyConvertToPng:
      typeof data.copyConvertToPng === 'boolean' ? data.copyConvertToPng : DEFAULT_SETTINGS.copyConvertToPng,
    canvasColor:
      typeof data.canvasColor === 'string' && COLOR_PATTERN.test(data.canvasColor)
        ? data.canvasColor.toLowerCase()
        : DEFAULT_SETTINGS.canvasColor,
    libraryView: data.libraryView === 'list' ? 'list' : 'grid',
    openBrowserOnLaunch:
      typeof data.openBrowserOnLaunch === 'boolean'
        ? data.openBrowserOnLaunch
        : DEFAULT_SETTINGS.openBrowserOnLaunch,
    freezeSmartCollection:
      typeof data.freezeSmartCollection === 'boolean'
        ? data.freezeSmartCollection
        : DEFAULT_SETTINGS.freezeSmartCollection,
    imageSearchConsent:
      typeof data.imageSearchConsent === 'boolean'
        ? data.imageSearchConsent
        : DEFAULT_SETTINGS.imageSearchConsent,
    imageSearchCollectLimit: clampDays(
      data.imageSearchCollectLimit,
      DEFAULT_SETTINGS.imageSearchCollectLimit,
      1,
      50
    ),
    assetCleanup: {
      enabled: typeof cleanupRaw.enabled === 'boolean' ? cleanupRaw.enabled : DEFAULT_ASSET_CLEANUP.enabled,
      graceDays: clampDays(
        cleanupRaw.graceDays,
        DEFAULT_ASSET_CLEANUP.graceDays,
        MIN_GRACE_DAYS,
        MAX_GRACE_DAYS
      ),
      trashDays: clampDays(
        cleanupRaw.trashDays,
        DEFAULT_ASSET_CLEANUP.trashDays,
        MIN_TRASH_DAYS,
        MAX_TRASH_DAYS
      )
    },
    shortcuts: normalizeShortcutBindings(data.shortcuts)
  }
}

/** 一次只带要改的那几项；没带的字段保持原样。 */
export function mergeSettings(current: AppSettings, patch: unknown): AppSettings {
  if (typeof patch !== 'object' || patch === null) return current
  const data = patch as Record<string, unknown>
  const next: Record<string, unknown> = {
    copyConvertToPng: current.copyConvertToPng,
    canvasColor: current.canvasColor,
    libraryView: current.libraryView,
    openBrowserOnLaunch: current.openBrowserOnLaunch,
    freezeSmartCollection: current.freezeSmartCollection,
    imageSearchConsent: current.imageSearchConsent,
    imageSearchCollectLimit: current.imageSearchCollectLimit,
    assetCleanup: current.assetCleanup,
    shortcuts: current.shortcuts
  }
  for (const key of ['copyConvertToPng', 'canvasColor', 'libraryView', 'openBrowserOnLaunch', 'freezeSmartCollection', 'imageSearchConsent', 'imageSearchCollectLimit'] as const) {
    if (key in data) next[key] = data[key]
  }
  if (typeof data.assetCleanup === 'object' && data.assetCleanup !== null) {
    next.assetCleanup = { ...current.assetCleanup, ...(data.assetCleanup as Record<string, unknown>) }
  }
  if (typeof data.shortcuts === 'object' && data.shortcuts !== null) {
    next.shortcuts = { ...current.shortcuts, ...(data.shortcuts as Record<string, unknown>) }
  }
  return normalizeSettings(next)
}

export function cleanupWindowMs(cleanup: AssetCleanupSettings): {
  graceMs: number
  trashMs: number
} {
  const day = 24 * 60 * 60 * 1000
  return { graceMs: cleanup.graceDays * day, trashMs: cleanup.trashDays * day }
}
