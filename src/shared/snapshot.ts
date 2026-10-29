import { cropOf, FULL_CROP } from './crop'
import type { AssetInfo } from './ipc'
import type { AssetCrop } from './node'
import type { SceneItem } from './scene'

/**
 * 参考快照（路线图 D5）的共用类型与纯逻辑。
 *
 * **快照是一份"冻结的拷贝"**：创建时把选中的对象摊平成一组绝对盒子存下来，
 * 之后源画布怎么改都不动它——只有用户手动点"刷新"才重新取一次（D5.7）。
 * 这样它在重启后（D5.6）也能原样画出来，不需要再依赖源项目的图。
 *
 * 摊平成"盒子 + 素材引用"而不是存整棵子树：浮窗那边只用 DOM 绝对定位画一遍，
 * 不需要重建父子关系，也就不用把自动布局求解器搬过去。
 */

export const SNAPSHOT_MIN_OPACITY = 0.2
export const SNAPSHOT_MAX_OPACITY = 1
export const SNAPSHOT_MIN_ZOOM = 0.25
export const SNAPSHOT_MAX_ZOOM = 4

export const DEFAULT_SNAPSHOT_OPACITY = 1
export const DEFAULT_SNAPSHOT_ZOOM = 1

/**
 * 新建时浮窗最长边的上限（像素）。
 *
 * 快照是"摆在设计工具旁边看着"的参考，一上来就铺满小半个屏幕反而碍事，
 * 所以默认缩到这个尺寸；嫌小可以在右键菜单里放大（最大 400%）。
 */
export const SNAPSHOT_MAX_EDGE = 480

/** 快照里的一层：一个展平后的绝对盒子，坐标相对快照内容左上角。 */
export interface SnapshotLayer {
  nodeId: string
  kind: 'asset' | 'group' | 'frame'
  name: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  /** 只有 kind === 'asset' 才有：指向素材 */
  assetId?: string
  /**
   * 非破坏式裁切（归一化到 0–1）。缺省 = 整张图——旧快照没有这个字段，
   * 所以读取端必须按 FULL_CROP 处理。
   */
  crop?: AssetCrop
}

export interface SnapshotLayerGeometry {
  /** 真实生效的裁切（已归一化） */
  crop: AssetCrop
  /** 可视框：相对快照内容，已乘缩放；旋转也作用在这一层 */
  outer: { left: number; top: number; width: number; height: number }
  /** 图片相对可视框的盒子：裁切区域被放大到可视框，超出部分由外层裁掉 */
  image: { left: number; top: number; width: number; height: number }
}

/** 旧快照 / 手改坏的数据：裁切字段不是四个有限数时，按整张图处理。 */
function safeCrop(value: AssetCrop | undefined): AssetCrop {
  if (!value) return { ...FULL_CROP }
  const numbers = [value.x, value.y, value.w, value.h]
  if (!numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    return { ...FULL_CROP }
  }
  return cropOf(value)
}

/**
 * 快照里一层图片的几何：可视框固定，图片按裁切放大并偏移。
 *
 * 与画布的 `applySize` 同一套口径：整张图先按 `1 / crop` 放大，再把裁切区域
 * 对齐到可视框左上角。浮窗只负责照这个几何摆 DOM。
 */
export function snapshotLayerGeometry(layer: SnapshotLayer, zoom: number): SnapshotLayerGeometry {
  const crop = safeCrop(layer.crop)
  const width = layer.w * zoom
  const height = layer.h * zoom
  const imageWidth = width / crop.w
  const imageHeight = height / crop.h
  // 乘 0 会得到 -0，写进 DOM 虽然无害，但没必要；统一成 0
  const imageLeft = crop.x === 0 ? 0 : -crop.x * imageWidth
  const imageTop = crop.y === 0 ? 0 : -crop.y * imageHeight
  return {
    crop,
    outer: { left: layer.x * zoom, top: layer.y * zoom, width, height },
    image: {
      left: imageLeft,
      top: imageTop,
      width: imageWidth,
      height: imageHeight
    }
  }
}

export interface SnapshotContent {
  /** 绘制顺序（父在前、子在后） */
  layers: SnapshotLayer[]
  /** 用到的素材信息（assetId → AssetInfo），界面据此拼图片地址 */
  assets: Record<string, AssetInfo>
  /** 素材文件已经不在磁盘上的 assetId —— 浮窗里用可理解的占位块代替（D5.6） */
  missing: string[]
  width: number
  height: number
}

/** 一条快照记录：内容 + 浮窗自己的状态（位置/透明度/缩放/穿透/锁定）。 */
export interface SnapshotRecord {
  id: string
  /** 源画布所属项目；项目没了就只剩冻结内容还能看 */
  projectId: string | null
  /** 创建时选中的顶层节点（手动刷新时按它重新取内容） */
  sourceIds: string[]
  content: SnapshotContent
  /** 浮窗左上角（屏幕坐标） */
  x: number
  y: number
  opacity: number
  zoom: number
  /** 锁定 = 钉住位置 + 鼠标穿透（见 SnapshotView.locked） */
  locked: boolean
  createdAt: string
}

/** 浮窗渲染进程需要的那一份（只有它自己要画的东西，没有项目路径等内部状态）。 */
export interface SnapshotView {
  id: string
  content: SnapshotContent
  opacity: number
  zoom: number
  /**
   * 锁定 = **钉住位置 + 鼠标穿透过去**（用户 2026-10-15 定的：这两件事当一件事，
   * 就叫"锁定"）。锁定后拖不动，点它等于点到它下面的东西；想解开就把鼠标移到
   * 右上角那颗锁上点一下。
   */
  locked: boolean
}

/** 浮窗能改的那几项；缺的项不动。 */
export interface SnapshotPatch {
  opacity?: number
  zoom?: number
  locked?: boolean
}

/**
 * 拖动：浮窗只报"指针在哪"，挪窗口由主进程做。
 * `start` 时把"指针在窗口里的位置"带上，之后每一帧的屏幕坐标减去它就是要摆的新位置。
 */
export type SnapshotDragPayload =
  | { phase: 'start'; offsetX: number; offsetY: number }
  | { phase: 'move'; screenX: number; screenY: number }
  | { phase: 'end' }

export type SnapshotCreateResult = { ok: true; id: string } | { ok: false; message: string }

export type SnapshotRefreshResult =
  | { ok: true; view: SnapshotView }
  | { ok: false; message: string }

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SNAPSHOT_OPACITY
  return Math.min(SNAPSHOT_MAX_OPACITY, Math.max(SNAPSHOT_MIN_OPACITY, value))
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SNAPSHOT_ZOOM
  return Math.min(SNAPSHOT_MAX_ZOOM, Math.max(SNAPSHOT_MIN_ZOOM, value))
}

/** 浮窗内容尺寸 = 内容大小 × 缩放；至少 1px，免得窗口尺寸非法。 */
export function snapshotWindowSize(
  content: { width: number; height: number },
  zoom: number
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(content.width * zoom)),
    height: Math.max(1, Math.round(content.height * zoom))
  }
}

/** 内容太大时整体缩到一个能看的尺寸（只在创建时算一次，之后由用户的缩放决定）。 */
export function fitZoomFor(content: { width: number; height: number }): number {
  const longest = Math.max(content.width, content.height, 1)
  if (longest <= SNAPSHOT_MAX_EDGE) return 1
  return clampZoom(SNAPSHOT_MAX_EDGE / longest)
}

/**
 * 把选中的对象摊平成快照内容。
 *
 * - 选中的节点连同**全部子孙**一起进快照（选一个组 = 组里所有图都进来，D5.5）；
 * - 坐标统一换算成"相对内容左上角"，浮窗照着画就行；
 * - 不可见的节点跳过（跟画布一致）；
 * - `assetInfo` 拿素材信息，`isMissing` 判断素材文件是否还在（D5.6）。
 *
 * 没选中任何东西（或都不可见）返回 null。
 */
export function collectSnapshotContent(
  items: SceneItem[],
  selectedIds: string[],
  assetInfo: (assetId: string) => AssetInfo | null,
  isMissing: (assetId: string) => boolean
): SnapshotContent | null {
  const wanted = new Set(selectedIds)
  if (wanted.size === 0) return null

  // 选中的顶层项：碰到就整棵收下，不再往里找别的选中项
  const picked: SceneItem[] = []
  const collect = (list: SceneItem[]): void => {
    for (const item of list) {
      if (wanted.has(item.node.id)) picked.push(item)
      else collect(item.children)
    }
  }
  collect(items)

  const visible = picked.filter((item) => item.node.visible)
  if (visible.length === 0) return null

  const left = Math.min(...visible.map((item) => item.absX))
  const top = Math.min(...visible.map((item) => item.absY))
  const right = Math.max(...visible.map((item) => item.absX + item.w))
  const bottom = Math.max(...visible.map((item) => item.absY + item.h))

  const layers: SnapshotLayer[] = []
  const assets: Record<string, AssetInfo> = {}
  const missing: string[] = []

  const flatten = (item: SceneItem): void => {
    const node = item.node
    if (!node.visible) return

    if (node.type === 'asset') {
      const assetId = node.props.assetId
      layers.push({
        nodeId: node.id,
        kind: 'asset',
        name: node.name,
        x: item.absX - left,
        y: item.absY - top,
        w: item.w,
        h: item.h,
        rotation: node.rotation,
        assetId,
        // 裁切是画布上的显示层属性；快照必须一起冻结，否则钉出来是整张图
        crop: cropOf(node.props.crop)
      })
      if (!assets[assetId]) {
        const info = assetInfo(assetId)
        if (info) assets[assetId] = info
      }
      if (isMissing(assetId) && !missing.includes(assetId)) missing.push(assetId)
    } else {
      layers.push({
        nodeId: node.id,
        kind: node.type,
        name: node.name,
        x: item.absX - left,
        y: item.absY - top,
        w: item.w,
        h: item.h,
        rotation: node.rotation
      })
    }

    for (const child of item.children) flatten(child)
  }

  for (const item of visible) flatten(item)

  return {
    layers,
    assets,
    missing,
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top))
  }
}

/** 从存下来的（可能是旧版本 / 手改过的）JSON 里恢复一条记录；形状不对返回 null。 */
export function reviveSnapshotRecord(raw: unknown): SnapshotRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = value['id']
  const content = value['content']
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof content !== 'object' || content === null) return null

  const size = content as { width?: unknown; height?: unknown; layers?: unknown }
  if (!Array.isArray(size.layers)) return null
  const width = typeof size.width === 'number' && size.width > 0 ? size.width : 1
  const height = typeof size.height === 'number' && size.height > 0 ? size.height : 1

  const num = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isFinite(input) ? input : fallback

  const sourceIds = Array.isArray(value['sourceIds'])
    ? value['sourceIds'].filter((entry): entry is string => typeof entry === 'string')
    : []

  return {
    id,
    projectId: typeof value['projectId'] === 'string' ? value['projectId'] : null,
    sourceIds,
    content: content as SnapshotContent,
    x: num(value['x'], 0),
    y: num(value['y'], 0),
    opacity: clampOpacity(num(value['opacity'], DEFAULT_SNAPSHOT_OPACITY)),
    zoom: clampZoom(num(value['zoom'], DEFAULT_SNAPSHOT_ZOOM)),
    locked: value['locked'] === true,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : new Date(0).toISOString()
  }
}
