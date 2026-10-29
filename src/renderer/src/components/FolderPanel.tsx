import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Folder, Grid, HandStars, List, Plus, Refresh, Stars, Trash, Trash2, X } from 'reicon-react'
import pinIcon from '../assets/icons/relay-pin.svg'
import finderIcon from '../assets/icons/relay-finder.svg'
import trashIcon from '../assets/icons/relay-trash.svg'
import {
  LIBRARY_DRAG_MIME,
  type LibraryDragItem,
  type LinkedFolderAsset,
  type ManagedLibraryAsset
} from '../../../shared/local-library'
import { matchesAccelerator } from '../../../shared/shortcuts'
import { formatBytes } from '../asset-format'
import { canvasBridge, localLibraryBridge } from '../bridge'
import { useUiStore } from '../state/ui'
import { toast, type ToastNotice } from '../toast'
import MaskIcon from './MaskIcon'
import Toast from './Toast'

type ActiveSource = 'managed' | 'trash' | string
type LibraryItem = ManagedLibraryAsset | LinkedFolderAsset

interface MarqueeBox {
  left: number
  top: number
  width: number
  height: number
}

function kindLabel(mime: string): string {
  const subtype = mime.split('/')[1]?.toUpperCase()
  return subtype ? `${subtype} 图像` : '图像'
}

function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const today = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (date.toDateString() === today.toDateString()) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function itemDate(item: LibraryItem): string {
  return item.kind === 'managed' ? item.createdAt : item.modifiedAt
}

function itemUrl(item: LibraryItem): string {
  if (item.kind === 'managed') return canvasBridge()?.thumbUrl(item.fileName) ?? ''
  return localLibraryBridge()?.linkedThumbUrl(item.folderId, item.relativePath) ?? ''
}

function itemKey(item: LibraryItem): string {
  return item.kind === 'managed' ? `managed:${item.id}` : `linked:${item.folderId}:${item.relativePath}`
}

function toDragItem(item: LibraryItem): LibraryDragItem {
  return item.kind === 'managed'
    ? { kind: 'managed', assetId: item.id }
    : { kind: 'linked', folderId: item.folderId, relativePath: item.relativePath }
}

/**
 * 网格一次只挂载一小段。几千张缩略图同时建 DOM 会明显拖慢滚动，
 * 滚到底部附近再继续追加（图片本身也交给浏览器懒加载）。
 */
const PAGE_SIZE = 160

export default function FolderPanel(): React.JSX.Element {
  const open = useUiStore((state) => state.folderPanelOpen)
  const panel = useUiStore((state) => state.panel)
  const shortcuts = useUiStore((state) => state.shortcuts)
  const [active, setActive] = useState<ActiveSource>('managed')
  const view = useUiStore((state) => state.libraryView)
  const setView = useUiStore((state) => state.setLibraryView)
  const [state, setState] = useState<Awaited<ReturnType<NonNullable<ReturnType<typeof localLibraryBridge>>['getState']>> | null>(null)
  const [linkedItems, setLinkedItems] = useState<LinkedFolderAsset[]>([])
  const [linkedTruncated, setLinkedTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<string | null>(null)
  const marqueeCleanupRef = useRef<(() => void) | null>(null)

  const reload = async (): Promise<void> => {
    const api = localLibraryBridge()
    if (!api) return
    setLoading(true)
    try {
      setState(await api.getState())
    } catch {
      setNotice(toast('error', '素材库暂时无法读取', { dismissible: true }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void reload()
  }, [open])

  // 原图在 Finder 里被删后，主进程会顺手清掉素材记录；面板开着就立刻跟着刷新，
  // 别让缓存的缩略图继续顶着一张已经不存在的图。
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    const api = canvasBridge()
    if (!api || typeof api.onAssetsPruned !== 'function') return
    return api.onAssetsPruned(() => {
      if (useUiStore.getState().folderPanelOpen) void reloadRef.current()
    })
  }, [])

  useEffect(() => {
    if (active === 'managed' || active === 'trash') {
      setLinkedItems([])
      setLinkedTruncated(false)
      return
    }
    const api = localLibraryBridge()
    if (!api) return
    let live = true
    setLoading(true)
    void api
      .listFolder(active)
      .then((result) => {
        if (!live) return
        if (result.ok) {
          setLinkedItems(result.value.items)
          setLinkedTruncated(result.value.truncated)
        } else {
          setLinkedItems([])
          setLinkedTruncated(false)
          setNotice(toast('error', result.message, { dismissible: true }))
        }
      })
      .catch(() => {
        if (!live) return
        setLinkedItems([])
        setLinkedTruncated(false)
        setNotice(toast('error', '无法读取这个文件夹', { dismissible: true }))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => { live = false }
  }, [active])

  const folders = state?.folders ?? []
  const activeFolder = folders.find((folder) => folder.id === active) ?? null
  const items = useMemo<LibraryItem[]>(() => {
    if (!state) return []
    if (active === 'managed') return state.managed
    if (active === 'trash') return state.trash
    return linkedItems
  }, [active, linkedItems, state])
  const visibleItems = items.slice(0, visibleCount)

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    setSelected(new Set())
    anchorRef.current = null
  }, [active])

  // 删除、还原、刷新之后，把已经不存在的 key 从选中集合里剔掉。
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current
      const keys = new Set(items.map(itemKey))
      let changed = false
      const next = new Set<string>()
      for (const key of current) {
        if (keys.has(key)) next.add(key)
        else changed = true
      }
      return changed ? next : current
    })
  }, [items])

  useEffect(() => () => marqueeCleanupRef.current?.(), [])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || visibleCount >= items.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, items.length))
        }
      },
      // 提前一屏开始追加，滚动时不容易看到空白
      { rootMargin: '600px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [items.length, visibleCount])

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(itemKey(item))),
    [items, selected]
  )
  const managedSelected = useMemo(
    () => selectedItems.filter((item): item is ManagedLibraryAsset => item.kind === 'managed'),
    [selectedItems]
  )

  const addFolder = async (): Promise<void> => {
    const api = localLibraryBridge()
    if (!api) return
    const result = await api.linkFolder()
    if (!result.ok) {
      if (!result.canceled) setNotice(toast('error', result.message, { dismissible: true }))
      return
    }
    await reload()
    setActive(result.value.id)
    setNotice(toast('success', `已连接“${result.value.name}”`))
  }

  const removeFolder = async (id: string): Promise<void> => {
    const folder = folders.find((item) => item.id === id)
    if (!(await localLibraryBridge()?.unlinkFolder(id))) return
    if (active === id) setActive('managed')
    await reload()
    setNotice(toast('info', `已移除“${folder?.name ?? '文件夹'}”链接，Finder 文件没有变化`))
  }

  const restore = async (assetIds: string[]): Promise<void> => {
    if (busy || assetIds.length === 0) return
    const api = localLibraryBridge()
    if (!api) return
    setBusy(true)
    try {
      const restored = await api.restoreAssets(assetIds)
      await reload()
      setSelected(new Set())
      if (restored > 0) {
        setNotice(toast('success', `已还原 ${restored} 张到 inspin素材；3 天内未使用会再次进入回收站`))
      } else {
        setNotice(toast('error', '素材还原失败', { dismissible: true }))
      }
    } finally {
      setBusy(false)
    }
  }

  const trashSelection = async (): Promise<void> => {
    if (busy) return
    const ids = managedSelected.map((item) => item.id)
    if (ids.length === 0) {
      setNotice(toast('info', '这个文件夹里的原图由 Finder 管理；要删除请到 Finder 操作'))
      return
    }
    const api = localLibraryBridge()
    if (!api) return
    setBusy(true)
    try {
      const result = await api.trashAssets(ids)
      await reload()
      setSelected(new Set())
      if (result.trashed > 0) {
        setNotice(
          toast(
            'success',
            result.blocked > 0
              ? `已移入回收站 ${result.trashed} 张；${result.blocked} 张还在画布上使用`
              : `已移入回收站 ${result.trashed} 张`
          )
        )
      } else {
        setNotice(toast('info', '这些素材还在画布或参考快照里使用，先从画布移开再删除'))
      }
    } finally {
      setBusy(false)
    }
  }

  const revealSelection = async (): Promise<void> => {
    const first = selectedItems[0]
    if (!first) return
    const ok =
      first.kind === 'managed'
        ? await (canvasBridge()?.revealAsset(first.fileName) ?? false)
        : await (localLibraryBridge()?.revealLinkedAsset(first.folderId, first.relativePath) ?? false)
    if (!ok) setNotice(toast('error', '没有找到这张原图，可能已被移动或删除', { dismissible: true }))
  }

  const selectOnly = (key: string, additive: boolean): void => {
    anchorRef.current = key
    if (!additive) {
      setSelected(new Set([key]))
      return
    }
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectRange = (key: string): void => {
    const to = items.findIndex((item) => itemKey(item) === key)
    const from = anchorRef.current
      ? items.findIndex((item) => itemKey(item) === anchorRef.current)
      : -1
    if (from < 0 || to < 0) {
      anchorRef.current = key
      setSelected(new Set([key]))
      return
    }
    const [start, end] = from <= to ? [from, to] : [to, from]
    const next = new Set<string>()
    for (let index = start; index <= end; index += 1) {
      const item = items[index]
      if (item) next.add(itemKey(item))
    }
    setSelected(next)
  }

  const onClickItem = (event: MouseEvent, item: LibraryItem): void => {
    const key = itemKey(item)
    if (event.metaKey || event.ctrlKey) {
      selectOnly(key, true)
      return
    }
    if (event.shiftKey) {
      selectRange(key)
      return
    }
    anchorRef.current = key
    setSelected(new Set([key]))
  }

  const onDragStartItem = (event: DragEvent, item: LibraryItem): void => {
    const key = itemKey(item)
    let current = selected
    if (!current.has(key)) {
      current = new Set([key])
      anchorRef.current = key
      setSelected(current)
    }
    const chosen = items.filter((entry) => current.has(itemKey(entry)))
    const dragItems = (chosen.length > 0 ? chosen : [item]).map(toDragItem)
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(LIBRARY_DRAG_MIME, JSON.stringify({ items: dragItems }))
    event.dataTransfer.setData('text/plain', dragItems.length > 1 ? `${dragItems.length} 张素材` : item.name)
  }

  const onMarqueeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as Element
    if (target.closest('.folder-asset-card, .folder-list__row, .folder-list__header, button')) return
    const content = contentRef.current
    if (!content) return

    panelRef.current?.focus({ preventScroll: true })
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    const base = additive ? new Set(selected) : new Set<string>()
    if (!additive) setSelected(new Set())

    const contentRect = content.getBoundingClientRect()
    const origin = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: event.clientX - contentRect.left + content.scrollLeft,
      startTop: event.clientY - contentRect.top + content.scrollTop,
      base,
      moved: false
    }
    let latest = { x: event.clientX, y: event.clientY }
    let frame = 0

    const apply = (): void => {
      frame = 0
      const rect = content.getBoundingClientRect()
      const localX = latest.x - rect.left + content.scrollLeft
      const localY = latest.y - rect.top + content.scrollTop
      const left = Math.min(origin.startLeft, localX)
      const top = Math.min(origin.startTop, localY)
      const width = Math.abs(localX - origin.startLeft)
      const height = Math.abs(localY - origin.startTop)
      setMarquee({ left, top, width, height })

      const clientLeft = rect.left - content.scrollLeft + left
      const clientTop = rect.top - content.scrollTop + top
      const clientRight = clientLeft + width
      const clientBottom = clientTop + height
      const hits = new Set(origin.base)
      for (const element of content.querySelectorAll<HTMLElement>('[data-library-key]')) {
        const box = element.getBoundingClientRect()
        if (box.left < clientRight && box.right > clientLeft && box.top < clientBottom && box.bottom > clientTop) {
          const key = element.dataset.libraryKey
          if (key) hits.add(key)
        }
      }
      setSelected(hits)
    }

    const onMove = (moveEvent: PointerEvent): void => {
      latest = { x: moveEvent.clientX, y: moveEvent.clientY }
      if (!origin.moved && Math.hypot(moveEvent.clientX - origin.startX, moveEvent.clientY - origin.startY) < 3) return
      if (!origin.moved) {
        origin.moved = true
        content.classList.add('is-selecting')
      }
      if (!frame) frame = requestAnimationFrame(apply)
    }

    const finish = (clientX?: number, clientY?: number): void => {
      if (clientX !== undefined && clientY !== undefined) latest = { x: clientX, y: clientY }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (frame) cancelAnimationFrame(frame)
      if (origin.moved) apply()
      content.classList.remove('is-selecting')
      setMarquee(null)
      marqueeCleanupRef.current = null
    }

    const onUp = (upEvent: PointerEvent): void => finish(upEvent.clientX, upEvent.clientY)
    const onCancel = (): void => finish()

    marqueeCleanupRef.current = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Escape') {
      if (selected.size === 0) return
      event.preventDefault()
      event.stopPropagation()
      setSelected(new Set())
      return
    }
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      event.stopPropagation()
      setSelected(new Set(items.map(itemKey)))
      return
    }
    if (matchesAccelerator(event, shortcuts.delete) || event.key === 'Delete') {
      if (selected.size === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (active === 'trash') {
        setNotice(toast('info', '回收站里的素材会在 30 天后自动清理；要找回请点“还原”'))
      } else {
        void trashSelection()
      }
    }
  }

  return (
    <aside
      ref={panelRef}
      className="folder-panel"
      data-open={open}
      aria-label="本地素材"
      aria-hidden={!open}
      tabIndex={-1}
      style={{ '--panel-w': `${panel.openWidth}px` } as CSSProperties}
      onPointerDown={() => panelRef.current?.focus({ preventScroll: true })}
      onKeyDown={onKeyDown}
    >
      <div className="folder-panel__content" ref={contentRef} onPointerDown={onMarqueeStart}>
        <div className="folder-panel__mark" aria-hidden="true"><Stars size={24} /></div>
        {loading && items.length === 0 ? (
          <EmptyState loading />
        ) : activeFolder && !activeFolder.available ? (
          <EmptyState icon={<Folder size={52} />} title="文件夹不可用" message="文件夹可能被移动、改名或所在磁盘未连接" action={<button type="button" className="folder-panel__empty-action" onClick={() => void addFolder()}>重新连接</button>} />
        ) : items.length === 0 ? (
          active === 'trash' ? (
            <EmptyState icon={<Trash size={56} color="var(--library-danger)" />} title="回收站" message="从画布移除且连续 3 天未使用的素材会在此保留 30 天" />
          ) : active === 'managed' ? (
            <EmptyState icon={<HandStars size={72} />} title="inspin素材" message="你采集的灵感素材会保存在这里" />
          ) : (
            <EmptyState icon={<Folder size={52} />} title="文件夹为空" message="这里还没有可浏览的图片素材" />
          )
        ) : view === 'grid' ? (
          <>
            <div
              className="folder-assets folder-assets--grid"
              role="listbox"
              aria-label="素材列表"
              aria-multiselectable="true"
            >
              {linkedTruncated && <div className="folder-assets__limit" role="status">图片较多，这里只显示最近的一部分</div>}
              {visibleItems.map((item) => {
                const key = itemKey(item)
                return (
                  <AssetCard
                    key={key}
                    item={item}
                    trash={active === 'trash'}
                    selected={selected.has(key)}
                    onSelect={(event) => onClickItem(event, item)}
                    onDragStart={(event) => onDragStartItem(event, item)}
                    onRestore={
                      item.kind === 'managed'
                        ? (event) => {
                            event.stopPropagation()
                            void restore([item.id])
                          }
                        : undefined
                    }
                    onFocusPanel={() => panelRef.current?.focus({ preventScroll: true })}
                  />
                )
              })}
            </div>
            {visibleCount < items.length && <div ref={sentinelRef} className="folder-assets__sentinel" aria-hidden="true" />}
          </>
        ) : (
          <>
            <div className="folder-assets folder-assets--list" role="table" aria-label="素材列表">
              {linkedTruncated && <div className="folder-assets__limit" role="status">图片较多，这里只显示最近的一部分</div>}
              <div className="folder-list__header" role="row"><span>名称</span><span>尺寸</span><span>大小</span><span>修改日期</span><span>类型</span></div>
              {visibleItems.map((item) => {
                const key = itemKey(item)
                return (
                  <AssetRow
                    key={key}
                    item={item}
                    trash={active === 'trash'}
                    selected={selected.has(key)}
                    onSelect={(event) => onClickItem(event, item)}
                    onDragStart={(event) => onDragStartItem(event, item)}
                    onRestore={
                      item.kind === 'managed'
                        ? (event) => {
                            event.stopPropagation()
                            void restore([item.id])
                          }
                        : undefined
                    }
                    onFocusPanel={() => panelRef.current?.focus({ preventScroll: true })}
                  />
                )
              })}
            </div>
            {visibleCount < items.length && <div ref={sentinelRef} className="folder-assets__sentinel" aria-hidden="true" />}
          </>
        )}
        {marquee && (
          <div
            className="folder-marquee"
            aria-hidden="true"
            style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
          />
        )}
      </div>

      {selected.size > 0 && (
        <div className="folder-selection-bar" role="status">
          <span className="folder-selection-bar__count">已选 {selected.size}</span>
          <span className="folder-selection-bar__divider" aria-hidden="true" />
          <div className="folder-selection-bar__actions">
            <button
              type="button"
              className="folder-selection-bar__action"
              title="在 Finder 中显示（多选时只定位第一张）"
              disabled={busy}
              onClick={() => void revealSelection()}
            >
              <MaskIcon className="folder-selection-bar__icon" src={finderIcon} />
              <span>打开Finder</span>
            </button>
            {active === 'trash' ? (
              <button
                type="button"
                className="folder-selection-bar__action folder-selection-bar__action--primary"
                disabled={busy}
                onClick={() => void restore(managedSelected.map((item) => item.id))}
              >
                <Refresh size={16} />
                <span>还原</span>
              </button>
            ) : managedSelected.length > 0 ? (
              <button
                type="button"
                className="folder-selection-bar__action folder-selection-bar__action--danger"
                disabled={busy}
                onClick={() => void trashSelection()}
              >
                <MaskIcon className="folder-selection-bar__icon" src={trashIcon} />
                <span>删除</span>
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="folder-panel__bottom">
        <div className="folder-panel__tabs browser__tabs" role="tablist" aria-label="素材来源">
          <div className="browser__tab" data-active={active === 'managed'} role="tab" aria-selected={active === 'managed'} onClick={() => setActive('managed')}>
            <span className="browser__tab-content"><img className="folder-tab-pin" src={pinIcon} alt="" /><span className="browser__tab-title">inspin素材</span></span>
          </div>
          {folders.map((folder) => (
            <div key={folder.id} className="browser__tab" data-active={active === folder.id} role="tab" aria-selected={active === folder.id} onClick={() => setActive(folder.id)} title={folder.available ? folder.name : `${folder.name}（不可用）`}>
              <span className="browser__tab-content"><Folder size={16} /><span className="browser__tab-title">{folder.name}</span><button type="button" className="browser__tab-close" aria-label={`移除 ${folder.name}`} onClick={(event) => { event.stopPropagation(); void removeFolder(folder.id) }}><X size={14} /></button></span>
            </div>
          ))}
          <button type="button" className="browser__newtab" aria-label="连接本地文件夹" onClick={() => void addFolder()}><Plus size={18} /></button>
        </div>

        <div className="folder-panel__actions">
          <button type="button" className="folder-panel__action" aria-label={view === 'grid' ? '切换到列表视图' : '切换到大图视图'} title={view === 'grid' ? '列表视图' : '大图视图'} onClick={() => setView(view === 'grid' ? 'list' : 'grid')}>{view === 'grid' ? <List size={24} /> : <Grid size={24} />}</button>
          <button type="button" className="folder-panel__action folder-panel__action--trash" data-active={active === 'trash'} aria-label="回收站" title="回收站" onClick={() => setActive(active === 'trash' ? 'managed' : 'trash')}><Trash2 size={24} weight="Outline" /></button>
        </div>
      </div>
      {notice && <Toast notice={notice} onDismiss={() => setNotice(null)} />}
    </aside>
  )
}

interface AssetProps {
  item: LibraryItem
  trash: boolean
  selected: boolean
  onSelect: (event: MouseEvent) => void
  onDragStart: (event: DragEvent) => void
  onRestore?: (event: MouseEvent) => void
  onFocusPanel: () => void
}

function AssetCard({ item, trash, selected, onSelect, onDragStart, onRestore, onFocusPanel }: AssetProps): React.JSX.Element {
  return (
    <article
      className="folder-asset-card"
      data-library-key={itemKey(item)}
      data-selected={selected}
      data-draggable={!trash}
      aria-selected={selected}
      role="option"
      draggable={!trash}
      onPointerDown={onFocusPanel}
      onClick={onSelect}
      onDragStart={onDragStart}
      title={item.name}
    >
      <img src={itemUrl(item)} alt="" draggable={false} loading="lazy" decoding="async" />
      {selected && (
        <svg className="folder-asset-card__check" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="8" />
          <path d="M4.6 8.3 6.9 10.6 11.3 6.1" />
        </svg>
      )}
      {trash && item.kind === 'managed' && (
        <button type="button" className="folder-asset-card__restore" aria-label={`还原 ${item.name}`} title="还原到 inspin素材" onClick={onRestore}><Refresh size={20} /></button>
      )}
    </article>
  )
}

function AssetRow({ item, trash, selected, onSelect, onDragStart, onRestore, onFocusPanel }: AssetProps): React.JSX.Element {
  const dimensions = item.kind === 'managed' && item.width && item.height ? `${item.width}×${item.height}` : '—'
  return (
    <div
      className="folder-list__row"
      role="row"
      data-library-key={itemKey(item)}
      data-selected={selected}
      data-draggable={!trash}
      aria-selected={selected}
      draggable={!trash}
      onPointerDown={onFocusPanel}
      onClick={onSelect}
      onDragStart={onDragStart}
    >
      <span className="folder-list__name"><img src={itemUrl(item)} alt="" draggable={false} loading="lazy" decoding="async" /><span title={item.name}>{item.name}</span></span>
      <span>{dimensions}</span><span>{formatBytes(item.bytes)}</span><span>{shortDate(itemDate(item))}</span>
      <span className="folder-list__kind">{kindLabel(item.mime)}{trash && item.kind === 'managed' && <button type="button" aria-label={`还原 ${item.name}`} onClick={onRestore}><Refresh size={16} /></button>}</span>
    </div>
  )
}

function EmptyState({ loading = false, icon, title, message, action }: { loading?: boolean; icon?: React.ReactNode; title?: string; message?: string; action?: React.ReactNode }): React.JSX.Element {
  return <div className="folder-panel__empty"><div className="folder-panel__empty-icon">{loading ? <Refresh className="folder-panel__loading" size={44} /> : icon}</div><strong>{loading ? '正在读取素材' : title}</strong><span>{loading ? '请稍候' : message}</span>{action}</div>
}
