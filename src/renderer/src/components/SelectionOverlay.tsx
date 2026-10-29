import { useEffect, useRef, useState } from 'react'
import type { Viewport } from '../../../shared/ipc'
import type { SceneItem } from '../../../shared/scene'
import { isAutoLayoutContainer } from '../../../shared/auto-layout'
import {
  boundsOfItems,
  boxesOfItems,
  rotationsOfItems,
  type Rect
} from '../canvas/hit-test'
import { HANDLES, screenBox, screenBoxRotated, screenInsertionLine } from '../canvas/handles'
import type { GuideLine } from '../canvas/snapping'
import { toScreen } from '../canvas/viewport'

/**
 * 画布上的"操作层"：悬停预选框、选中框、角手柄、框选矩形、尺寸标注
 * （路线图 D2.4 / D2.5；交互细节对齐 Figma）。
 *
 * 为什么用 DOM 而不是在 Pixi 里画：
 *   - **线宽与手柄不随缩放变粗变细**（1.5px 框 / 8px 手柄是固定值）；
 *   - 1px 线在 DOM 上更锐利；
 *   - 悬停、过渡这些用 CSS 表达最省事。
 * 代价是每次平移缩放要重算，但这里只有几个元素。
 *
 * 全部 `pointer-events: none`：指针逻辑统一在画布里，避免两套事件打架。
 *
 * **动画纪律**：只有"悬停/出现"这类状态过渡（~100ms）；位置尺寸一律不过渡——
 * 拖动和缩放时任何延迟都会让框"跟不上手"。
 */

export interface SizeBadge {
  bounds: Rect
  text: string
}

interface SelectionOverlayProps {
  items: SceneItem[]
  selectedIds: string[]
  /** 指针悬停但**未选中**的节点；用来画预选框 */
  hoverId: string | null
  viewport: Viewport
  /** 正在拖的框选矩形（世界坐标） */
  marquee: Rect | null
  /** 缩放/旋转过程中显示的尺寸标注 */
  sizeBadge?: SizeBadge | null
  /** 拖动/缩放时的对齐参考线 */
  guides?: GuideLine[]
  /** 拖进自动布局容器时的插入线（世界坐标，D4b.7） */
  insertion?: Rect | null
  /**
   * 拖动/缩放过程中被操作对象的**实时盒子**（世界坐标）。
   * 模型要等松手才改，不传这个的话选中框会停在原地、不跟手。
   */
  liveBoxes?: Map<string, Rect> | null
  /** 正在移动对象：暂时收起选择和轮廓框，避免拖动时一直挡在对象上。 */
  moving?: boolean
}

export default function SelectionOverlay({
  items,
  selectedIds,
  hoverId,
  viewport,
  marquee,
  sizeBadge = null,
  guides = [],
  insertion = null,
  liveBoxes = null,
  moving = false
}: SelectionOverlayProps): React.JSX.Element {
  const boxes = boxesOfItems(items, selectedIds)
  // 拖动中优先用实时盒子：模型还是旧位置，框得跟着手指走
  const live = liveBoxes ?? new Map<string, Rect>()
  for (const [id, box] of live) {
    if (boxes.has(id)) boxes.set(id, box)
  }
  const bounds = boundsOfItems(items, selectedIds, live)
  const multi = selectedIds.length > 1
  const rotations = rotationsOfItems(items, [...selectedIds, ...(hoverId ? [hoverId] : [])])
  // 多选时各节点角度可能不同，选中框统一按"不旋转"画（Figma 也是这样）
  const selectionRotation = selectedIds.length === 1 ? (rotations.get(selectedIds[0] ?? '') ?? 0) : 0
  const hoverRotation = hoverId ? (rotations.get(hoverId) ?? 0) : 0

  // 自动布局容器的大小由内容和参数决定，拖控制点缩放没有意义，只保留边界框。
  const singleNode = selectedIds.length === 1 ? findNode(items, selectedIds[0]!) : null
  const showHandles = Boolean(singleNode && !isAutoLayoutContainer(singleNode))

  // 悬停框要能淡出：留住最后一次的位置，用 opacity 控制显隐
  const hoverBounds = hoverId ? (boxesOfItems(items, [hoverId]).get(hoverId) ?? null) : null
  const lastHover = useRef<Rect | null>(null)
  if (hoverBounds) lastHover.current = hoverBounds
  const shownHover = hoverBounds ?? lastHover.current

  // 首次出现不做淡入（否则一进画布就闪一下），之后才过渡
  const [animated, setAnimated] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setAnimated(true), 0)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="overlay" aria-hidden="true" data-animated={animated}>
      {/* 悬停预选框：细一圈，没有手柄 */}
      {shownHover && (
        <div
          className="overlay__hover"
          style={{
            ...screenBoxRotated(shownHover, hoverBounds ? hoverRotation : 0, viewport),
            opacity: hoverBounds ? 1 : 0
          }}
        />
      )}

      {/* 多选时每个被选对象各自的细轮廓（Figma 也是这么给的） */}
      {multi &&
        !moving &&
        [...boxes.entries()].map(([id, box]) => (
          <div
            key={id}
            className="overlay__outline"
            style={screenBoxRotated(box, rotations.get(id) ?? 0, viewport)}
          />
        ))}

      {bounds && !moving && (
        <div className="overlay__box" style={screenBoxRotated(bounds, selectionRotation, viewport)}>
          {/* 尺寸标注挂在框上，跟着一起转（Figma 同款） */}
          {sizeBadge && <div className="overlay__badge">{sizeBadge.text}</div>}
          {/* 单选时给出 8 个缩放控制点；自动布局容器不参与缩放，不显示。 */}
          {showHandles &&
            HANDLES.map((handle) => (
              <span key={handle} className="overlay__handle" data-handle={handle} />
            ))}
        </div>
      )}

      {marquee && <div className="overlay__marquee" style={screenBox(marquee, viewport)} />}

      {/* 对齐参考线：横轴画竖线、纵轴画横线；两端各加一颗小星，端点更醒目 */}
      {guides.map((guide, index) => (
        <div
          key={index}
          className="overlay__guide"
          data-axis={guide.axis}
          style={guideStyle(guide, viewport)}
        >
          <span className="overlay__guide-star" data-end="start" />
          <span className="overlay__guide-star" data-end="end" />
        </div>
      ))}

      {/* 拖进自动布局容器时的插入线（Figma 同款：一条蓝线，厚度不随缩放变细） */}
      {insertion && (
        <div className="overlay__insertion" style={screenInsertionLine(insertion, viewport)} />
      )}
    </div>
  )
}

function findNode(items: SceneItem[], id: string): SceneItem['node'] | null {
  for (const item of items) {
    if (item.node.id === id) return item.node
    const found = findNode(item.children, id)
    if (found) return found
  }
  return null
}

function guideStyle(guide: GuideLine, viewport: Viewport): React.CSSProperties {
  if (guide.axis === 'x') {
    const top = toScreen(viewport, { x: 0, y: guide.start })
    const bottom = toScreen(viewport, { x: 0, y: guide.end })
    return { left: toScreen(viewport, { x: guide.position, y: 0 }).x, top: top.y, width: 1, height: bottom.y - top.y }
  }
  const left = toScreen(viewport, { x: guide.start, y: 0 })
  const right = toScreen(viewport, { x: guide.end, y: 0 })
  return { left: left.x, top: toScreen(viewport, { x: 0, y: guide.position }).y, width: right.x - left.x, height: 1 }
}

