/**
 * 画布对象模型契约（路线图 §5.5）。
 *
 * 这是 D4a（图层与编组）与 D4b（自动布局）的接口前置：
 * D1 落地存储、D2 打通渲染，之后**只新增命令与 UI，不再改这里的结构**。
 * 新功能一律往 `props` 里加字段，不做破坏性迁移。
 */

export type NodeType = 'asset' | 'group' | 'frame'

/* ---------- 自动布局：容器侧字段（§5.5.3） ---------- */

export type LayoutMode = 'none' | 'horizontal' | 'vertical' | 'grid'
export type PrimaryAxisAlign = 'start' | 'center' | 'end' | 'space-between'
export type CounterAxisAlign = 'start' | 'center' | 'end'
export type AxisSizing = 'fixed' | 'hug'
export type LayoutWrap = 'nowrap' | 'wrap'

export interface Padding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface AutoLayoutProps {
  layoutMode: LayoutMode
  itemSpacing: number
  padding: Padding
  primaryAxisAlignItems: PrimaryAxisAlign
  counterAxisAlignItems: CounterAxisAlign
  primaryAxisSizing: AxisSizing
  counterAxisSizing: AxisSizing
  layoutWrap: LayoutWrap
  gridColumns: number
  clipsContent: boolean
}

/* ---------- 自动布局：子节点侧字段（§5.5.3） ---------- */

export type LayoutAlign = 'inherit' | 'stretch'
export type LayoutPositioning = 'auto' | 'absolute'

/** 任意节点都能带这三个字段，用来表达"我在父容器里怎么摆"。 */
export interface ChildLayoutProps {
  layoutAlign: LayoutAlign
  layoutGrow: number
  layoutPositioning: LayoutPositioning
}

/* ---------- 三类节点的 props（§5.5.2） ---------- */

/**
 * 挂在素材上的小标签（D3.13「低清副本」/ D3.16「截图副本」）。
 * 两件事都是"这不是原图"的提醒，只是来路不同，所以共用一套。
 */
export type AssetBadge = 'low-res' | 'screenshot'

/**
 * 非破坏式裁切区域，使用原图的归一化坐标（0–1）。
 * 节点的 w/h 是画布上的可见框，crop 决定框里露出原图的哪一部分。
 */
export interface AssetCrop {
  x: number
  y: number
  w: number
  h: number
}

export interface AssetProps extends ChildLayoutProps {
  assetId: string
  /** 原图像素尺寸，缩放时用来保持比例 */
  naturalWidth: number
  naturalHeight: number
  /** 有就说明这张不是原图（拿不到高清 / 是截图），画布上会挂一个小标签 */
  badge?: AssetBadge
  /** 未设置即完整原图；裁切只改变显示区域，不重写素材文件。 */
  crop?: AssetCrop
}

/** 纯编组只有包围盒，没有额外字段 */
export type GroupProps = ChildLayoutProps

export type CanvasShapeKind = 'rectangle' | 'ellipse' | 'line'

/**
 * MVP 画布原生元素先复用 frame 节点的布局能力；element 存在时它不再是普通容器，
 * 而是可绘制、可选中、可缩放的形状 / 文本。
 */
export type CanvasElement =
  | { kind: 'shape'; shape: CanvasShapeKind; fill: string; cornerRadius: number }
  | { kind: 'text'; text: string; color: string; fontSize: number }

/**
 * 文本对象四周的留白（世界坐标）。
 * 编辑框与提交后的选中框都用它，输入中和落定后看到的是同一个框。
 */
export const TEXT_PADDING = 3

export interface FrameProps extends ChildLayoutProps, AutoLayoutProps {
  element?: CanvasElement
}

/* ---------- 节点本体（§5.5.1） ---------- */

interface BaseNode {
  id: string
  projectId: string
  parentId: string | null
  /** 顺序 = 绘制顺序 = 图层顺序，只有这一份，避免三者不同步 */
  childIds: string[]
  /** 图层面板可重命名 */
  name: string
  visible: boolean
  locked: boolean
  /** 相对父节点的偏移；顶层节点的父节点视为画布原点 */
  x: number
  y: number
  w: number
  h: number
  rotation: number
}

export interface AssetNode extends BaseNode {
  type: 'asset'
  props: AssetProps
}

export interface GroupNode extends BaseNode {
  type: 'group'
  props: GroupProps
}

export interface FrameNode extends BaseNode {
  type: 'frame'
  props: FrameProps
}

export type Node = AssetNode | GroupNode | FrameNode

/** 扁平存放：id → Node。父子关系只由 parentId + childIds 表达，不嵌套。 */
export type NodeMap = Record<string, Node>

export interface ProjectGraph {
  projectId: string
  /** 顶层节点的绘制顺序；子节点的顺序看各自的 childIds */
  rootIds: string[]
  nodes: NodeMap
}

/* ---------- 默认值与工厂 ---------- */

export function defaultChildLayoutProps(): ChildLayoutProps {
  return { layoutAlign: 'inherit', layoutGrow: 0, layoutPositioning: 'auto' }
}

export function defaultAutoLayoutProps(): AutoLayoutProps {
  return {
    layoutMode: 'none',
    itemSpacing: 0,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    primaryAxisAlignItems: 'start',
    counterAxisAlignItems: 'start',
    primaryAxisSizing: 'fixed',
    counterAxisSizing: 'fixed',
    layoutWrap: 'nowrap',
    gridColumns: 1,
    clipsContent: false
  }
}

interface NodeInit {
  id: string
  projectId: string
  name: string
  x?: number
  y?: number
  w?: number
  h?: number
  parentId?: string | null
}

function baseFields(init: NodeInit): Omit<AssetNode, 'type' | 'props'> {
  return {
    id: init.id,
    projectId: init.projectId,
    parentId: init.parentId ?? null,
    childIds: [],
    name: init.name,
    visible: true,
    locked: false,
    x: init.x ?? 0,
    y: init.y ?? 0,
    w: init.w ?? 0,
    h: init.h ?? 0,
    rotation: 0
  }
}

export function createAssetNode(
  init: NodeInit & {
    assetId: string
    naturalWidth: number
    naturalHeight: number
    /** 不是原图时挂的小标签（低清副本 / 截图副本） */
    badge?: AssetBadge
    props?: Partial<ChildLayoutProps>
  }
): AssetNode {
  const { assetId, naturalWidth, naturalHeight, badge, props, ...rest } = init
  return {
    ...baseFields(rest),
    type: 'asset',
    props: {
      ...defaultChildLayoutProps(),
      ...props,
      assetId,
      naturalWidth,
      naturalHeight,
      ...(badge ? { badge } : {})
    }
  }
}

export function createGroupNode(init: NodeInit & { props?: Partial<ChildLayoutProps> }): GroupNode {
  const { props, ...rest } = init
  return {
    ...baseFields(rest),
    type: 'group',
    props: { ...defaultChildLayoutProps(), ...props }
  }
}

export function createFrameNode(
  init: NodeInit & { props?: Partial<Omit<FrameProps, 'padding'>> & { padding?: Partial<Padding> } }
): FrameNode {
  const { props, ...rest } = init
  return {
    ...baseFields(rest),
    type: 'frame',
    props: {
      ...defaultChildLayoutProps(),
      ...defaultAutoLayoutProps(),
      ...props,
      padding: { ...defaultAutoLayoutProps().padding, ...props?.padding }
    }
  }
}

/** 原生形状与文本的工厂；仍以 frame 落库，历史项目不需要迁移。 */
export function createCanvasElementNode(
  init: NodeInit & { element: CanvasElement; props?: Partial<ChildLayoutProps> }
): FrameNode {
  const { element, props, ...rest } = init
  return createFrameNode({ ...rest, props: { ...props, element } })
}
