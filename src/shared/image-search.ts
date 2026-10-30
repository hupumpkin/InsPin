import type { AssetCrop } from './node'

/** 以图搜图的引擎标识。Bing / Behance 暂无稳定入口，等有入口再加。 */
export type ImageSearchEngineId = 'pinterest' | 'huaban' | 'google' | 'zcool'

/** 搜索推进到哪一步，界面据此换提示文案并露出取消入口。 */
export type ImageSearchStage = 'opening' | 'resolving' | 'injecting' | 'waiting'

export interface ImageSearchProgress {
  engineId: ImageSearchEngineId
  stage: ImageSearchStage
}

export interface ImageSearchCatalogItem {
  id: ImageSearchEngineId
  label: string
  hint?: string
  /** Phase 0 实测结果：ready = 已验证可用 */
  availability: 'ready' | 'needs-login' | 'unverified' | 'unavailable'
  /** 是否支持「复制图片 + 用户按 ⌘V」的兜底 */
  supportsPaste: boolean
}

export type ImageSearchFailureReason =
  | 'no-asset'
  | 'asset-missing'
  | 'unsupported-format'
  | 'network'
  | 'login-required'
  | 'captcha'
  | 'engine-changed'
  | 'timeout'
  | 'cancelled'
  | 'debugger-busy'
  | 'clipboard-failed'
  | 'paste-failed'
  | 'crop-failed'
  | 'consent-required'
  | 'unknown'

export interface ImageSearchStartRequest {
  engineId: ImageSearchEngineId
  /** 只给素材文件名，主进程自己解析磁盘路径 */
  assetFileName: string
  projectId: string
  /** auto = 优先文件注入；paste = 直接走复制 + 粘贴兜底 */
  mode?: 'auto' | 'paste'
  /** 只搜局部：相对原图的归一化裁切框；不传或整图时按原图搜 */
  crop?: AssetCrop
}

export type ImageSearchStartResult =
  | { ok: true; tabId: string; mode: 'inject' | 'paste' }
  | {
      ok: false
      reason: ImageSearchFailureReason
      message: string
      /** 失败时如果已经开了页面，把 tab 带回去，方便用户手动完成 */
      tabId?: string
    }

export const IMAGE_SEARCH_LABELS: Record<ImageSearchEngineId, string> = {
  pinterest: 'Pinterest',
  huaban: '花瓣',
  google: 'Google Lens',
  zcool: '站酷'
}

/** 首次授权时必须告诉用户各站点已经确认的数据留存行为。 */
export function imageSearchConsentDisclosure(engineId: ImageSearchEngineId): string | null {
  if (engineId === 'pinterest') return '上传内容会进入 Pinterest 的镜头上传历史。'
  if (engineId === 'huaban') {
    return '实测只会上传到临时识别桶，不会在你的账号里创建采集或画板。'
  }
  return null
}

const ENGINE_IDS = new Set<string>(Object.keys(IMAGE_SEARCH_LABELS))

/** 渲染层传什么都不可信：只挑认识的字段，其余丢掉。 */
export function parseImageSearchRequest(raw: unknown): ImageSearchStartRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const data = raw as Record<string, unknown>
  if (typeof data.engineId !== 'string' || !ENGINE_IDS.has(data.engineId)) return null
  if (typeof data.assetFileName !== 'string' || data.assetFileName.length === 0) return null
  if (typeof data.projectId !== 'string' || data.projectId.length === 0) return null
  if (data.mode !== undefined && data.mode !== 'auto' && data.mode !== 'paste') return null
  const crop = parseCrop(data.crop)
  if (data.crop !== undefined && !crop) return null
  return {
    engineId: data.engineId as ImageSearchEngineId,
    assetFileName: data.assetFileName,
    projectId: data.projectId,
    mode: data.mode === 'paste' ? 'paste' : 'auto',
    ...(crop ? { crop } : {})
  }
}

/** 裁切框只收 0–1 的归一化坐标；越界就夹回来，NaN / 负宽高直接拒掉。 */
function parseCrop(raw: unknown): AssetCrop | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  const x = data.x
  const y = data.y
  const w = data.w
  const h = data.h
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return null
  if (![x, y, w, h].every(Number.isFinite)) return null
  if (w <= 0 || h <= 0) return null
  const left = clampUnit(x)
  const top = clampUnit(y)
  const right = clampUnit(x + w)
  const bottom = clampUnit(y + h)
  if (right - left <= 0 || bottom - top <= 0) return null
  return { x: snap(left), y: snap(top), w: snap(right - left), h: snap(bottom - top) }
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value))

/** 0.1 + 0.3 的浮点尾巴会漏进请求；收到 6 位小数够用，也便于比较。 */
const snap = (value: number): number => Math.round(value * 1e6) / 1e6
