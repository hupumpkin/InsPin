import type { ImportResult } from '../../shared/ipc'
import { formatAccelerator } from '../../shared/shortcuts'
import { toast, type ToastNotice } from './toast'

/**
 * 导入结束后给用户看的一句话（路线图 D1.6 的"非图片/损坏提示"）。
 *
 * 纯函数、不碰 DOM，所以能直接单测。原则：
 *   - 说清"进了几张、哪个文件没进来"，把长路径和技术细节留在日志；
 *   - **只出现文件名**，不出现本机路径；
 *   - 一个文件都没进来时，不要出现"已导入 0 张"这种别扭说法。
 */

type OkResult = Extract<ImportResult, { ok: true }>

function failurePart(result: OkResult): string {
  const first = result.errors[0]
  if (!first) return ''
  return result.errors.length > 1 ? `${result.errors.length} 个文件未导入` : `未导入「${first.name}」`
}

/** 文件导入（拖入 / 文件选择器）后的提示。 */
export function describeImport(result: OkResult): ToastNotice {
  if (result.errors.length === 0) return toast('success', `已导入 ${result.importedCount} 张图片`)
  const failure = failurePart(result)
  const message = result.importedCount > 0 ? `已导入 ${result.importedCount} 张图片；${failure}` : `导入失败：${failure}`
  return toast('error', message, { dismissible: true })
}

/** 剪贴板粘贴后的提示。 */
export function describeClipboardImport(result: OkResult): ToastNotice {
  if (result.importedTextCount) return toast('success', '已粘贴文本到画布')
  if (result.importedCount > 0) return toast('success', `已导入 ${result.importedCount} 个素材`)
  return toast('error', result.errors[0]?.message ?? '未检测到可导入的图片或 SVG', { dismissible: true })
}

/**
 * 从网页拖进来的提示。
 *
 * 不提"哪个文件没进来"——本来就没有文件名，硬套 `describeImport` 会说出
 * 「没能导入「」」这种别扭话。失败时直接给原因。
 */
/** 网页拖图失败时统一引导到智能采集；键位跟随用户的当前绑定。 */
export function webImportFailureMessage(smartCollectShortcut?: string | null): string {
  const key = smartCollectShortcut ? formatAccelerator(smartCollectShortcut) : ''
  return key ? `收集失败，按【${key}】智能采集试试` : '收集失败，试试智能采集'
}

export function describeWebImport(
  result: OkResult,
  smartCollectShortcut?: string | null
): ToastNotice {
  if (result.importedCount > 0 && result.errors.length === 0) return toast('success', '已收集到画布')
  if (result.importedCount > 0) return toast('error', `已收集 ${result.importedCount} 张图片；部分图片未收集`, { dismissible: true })
  return toast('error', webImportFailureMessage(smartCollectShortcut), { dismissible: true })
}

/** 区域截图放进画布后的提示（D3.16）。截图落下时节点上已经挂了「截图副本」。 */
export function describeCaptureImport(result: OkResult): ToastNotice {
  if (result.importedCount > 0) return toast('success', '截图已添加到画布')
  return toast('error', result.errors[0]?.message ?? '截图添加失败', { dismissible: true })
}

/** 智能采集会优先保留原图，拿不到时才无感降级到视觉截图。 */
export function describeSmartCollection(result: OkResult): ToastNotice {
  if (result.importedCount > 0 && result.collectionKind === 'original') return toast('success', '已收集原图到画布')
  if (result.importedCount > 0 && result.collectionKind === 'screenshot') {
    return toast('success', '原图不可用，已保存视觉截图')
  }
  return toast('error', result.errors[0]?.message ?? '智能采集失败', { dismissible: true })
}
