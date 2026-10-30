import type { NativeImage, Rectangle } from 'electron'
import { isUsableCrop, toImageCrop, type CropRect } from '../shared/capture'
import type { CaptureCandidateCollection } from './capture-candidates'
import type { CaptureMode, CapturePlacement, CaptureStartResult, WindowRect } from '../shared/ipc'

/**
 * 区域截图的主进程一侧（路线图 D3.16）。
 *
 * **为什么要留着一整张图不放**：抓下来的 `NativeImage` 只在框选开始时抓一次，
 * 一直留在主进程，等用户框完才裁。不中途重抓有两个原因：
 *   1. 框选期间原生视图是**藏起来**的，`capturePage()` 在被遮挡/隐藏的视图上会挂住不返回；
 *   2. 用户框的就是他按下按钮那一刻看到的那一屏，重抓反而可能已经翻页了。
 */

export interface PendingCapture {
  image: NativeImage
  /** 截取区在窗口里的位置（CSS 像素） */
  box: Rectangle
  /** 智能采集时才有；原始地址永远不离开主进程。 */
  originalUrls: Map<string, string>
  /** 候选所属作品详情页；没有时再用当前列表页。 */
  sourceUrls: Map<string, string>
  /** 作为素材来源锚点的网页地址。 */
  pageUrl: string | null
  /** 是否要让原生网页让位给截图覆盖层。 */
  freezePage: boolean
  /** 这次会话是普通截图还是智能采集；只有智能采集允许中途切换冻结状态。 */
  mode: CaptureMode
}

export class CaptureSession {
  private pending: PendingCapture | null = null
  /** 连续采集以第一张实际落下后的盒子为锚，避免不同图片尺寸导致重叠。 */
  private collectionAnchor: { x: number; y: number; width: number; height: number } | null = null
  private collectionNextX: number | null = null

  /** 框选开始：存下这张图，交给调用方去藏原生视图。 */
  begin(
    image: NativeImage,
    box: Rectangle,
    collection: CaptureCandidateCollection,
    pageUrl: string | null,
    mode: CaptureMode,
    freezePage = true
  ): CaptureStartResult {
    if (image.isEmpty()) return { ok: false, message: '没能截到这个页面' }
    if (box.width < 2 || box.height < 2) return { ok: false, message: '浏览区太小了，先把它拉大一点' }
    this.pending = {
      image,
      box,
      originalUrls: collection.originalUrls,
      sourceUrls: collection.sourceUrls,
      pageUrl,
      freezePage,
      mode
    }
    this.collectionAnchor = null
    this.collectionNextX = null
    const size = image.getSize()
    return {
      ok: true,
      dataUrl: image.toDataURL(),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      candidates: collection.candidates,
      mode,
      ...(mode === 'collect' && !freezePage ? { live: true } : {})
    }
  }

  cancel(): void {
    this.pending = null
    this.collectionAnchor = null
    this.collectionNextX = null
  }

  get active(): boolean {
    return this.pending !== null
  }

  get hidesBrowser(): boolean {
    return this.pending?.freezePage === true
  }

  get mode(): CaptureMode | null {
    return this.pending?.mode ?? null
  }

  /**
   * 采集中途切换冻结 / 不冻结。用当前这一帧重建 pending，但**不重置**
   * 连续采集的排布锚点——切换模式不该让后续图片另起一行。
   */
  switchMode(
    image: NativeImage,
    box: Rectangle,
    collection: CaptureCandidateCollection,
    pageUrl: string | null,
    freezePage: boolean
  ): CaptureStartResult | null {
    if (!this.pending || this.pending.mode !== 'collect') return null
    if (image.isEmpty() || box.width < 2 || box.height < 2) return null
    this.pending = {
      image,
      box,
      originalUrls: collection.originalUrls,
      sourceUrls: collection.sourceUrls,
      pageUrl,
      freezePage,
      mode: 'collect'
    }
    const size = image.getSize()
    return {
      ok: true,
      dataUrl: image.toDataURL(),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      candidates: collection.candidates,
      mode: 'collect',
      ...(freezePage ? {} : { live: true })
    }
  }

  /**
   * 切换到滚动屏幕（不冻结）。这一步**不用重新抓图**：滚动模式每次点击都会
   * 现抓当前帧（`refresh`），切过去只需要把标记翻过来、让网页露出来，
   * 因此可以做到几乎没有延迟。保留原 pending，供切回锁定时复用排布锚点。
   */
  switchToLive(): CaptureStartResult | null {
    const current = this.pending
    if (!current || current.mode !== 'collect') return null
    this.pending = { ...current, freezePage: false }
    return {
      ok: true,
      dataUrl: '',
      box: {
        x: current.box.x,
        y: current.box.y,
        width: current.box.width,
        height: current.box.height
      },
      candidates: [],
      mode: 'collect',
      live: true
    }
  }

  /** 网页滚动后，非冻结采集按当前一帧更新候选与截图，但连续排布锚点不能重置。 */
  refresh(
    image: NativeImage,
    box: Rectangle,
    collection: CaptureCandidateCollection,
    pageUrl: string | null
  ): boolean {
    const current = this.pending
    if (!current || image.isEmpty() || box.width < 2 || box.height < 2) return false
    this.pending = {
      image,
      box,
      originalUrls: collection.originalUrls,
      sourceUrls: collection.sourceUrls,
      pageUrl,
      freezePage: false,
      mode: current.mode
    }
    return true
  }

  originalUrlFor(candidateId: string | null | undefined): string | null {
    if (!candidateId || !this.pending) return null
    return this.pending.originalUrls.get(candidateId) ?? null
  }

  sourceUrlFor(candidateId: string | null | undefined): string | null {
    if (!candidateId || !this.pending) return null
    return this.pending.sourceUrls.get(candidateId) ?? null
  }

  get pageUrl(): string | null {
    return this.pending?.pageUrl ?? null
  }

  /**
   * 第一张保持在用户正在看的画布中心；之后统一从第一张的右侧开始，顶边对齐、间距 24px。
   * 这里不能猜图片尺寸，必须等实际节点落库后由 `rememberCollectionNode` 记录。
   */
  collectionPlacement(center: { x: number; y: number } | null): CapturePlacement {
    const anchor = this.collectionAnchor
    if (!anchor) return { at: null, center }
    return { at: { x: this.collectionNextX ?? anchor.x + anchor.width + 24, y: anchor.y }, center: null }
  }

  rememberCollectionNode(node: { x: number; y: number; width: number; height: number } | undefined): void {
    if (!node) return
    if (!this.collectionAnchor) this.collectionAnchor = node
    this.collectionNextX = node.x + node.width + 24
  }

  /**
   * 按框选裁下来。选框用窗口坐标给，这里换算成图像素（倍率、越界都在 `toImageCrop` 里处理）。
   * 单次操作会清掉这一次的图；连续智能采集保留同一帧，直到用户主动退出。
   */
  crop(selection: WindowRect, preserve = false): { bytes: Uint8Array; width: number; height: number } | null {
    const pending = this.pending
    if (!preserve) this.pending = null
    if (!pending) return null

    const size = pending.image.getSize()
    const box: WindowRect = {
      x: pending.box.x,
      y: pending.box.y,
      width: pending.box.width,
      height: pending.box.height
    }
    const rect: CropRect = toImageCrop(selection, { x: box.x, y: box.y }, size, box)
    if (!isUsableCrop(rect)) return null

    const cropped = pending.image.crop(rect)
    if (cropped.isEmpty()) return null
    const croppedSize = cropped.getSize()
    return { bytes: new Uint8Array(cropped.toPNG()), width: croppedSize.width, height: croppedSize.height }
  }
}
