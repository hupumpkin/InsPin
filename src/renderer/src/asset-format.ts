import type { ImportMethod } from '../../shared/ipc'
import type { AssetBadge, Node } from '../../shared/node'

/**
 * 检查器与素材库里用到的文案/数字格式化（D1.8 / D1.10）。
 *
 * 纯函数，方便单测——也保证界面各处对同一份数据说法一致。
 */

const METHOD_LABELS: Record<ImportMethod, string> = {
  file: '从文件导入',
  clipboard: '从剪贴板粘贴',
  drag: '从网页拖入',
  pin: '右键钉入',
  capture: '网页截图',
  collect: '智能采集'
}

export function importMethodLabel(method: ImportMethod): string {
  return METHOD_LABELS[method] ?? '导入'
}

/** "这不是原图"的小标签（D3.13 / D3.16）。画布上、检查器里用的是同一句话。 */
const BADGE_LABELS: Record<AssetBadge, string> = {
  'low-res': '低清副本',
  screenshot: '截图副本'
}

export function assetBadgeLabel(badge: AssetBadge): string {
  return BADGE_LABELS[badge]
}

/** 素材文件已经不在磁盘上时挂的标签（D6a.3）。跟"低清副本"一样贴在图片角上。 */
export const MISSING_ASSET_LABEL = '素材缺失'

/** 人类可读的文件大小；0 与负数都当 0 处理。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 本地时间的 `YYYY/MM/DD HH:mm`；解不出来的时间原样返回。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 从网址里取域名；不是合法网址就返回 null（界面上不显示这一行）。 */
export function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

const KIND_LABELS: Record<Node['type'], string> = {
  asset: '图片',
  group: '编组',
  frame: '容器'
}

export function nodeKindLabel(node: Node): string {
  if (node.type === 'frame' && node.props.element) {
    if (node.props.element.kind === 'shape') return node.props.element.shape === 'ellipse' ? '圆形' : node.props.element.shape === 'line' ? '线条' : '矩形'
    if (node.props.element.kind === 'text') return '文本'
  }
  return KIND_LABELS[node.type] ?? '对象'
}
