import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Tree,
  adjustMoveIndex,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi
} from 'react-arborist'
import { Gallery2 } from 'reicon-react'
import type { ProjectSummary } from '../../../shared/ipc'
import { createDeleteNodesCommand } from '../../../shared/node-commands'
import {
  createRemoveAutoLayoutCommand,
  createWrapInAutoLayoutCommand
} from '../../../shared/auto-layout-commands'
import { isAutoLayoutContainer } from '../../../shared/auto-layout'
import { formatAccelerator, matchesAccelerator } from '../../../shared/shortcuts'
import {
  createGroupCommand,
  createMoveNodeCommand,
  createRenameNodeCommand,
  createReorderNodesCommand,
  createSetNodeFlagsCommand,
  createUngroupCommand,
  type ReorderMode
} from '../../../shared/tree-commands'
import ContextMenu from './ContextMenu'
import {
  displayChildIds,
  displayToModelIndex,
  toArboristTree,
  type LayerTreeNode
} from '../layers-model'
import { useGraphStore } from '../state/graph'
import { useProjectStore } from '../state/projects'
import { useSelectionStore } from '../state/selection'
import { useUiStore } from '../state/ui'
import autoLayoutIcon from '../assets/icons/relay-auto-layout.svg'
import chevronIcon from '../assets/icons/relay-canvas-chevron.svg'
import ellipseIcon from '../assets/icons/relay-ellipse.svg'
import groupIcon from '../assets/icons/relay-group.svg'
import lineIcon from '../assets/icons/relay-line.svg'
import panelCloseIcon from '../assets/icons/relay-panel-close.svg'
import panelPlusIcon from '../assets/icons/relay-panel-plus.svg'
import rectangleIcon from '../assets/icons/relay-rectangle.svg'
import textIcon from '../assets/icons/relay-text.svg'

/**
 * 图层面板（路线图 D4a.2–4a.7，行为对齐 Figma）。
 *
 * 视觉对齐 Relay 节点 33:4042：白色卡片、单列文本、选中底色与行内展开箭头。
 *
 * **渲染与拖拽交给 react-arborist（MIT）**：它提供拖拽排序、**蓝色落点线 + 圆点**、行内
 * 重命名、多选、虚拟滚动，正好是 Figma 图层面板要的那套。我们只做两件事：
 *   1. 把对象模型翻成它认的树（显示顺序 = 模型倒序，见 layers-model.ts）；
 *   2. 把它的操作翻译成**命令**（换父/排序/改名/显隐/锁定/编组/删除），于是撤销重做自动生效。
 */

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID
  return typeof uuid === 'function'
    ? uuid.call(globalThis.crypto)
    : `n-${Math.random().toString(36).slice(2)}`
}

/**
 * 观察容器尺寸，react-arborist 需要像素级的宽高。
 *
 * **要减掉 padding**：react-arborist 的行是绝对定位的，`padding` 撑不开它们；
 * 若按含 padding 的尺寸传宽度，行会比内容区宽、一直贴到面板边缘（选中底色溢出圆角）。
 */
function useElementSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const style = getComputedStyle(el)
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      setSize({
        width: Math.max(0, el.clientWidth - padX),
        height: Math.max(0, el.clientHeight - padY)
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

interface MenuState {
  x: number
  y: number
  id: string
}

interface LayersPanelProps {
  placement?: 'canvas-controls'
}

export default function LayersPanel({ placement }: LayersPanelProps): React.JSX.Element {
  const graph = useGraphStore((state) => state.graph)
  const execute = useGraphStore((state) => state.execute)
  const copy = useGraphStore((state) => state.copy)
  const duplicate = useGraphStore((state) => state.duplicate)
  const paste = useGraphStore((state) => state.paste)
  const clipboardCount = useGraphStore((state) => state.clipboardCount)

  const selectedIds = useSelectionStore((state) => state.ids)
  const select = useSelectionStore((state) => state.set)
  const setHover = useSelectionStore((state) => state.setHover)
  const shortcuts = useUiStore((state) => state.shortcuts)

  const treeRef = useRef<TreeApi<LayerTreeNode> | undefined>(undefined)
  const listRef = useRef<HTMLDivElement | null>(null)
  const size = useElementSize(listRef)

  const [menu, setMenu] = useState<MenuState | null>(null)

  const data = useMemo(() => (graph ? toArboristTree(graph) : []), [graph])
  // 画布那边改了选中（点画布、Esc、删除）时，把选中同步回面板
  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    const current = new Set(tree.selectedIds)
    const next = new Set(selectedIds)
    if (current.size === next.size && [...next].every((id) => current.has(id))) return
    tree.deselectAll()
    for (const id of selectedIds) tree.selectMulti(id)
  }, [selectedIds, data])

  const selectedSet = new Set(selectedIds)
  const canGroup = selectedIds.length >= 1
  const canUngroup = selectedIds.some((id) => {
    const node = graph?.nodes[id]
    return node ? node.type === 'group' || node.type === 'frame' : false
  })

  // ── 操作（全部走命令）─────────────────────────────────────────────
  const group = (): void => {
    if (!graph || !canGroup) return
    const groupId = randomId()
    execute(createGroupCommand({ groupId, nodeIds: selectedIds }))
    select([groupId])
  }

  const ungroup = (): void => {
    if (!graph) return
    const freed: string[] = []
    for (const id of selectedIds) {
      const node = graph.nodes[id]
      if (!node) continue
      if (isAutoLayoutContainer(node)) {
        freed.push(...node.childIds)
        execute(createRemoveAutoLayoutCommand(id))
      } else if (node.type === 'group' || node.type === 'frame') {
        freed.push(...node.childIds)
        execute(createUngroupCommand(id))
      }
    }
    if (freed.length > 0) select(freed)
  }

  const wrapInAutoLayout = (): void => {
    if (!graph || selectedIds.length === 0) return
    const frameId = randomId()
    execute(createWrapInAutoLayoutCommand(graph, selectedIds, { frameId, name: '自动整理' }))
    select([frameId])
  }

  const removeAutoLayout = (): void => {
    if (!graph) return
    const freed: string[] = []
    for (const id of selectedIds) {
      const node = graph.nodes[id]
      if (!node || !isAutoLayoutContainer(node)) continue
      freed.push(...node.childIds)
      execute(createRemoveAutoLayoutCommand(id))
    }
    if (freed.length > 0) select(freed)
  }

  const reorder = (mode: ReorderMode): void => {
    if (selectedIds.length === 0) return
    execute(createReorderNodesCommand(selectedIds, mode))
  }

  const remove = (ids: string[] = selectedIds): void => {
    if (!graph || ids.length === 0) return
    execute(createDeleteNodesCommand(graph, ids))
    select([])
  }

  const rename = (id: string, name: string): void => {
    if (!graph) return
    const node = graph.nodes[id]
    const next = name.trim()
    if (node && next.length > 0 && next !== node.name) execute(createRenameNodeCommand(id, next))
  }

  const doPaste = (): void => {
    const ids = paste()
    if (ids && ids.length > 0) select(ids)
  }

  const doDuplicate = (): void => {
    const result = duplicate(selectedIds)
    if (result) select(result.ids)
  }

  const setSelectedFlags = (flags: { visible?: boolean; locked?: boolean }): void => {
    if (!graph) return
    for (const id of selectedIds) {
      if (graph.nodes[id]) execute(createSetNodeFlagsCommand(id, flags))
    }
  }

  /**
   * 拖拽落点。react-arborist 给的 `index` 是"还没移除被拖动行"的显示位置，
   * 先用它自带的 `adjustMoveIndex` 换成"移除之后"的插入位置，再翻成模型下标。
   */
  const onMove = ({
    dragIds,
    parentId,
    index
  }: {
    dragIds: string[]
    parentId: string | null
    index: number
  }): void => {
    if (!graph || dragIds.length === 0) return
    const siblings = displayChildIds(graph, parentId)
    const to = adjustMoveIndex({ index, dragIds, siblingIds: siblings })
    const count = siblings.filter((id) => !dragIds.includes(id)).length
    const base = displayToModelIndex(to, count)

    // 多个一起拖时按顺序依次插入（命令一次只搬一个）
    let at = base
    for (const id of dragIds) {
      execute(createMoveNodeCommand(id, parentId, at))
      at++
    }
  }

  const menuNode = menu && graph ? graph.nodes[menu.id] : null
  const selectedNodes = selectedIds.flatMap((id) => graph?.nodes[id] ?? [])
  const hasAutoLayout = selectedNodes.some(isAutoLayoutContainer)
  const shouldShow = selectedNodes.some((node) => !node.visible)
  const shouldUnlock = selectedNodes.some((node) => node.locked)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (selectedIds.length !== 1 || !matchesAccelerator(event, shortcuts.renameLayer)) return
      event.preventDefault()
      void treeRef.current?.edit(selectedIds[0]!)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedIds, shortcuts.renameLayer])

  return (
    <aside
      className={`layers${placement ? ` layers--${placement}` : ''}`}
      aria-label="图层"
      onMouseLeave={() => setHover(null)}
    >
      <div className="layers__header">
        <span className="layers__header-title">画布与图层</span>
        <button type="button" className="layers__header-close" aria-label="收起画布与图层" onClick={() => useUiStore.getState().toggleLayers()}>
          <img src={panelCloseIcon} alt="" />
        </button>
      </div>
      <div className="layers__divider" aria-hidden="true" />
      <CanvasSection />
      <div className="layers__divider" aria-hidden="true" />

      <div className="layers__tree" ref={listRef}>
        {data.length > 0 && size.height > 0 && (
          <Tree<LayerTreeNode>
            ref={treeRef}
            data={data}
            openByDefault
            width={size.width}
            height={size.height}
            indent={24}
            rowHeight={44}
            className="layers__tree-scroll"
            rowClassName="layers__tree-item"
            paddingTop={4}
            paddingBottom={4}
            onMove={onMove}
            onRename={({ id, name }) => rename(id, name)}
            onDelete={({ ids }) => remove(ids)}
            onSelect={(nodes: NodeApi<LayerTreeNode>[]) => select(nodes.map((node) => node.id))}
            disableDrop={({ parentNode }) => parentNode.isLeaf}
            dndRootElement={typeof document === 'undefined' ? null : document.body}
          >
            {(props) => (
              <LayerRow
                {...props}
                rowWidth={size.width}
                onHover={setHover}
                onContextMenu={(x, y) => {
                  if (!selectedSet.has(props.node.id)) select([props.node.id])
                  setMenu({ x, y, id: props.node.id })
                }}
              />
            )}
          </Tree>
        )}
        {data.length === 0 && <p className="layers__empty">画布还是空的，导入图片后这里会出现图层</p>}
      </div>

      {menu && menuNode && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '重命名', shortcut: formatAccelerator(shortcuts.renameLayer), onSelect: () => void treeRef.current?.edit(menu.id) },
            { label: '创建副本', shortcut: formatAccelerator(shortcuts.duplicate), onSelect: doDuplicate },
            { label: '复制', shortcut: formatAccelerator(shortcuts.copy), onSelect: () => copy(selectedIds) },
            { label: '粘贴', shortcut: formatAccelerator(shortcuts.paste), disabled: clipboardCount === 0, onSelect: doPaste },
            { divider: true },
            hasAutoLayout
              ? { label: '移除自动布局', shortcut: formatAccelerator(shortcuts.removeAutoLayout), onSelect: removeAutoLayout }
              : { label: '添加自动布局', shortcut: formatAccelerator(shortcuts.autoLayout), onSelect: wrapInAutoLayout },
            { label: '编组', shortcut: formatAccelerator(shortcuts.group), disabled: !canGroup, onSelect: group },
            { label: '解组', shortcut: formatAccelerator(shortcuts.ungroup), disabled: !canUngroup, onSelect: ungroup },
            { divider: true },
            { label: '上移一层', shortcut: formatAccelerator(shortcuts.layerForward), onSelect: () => reorder('forward') },
            { label: '下移一层', shortcut: formatAccelerator(shortcuts.layerBackward), onSelect: () => reorder('backward') },
            { label: '置于顶层', shortcut: formatAccelerator(shortcuts.layerFront), onSelect: () => reorder('front') },
            { label: '置于底层', shortcut: formatAccelerator(shortcuts.layerBack), onSelect: () => reorder('back') },
            { divider: true },
            {
              label: shouldUnlock ? '解锁' : '锁定',
              shortcut: formatAccelerator(shortcuts.toggleLayerLock),
              onSelect: () => setSelectedFlags({ locked: !shouldUnlock })
            },
            {
              label: shouldShow ? '显示' : '隐藏',
              shortcut: formatAccelerator(shortcuts.toggleLayerVisibility),
              onSelect: () => setSelectedFlags({ visible: shouldShow })
            },
            { divider: true },
            { label: '删除', shortcut: formatAccelerator(shortcuts.delete), danger: true, onSelect: () => remove(selectedIds) }
          ]}
        />
      )}
    </aside>
  )
}

function CanvasSection(): React.JSX.Element {
  const projects = useProjectStore((state) => state.projects)
  const currentId = useProjectStore((state) => state.currentId)
  const select = useProjectStore((state) => state.select)
  const create = useProjectStore((state) => state.create)
  const rename = useProjectStore((state) => state.rename)
  const remove = useProjectStore((state) => state.remove)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<(MenuState & { project: ProjectSummary }) | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)

  const createCanvas = async (): Promise<void> => {
    const usedNames = new Set(projects.map((project) => project.name))
    let index = 1
    while (usedNames.has(`画布${index}`)) index += 1
    const result = await create(`画布${index}`)
    if (!result.ok) setError(result.message)
    else setError(null)
  }

  const startRename = (project: ProjectSummary): void => {
    cancelled.current = false
    setMenu(null)
    setEditingId(project.id)
    setDraft(project.name)
    setError(null)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const result = await remove(deleteTarget.id)
    setDeleteTarget(null)
    setError(result.ok ? null : result.message)
  }

  const finishRename = async (project: ProjectSummary): Promise<void> => {
    if (editingId !== project.id) return
    const next = draft.trim()
    if (!next || next === project.name) {
      setEditingId(null)
      setDraft('')
      return
    }
    const result = await rename(project.id, next)
    if (result.ok) {
      setEditingId(null)
      setDraft('')
      setError(null)
    } else {
      setError(result.message)
    }
  }

  return (
    <section className="layers__canvas-section" aria-label="画布列表">
      <div className="layers__canvas-list" role="listbox" aria-label="画布">
          {projects.map((project) =>
            editingId === project.id ? (
              <input
                key={project.id}
                className="layers__canvas-rename"
                value={draft}
                aria-label={`重命名 ${project.name}`}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                  if (cancelled.current) {
                    cancelled.current = false
                    return
                  }
                  void finishRename(project)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void finishRename(project)
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelled.current = true
                    setEditingId(null)
                    setDraft('')
                    setError(null)
                  }
                }}
              />
            ) : (
              <button
                key={project.id}
                type="button"
                className="layers__canvas-row"
                role="option"
                aria-selected={project.id === currentId}
                onClick={() => select(project.id)}
                onDoubleClick={() => startRename(project)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ x: event.clientX, y: event.clientY, id: project.id, project })
                  setError(null)
                }}
              >
                <span>{project.name}</span>
              </button>
            )
          )}
          {projects.length === 0 && <p className="layers__canvas-empty">还没有画布</p>}
          <button type="button" className="layers__canvas-create" onClick={() => void createCanvas()}>
            <span>新画布</span><img src={panelPlusIcon} alt="" />
          </button>
      </div>

      {error && <p className="layers__canvas-error">{error}</p>}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '重命名', onSelect: () => startRename(menu.project) },
            {
              label: '删除画布',
              onSelect: () => setDeleteTarget(menu.project)
            }
          ]}
        />
      )}

      {deleteTarget && (
        <div className="project-confirm-backdrop" role="presentation">
          <section
            className="project-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-canvas-title"
          >
            <h2 id="delete-canvas-title">删除画布？</h2>
            <p>“{deleteTarget.name}”中的内容将一起删除，且无法恢复。</p>
            <div className="project-confirm__actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="project-confirm__delete" onClick={() => void confirmDelete()}>
                删除
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

interface LayerRowProps extends NodeRendererProps<LayerTreeNode> {
  /** 行宽固定到画布标题内容区的右边线；不显式给宽时，长名称会撑出面板。 */
  rowWidth: number
  onHover: (id: string | null) => void
  onContextMenu: (x: number, y: number) => void
}

function LayerRow({
  node,
  style,
  dragHandle,
  rowWidth,
  onHover,
  onContextMenu
}: LayerRowProps): React.JSX.Element {
  const [draft, setDraft] = useState(node.data.name)
  // Escape 会先 reset() 再触发 blur，用一个标记避免 blur 又把改动提交回去
  const cancelled = useRef(false)

  useEffect(() => {
    if (node.isEditing) {
      cancelled.current = false
      setDraft(node.data.name)
    }
  }, [node.isEditing, node.data.name])

  return (
    <div
      ref={dragHandle}
      style={{ ...(style as CSSProperties), width: rowWidth }}
      className="layers__row-slot"
      title={`${node.data.kindLabel} · ${node.data.displayName}`}
      data-drop={node.willReceiveDrop}
      data-dragging={node.isDragging}
      onMouseEnter={() => onHover(node.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(event.clientX, event.clientY)
      }}
    >
      <div
        className="layers__row"
        data-selected={node.isSelected}
        data-open={node.isInternal && node.isOpen}
        data-nested={node.level > 0}
      >
        {node.isEditing ? (
          <input
            className="layers__rename"
            value={draft}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (cancelled.current) node.reset()
              else node.submit(draft)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') node.submit(draft)
              if (event.key === 'Escape') {
                cancelled.current = true
                node.reset()
              }
            }}
          />
        ) : (
          <LayerKindIcon kind={node.data.kind} />
        )}
        {!node.isEditing && (
          <span className="layers__label">
            <span
              className="layers__name"
              data-hidden={!node.data.visible}
              onDoubleClick={(event) => {
                event.stopPropagation()
                void node.edit()
              }}
            >
              {node.data.displayName}
            </span>

            {node.isInternal && (
              <button
                type="button"
                className="layers__arrow"
                aria-label={node.isOpen ? '收起' : '展开'}
                data-open={node.isOpen}
                onClick={(event) => {
                  event.stopPropagation()
                  node.toggle()
                }}
              >
                <img src={chevronIcon} alt="" />
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

function LayerKindIcon({ kind }: { kind: LayerTreeNode['kind'] }): React.JSX.Element {
  if (kind === 'image') return <Gallery2 className="layers__kind-icon" size={16} weight="Outline" />
  const icons: Record<LayerTreeNode['kind'], string> = {
    image: '',
    group: groupIcon,
    frame: autoLayoutIcon,
    text: textIcon,
    rectangle: rectangleIcon,
    ellipse: ellipseIcon,
    line: lineIcon
  }
  return <img className="layers__kind-icon" src={icons[kind]} alt="" aria-hidden="true" />
}

