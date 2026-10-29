import { Assets, Container, Graphics, Sprite, Text as PixiText, type Texture } from 'pixi.js'
import { THUMBNAIL_MAX_EDGE } from '../../../shared/asset-url'
import type { AssetInfo } from '../../../shared/ipc'
import { cropOf } from '../../../shared/crop'
import { TEXT_PADDING, type AssetCrop, type CanvasElement } from '../../../shared/node'
import { TEXT_FONT_FAMILY, textLineHeight } from './text-metrics'
import type { SceneItem } from '../../../shared/scene'
import { fullEdgeAtZoom1, needsOriginal, needsOriginalAt } from './image-lod'

/**
 * 关掉 Pixi 的两条默认加载路径，改成直接用 `Image` 取图。
 *
 * 为什么（两条都是踩过的坑，症状都是**画布静默空白**，只在控制台留一句语焉不详的报错）：
 *   - `preferWorkers: true`（默认）会用 blob 起的 Web Worker 解码图片，而画布页面的 CSP
 *     不允许 blob/worker，WorkerManager 的 promise 就此挂住，纹理永远不出现；
 *   - `preferCreateImageBitmap: true`（默认）走 `fetch → createImageBitmap`，对自定义协议
 *     要求 CORS；虽然我们已经给了 ACAO，但少一层依赖更稳。
 * 关掉之后走 `new Image()`，只需 img-src 放行（见 index.html 的 CSP 注释）。
 */
Assets.setPreferences({ preferWorkers: false, preferCreateImageBitmap: false })

/**
 * 把"渲染树"铺到 Pixi 场景里（路线图 D2.3 / D2.11）。
 *
 * 两条要点：
 *   1. **按父子嵌套摆容器**：子节点的位置是"相对父节点"的偏移，父容器一动，子节点
 *      自然跟着动，不需要任何同步代码（D2.11）。
 *   2. **两级加载**：先用缩略图（小、快）顶上来；只有屏幕尺寸撑破缩略图分辨率时才
 *      加载原图（D1.7 / D6b）。缩小看全局时原图根本不请求，放大后由 `setZoom` 补载。
 */

export interface SceneLayerOptions {
  /** 画布按需渲染：这里每改一次看得见的东西都要请求一帧 */
  requestRender: () => void
  /** 建层时的缩放 */
  zoom: number
  /** 渲染器像素密度（已按上限夹过）；判断"够不够清晰"按设备像素算 */
  pixelRatio: number
}

export interface CanvasUrls {
  assetUrl(fileName: string): string
  thumbUrl(fileName: string): string
}

export interface SceneLayerStats {
  /** 能看见图的节点数（缩略图或原图已就位） */
  textured: number
  /** 原图读不到的节点数（文件被删/损坏） */
  failed: number
}

/** 拖动预览：临时挪动/缩放某些节点，**不改模型**，松手时才提交一条命令。 */
export interface PreviewBox {
  x?: number
  y?: number
  w?: number
  h?: number
  /** 预览时的旋转角（度） */
  rotation?: number
  /** 非破坏式裁切的临时预览；确认前不会写进项目。 */
  crop?: AssetCrop
}

export interface SceneLayer {
  container: Container
  /** 纹理加载告一段落，带上统计。自检用它判断"图真的画出来了"，而不只是"没报错"。 */
  ready: Promise<SceneLayerStats>
  /**
   * 这一层请求过的素材地址（原图 + 缩略图）的**实时集合**；纹理回收据此判断谁还在用。
   * 放大后补载的原图会继续加进来，所以它不能是一次性的快照。
   */
  urls: Set<string>
  /** 缩放变化：放大到缩略图不够用时补载原图；缩小时保留已载入的，不来回折腾 */
  setZoom(zoom: number): void
  /** 拖动/缩放过程中的实时预览（模型坐标，即相对父节点的偏移） */
  preview(boxes: Map<string, PreviewBox>): void
  clearPreview(): void
  /** 原位编辑中的文本先藏起来，由编辑框负责显示，避免两层文字叠出重影。 */
  setEditing(id: string | null): void
  destroy(): void
}

/**
 * 素材没了时画的那块占位（D6a.3）。
 *
 * 只给一块浅灰的方框：**位置和大小跟原图一样**，所以周围的排布不会跳；
 * 文字提示交给 DOM 那层的"素材缺失"标签（字不能跟着缩放糊掉）。
 * 无彩度、比画布略深一点，扫一眼就知道"这块是空的"，而不是"图还没加载出来"。
 */
function makePlaceholder(item: SceneItem): Graphics {
  const w = item.w > 0 ? item.w : 120
  const h = item.h > 0 ? item.h : 90
  const box = new Graphics()
  box.rect(0, 0, w, h)
  box.fill({ color: 0xf1f1f3 })
  box.stroke({ width: 1, color: 0x828794, alignment: 0 })
  return box
}

function color(value: string, fallback: number): number {
  const normalized = value.replace('#', '')
  const parsed = Number.parseInt(normalized, 16)
  return Number.isFinite(parsed) ? parsed : fallback
}

interface CanvasElementRender {
  root: Container
  /**
   * 需要按实际宽高重绘的矢量元素。圆角矩形不能靠非等比 scale 预览：
   * 那会把圆角拉成椭圆，直到松手重建场景才恢复正确形状。
   */
  resize?: (w: number, h: number) => void
}

/** 画布原生元素都落在同一渲染层，因此缩放、移动、选中逻辑天然与图片一致。 */
function makeCanvasElement(item: SceneItem, element: CanvasElement): CanvasElementRender {
  const root = new Container()
  const w = Math.max(1, item.w)
  const h = Math.max(1, item.h)

  if (element.kind === 'shape') {
    const graphic = new Graphics()
    const fill = color(element.fill, 0x635bff)
    const draw = (nextW: number, nextH: number): void => {
      graphic.clear()
      if (element.shape === 'ellipse') graphic.ellipse(nextW / 2, nextH / 2, nextW / 2, nextH / 2).fill({ color: fill })
      else if (element.shape === 'line') graphic.moveTo(0, nextH / 2).lineTo(nextW, nextH / 2).stroke({ width: Math.max(2, nextH), color: fill, cap: 'round' })
      else graphic.roundRect(0, 0, nextW, nextH, Math.min(element.cornerRadius, nextW / 2, nextH / 2)).fill({ color: fill })
    }
    draw(w, h)
    root.addChild(graphic)
    return { root, resize: draw }
  }

  if (element.kind === 'text') {
    const label = new PixiText({
      text: element.text || '文字',
      style: {
        fontFamily: TEXT_FONT_FAMILY,
        fontSize: element.fontSize,
        // 与编辑框用同一个行高；Pixi 会把字号居中放进行高里，下面补回差值。
        lineHeight: textLineHeight(element.fontSize),
        fill: element.color
      },
      // 节点位置常带小数（点哪儿就放哪儿），不落整像素时纹理会被线性重采样，
      // 看上去比正在输入的 DOM 文字“糊一层”。这里把文字贴回设备像素格。
      roundPixels: true
    })
    // 自动宽度文本不折行：只有用户自己回车才换行，盒子横向跟着字长走。
    // 节点盒子带一圈留白（与编辑框同一圈），文字画在留白里面。
    // 行高与编辑框取同一个值；两者都在自己的行盒里按字体度量居中，基线自然对齐。
    label.position.set(TEXT_PADDING, TEXT_PADDING)
    root.addChild(label)
    return { root }
  }

  // 兼容旧项目里已经写入的 comment：它不再渲染气泡，也不会阻断其余画布建层。
  return { root }
}

/** 节点自带尺寸就用它（导入时已按长边上限压过）；没有就用图片原始尺寸。 */
function applySize(sprite: Sprite, item: SceneItem, crop: AssetCrop = cropOf(undefined)): void {
  const w = item.w > 0 ? item.w : sprite.texture.width
  const h = item.h > 0 ? item.h : sprite.texture.height
  if (w > 0 && h > 0) {
    sprite.width = w / crop.w
    sprite.height = h / crop.h
    sprite.position.set(-crop.x * sprite.width, -crop.y * sprite.height)
  }
}

/**
 * 纹理回收（D6b.3）。
 *
 * Pixi 的 `Assets` 是个全局缓存：只加载不释放的话，一路平移看过去，看过的每张图
 * 都会一直占着显存。这里记下"这张画布加载过哪些地址"，每次建完新层就扫一遍，
 * 把**已经不在用**的卸掉。
 *
 * 两个讲究：
 *   - **延迟再扫**：平移会让层重建，刚卸掉的那张可能下一帧又要回来，白白多读一次磁盘。
 *     等两秒再扫，来回平移就不至于反复读；
 *   - **只卸自己加载过的**：不碰别人（比如浮窗那边走的是 `<img>`，跟这个缓存无关，
 *     但万一将来有别的 Pixi 场景，也不该被这里误伤）。
 */
const loadedUrls = new Set<string>()
/** 最近一次报上来的"还在用"集合；延迟扫描时按它决定谁该卸。**持引用，不复制** */
let keepUrls = new Set<string>()
let sweepTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 记录一个由画布按需加载的纹理地址。
 *
 * 缩略图够用时原图不会被加载；放大后补载的原图也要让回收扫描认得，
 * 否则它会一直留在 Pixi 的全局缓存里。
 */
export function trackTexture(url: string): void {
  loadedUrls.add(url)
}

export function releaseUnusedTextures(inUse: Set<string>, delayMs = 2000): void {
  // 直接用这一层自己的实时集合：放大补载原图后集合会变长，两秒后的扫描才看得见
  keepUrls = inUse
  for (const url of inUse) loadedUrls.add(url)
  if (sweepTimer !== null) return
  sweepTimer = setTimeout(() => {
    sweepTimer = null
    for (const url of [...loadedUrls]) {
      if (keepUrls.has(url)) continue
      loadedUrls.delete(url)
      void Assets.unload(url).catch(() => {
        // 卸不掉就算了：这是缓存清理，失败不该冒泡到用户面前
      })
    }
  }, delayMs)
}

export function buildSceneLayer(
  items: SceneItem[],
  assets: Record<string, AssetInfo>,
  urls: CanvasUrls,
  options: SceneLayerOptions
): SceneLayer {
  const { requestRender, pixelRatio } = options
  let currentZoom = options.zoom
  const container = new Container()
  const pending: Promise<void>[] = []
  let destroyed = false
  const stats: SceneLayerStats = { textured: 0, failed: 0 }
  /** 这一层请求过的地址，交给纹理回收判断"谁还在用" */
  const requestedUrls = new Set<string>()

  /**
   * 一张图的两级加载：
   *   - 缩略图先用着；屏幕尺寸撑破缩略图分辨率时才加载原图；
   *   - 缩小时原图根本不请求，放大后由 `setZoom` 补载。
   * 返回"补载原图"的方法，交给 `setZoom` 在跨过阈值时调用。
   */
  const loadAsset = (
    sprite: Sprite,
    item: SceneItem,
    fileName: string,
    holder: Container,
    crop: () => AssetCrop
  ): (() => void) => {
    const thumbUrl = urls.thumbUrl(fileName)
    const fullUrl = urls.assetUrl(fileName)
    let visible = false
    let originalStarted = false
    let originalApplied = false

    const markVisible = (): void => {
      if (visible) return
      visible = true
      stats.textured++
    }

    const loadOriginal = async (): Promise<void> => {
      if (originalStarted || destroyed) return
      originalStarted = true
      requestedUrls.add(fullUrl)
      trackTexture(fullUrl)
      try {
        const full = await Assets.load<Texture>(fullUrl)
        if (destroyed || sprite.destroyed) return
        originalApplied = true
        sprite.texture = full
        applySize(sprite, item, crop())
        requestRender()
        markVisible()
      } catch {
        // 原图读不到（文件被删/损坏）：不让整个画布炸掉
        stats.failed++
      }
    }

    requestedUrls.add(thumbUrl)
    pending.push(
      (async () => {
        try {
          const thumb = await Assets.load<Texture>(thumbUrl)
          if (destroyed || sprite.destroyed) return
          // 放大补载的原图可能先到；别让缩略图把它盖回去
          if (!originalApplied) {
            sprite.texture = thumb
            applySize(sprite, item, crop())
            requestRender()
          }
          // 协议解不了缩略图时会直接返回原图：这张"缩略图"本身够大，不必再补
          if (Math.max(thumb.width, thumb.height) > THUMBNAIL_MAX_EDGE) originalApplied = true
          markVisible()
        } catch {
          // 缩略图拿不到：直接上原图兜底，别让图块空着
          await loadOriginal()
          if (!visible && !destroyed && !holder.destroyed) {
            holder.addChild(makePlaceholder(item))
            requestRender()
          }
          return
        }
        if (!originalApplied && needsOriginal(item, crop(), currentZoom, pixelRatio)) {
          await loadOriginal()
        }
      })()
    )

    return () => {
      void loadOriginal()
    }
  }

  interface HolderEntry {
    holder: Container
    base: { x: number; y: number; w: number; h: number; rotation: number }
    setCrop?: (crop: AssetCrop) => void
    baseCrop?: AssetCrop
    setSize?: (w: number, h: number) => void
    /** 缩略图不够用时补载原图 */
    ensureOriginal?: () => void
    /** 整张图在 100% 下的长边（世界单位），放大时据此判断要不要补载 */
    neededAtZoom1?: number
  }

  /** 每个节点自己的容器，拖动预览直接改它的 position/scale（模型不动） */
  const holders = new Map<string, HolderEntry>()

  const walk = (list: SceneItem[], parent: Container): void => {
    for (const item of list) {
      if (!item.node.visible) continue

      const holder = new Container()
      // 旋转围绕**中心**：pivot 落在盒子中心，position 也就跟着落在中心
      holder.pivot.set(item.w / 2, item.h / 2)
      holder.position.set(item.x + item.w / 2, item.y + item.h / 2)
      holder.rotation = (item.node.rotation * Math.PI) / 180
      parent.addChild(holder)
      const entry: HolderEntry = {
        holder,
        base: { x: item.x, y: item.y, w: item.w, h: item.h, rotation: item.node.rotation }
      }
      holders.set(item.node.id, entry)

      if (item.node.type === 'asset') {
        const info = assets[item.node.props.assetId]
        if (!info || info.missing) {
          // 素材记录没了、或文件已经不在磁盘上：画占位，别去发一个注定失败的请求
          if (info?.missing) stats.failed++
          holder.addChild(makePlaceholder(item))
        } else {
          const crop = cropOf(item.node.props.crop)
          let activeCrop = crop
          // 裁切是显示层的蒙版，原图字节与纹理都不被改写。
          const clipped = new Container()
          const mask = new Graphics().rect(0, 0, item.w, item.h).fill({ color: 0xffffff })
          clipped.mask = mask
          holder.addChild(clipped)
          holder.addChild(mask)
          const sprite = new Sprite()
          const setCrop = (next: AssetCrop): void => {
            activeCrop = cropOf(next)
            applySize(sprite, item, activeCrop)
          }
          setCrop(crop)
          clipped.addChild(sprite)
          entry.setCrop = setCrop
          entry.baseCrop = crop
          entry.ensureOriginal = loadAsset(sprite, item, info.fileName, holder, () => activeCrop)
          entry.neededAtZoom1 = fullEdgeAtZoom1(item, crop)
        }
      } else if (item.node.type === 'frame' && item.node.props.element) {
        const element = makeCanvasElement(item, item.node.props.element)
        holder.addChild(element.root)
        if (element.resize) {
          entry.setSize = (w, h) => {
            // 改 pivot 后仍以左上角为基准摆放，图形才不会在拖动中跳动。
            holder.pivot.set(w / 2, h / 2)
            element.resize?.(w, h)
          }
        }
      }

      walk(item.children, holder)
    }
  }

  walk(items, container)

  return {
    container,
    urls: requestedUrls,
    ready: Promise.allSettled(pending).then(() => stats),

    setZoom(zoom: number): void {
      // 建层时已经按这个缩放决定过了，不必再走一遍
      if (zoom === currentZoom) return
      currentZoom = zoom
      for (const entry of holders.values()) {
        if (!entry.ensureOriginal || entry.neededAtZoom1 === undefined) continue
        if (needsOriginalAt(entry.neededAtZoom1, zoom, pixelRatio)) entry.ensureOriginal()
      }
    },

    preview(boxes: Map<string, PreviewBox>): void {
      for (const [id, entry] of holders) {
        const box = boxes.get(id)
        if (!box) continue
        const w = box.w ?? entry.base.w
        const h = box.h ?? entry.base.h
        // position 是"中心点"（pivot 在中心），所以这里用中心坐标
        if (box.x !== undefined && box.y !== undefined) {
          entry.holder.position.set(box.x + w / 2, box.y + h / 2)
        }
        if (box.w !== undefined && box.h !== undefined && entry.base.w > 0 && entry.base.h > 0) {
          if (entry.setSize) {
            entry.setSize(w, h)
            entry.holder.scale.set(1)
          } else {
            entry.holder.scale.set(box.w / entry.base.w, box.h / entry.base.h)
          }
        }
        if (box.rotation !== undefined) entry.holder.rotation = (box.rotation * Math.PI) / 180
        if (box.crop !== undefined) entry.setCrop?.(box.crop)
      }
      requestRender()
    },

    clearPreview(): void {
      for (const entry of holders.values()) {
        entry.holder.position.set(entry.base.x + entry.base.w / 2, entry.base.y + entry.base.h / 2)
        entry.setSize?.(entry.base.w, entry.base.h)
        entry.holder.scale.set(1)
        entry.holder.rotation = (entry.base.rotation * Math.PI) / 180
        entry.setCrop?.(entry.baseCrop ?? cropOf(undefined))
      }
      requestRender()
    },

    setEditing(id): void {
      // 原地编辑的节点不在画布上重复画一遍（编辑框就是它的实时预览）。
      for (const [nodeId, entry] of holders) entry.holder.visible = nodeId !== id
      requestRender()
    },

    destroy(): void {
      destroyed = true
      holders.clear()
      container.destroy({ children: true })
    }
  }
}
