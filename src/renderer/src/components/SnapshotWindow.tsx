import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Lock, LockKeyholeOpen, X } from 'reicon-react'
import { snapshotLayerGeometry, type SnapshotPatch, type SnapshotView } from '../../../shared/snapshot'
import { needsOriginal } from '../canvas/image-lod'

/**
 * 参考快照浮窗的内容（路线图 D5.1–D5.7）。
 *
 * 做四件事：
 *   1. 把冻结下来的那些盒子画出来（图片走 `ins-pin-asset:` 协议），**背景保持透明**，
 *      透明底 PNG 原样透出去，不会垫一层白；
 *   2. 鼠标移上来，右上角浮出「锁定/解锁」和「关闭」两颗按钮——不靠程序坞也能收掉它；
 *   3. 按住图面拖动——**窗口位置由主进程挪**，这里只报"指针在屏幕的哪儿"。
 *      不用 `-webkit-app-region: drag` 是因为那块区域收不到右键事件，而右键是操作入口；
 *   4. 右键打开一扇独立、固定尺寸的设置菜单，里面放透明度、缩放、锁定、刷新与关闭。
 *
 * 素材文件不在时（D5.6）画一个可理解的占位块，而不是空白或红叉。
 */
export default function SnapshotWindow(): React.JSX.Element {
  const [view, setView] = useState<SnapshotView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 指针在不在浮窗上——在就浮出右上角那排按钮 */
  const [hovering, setHovering] = useState(false)
  const dragging = useRef(false)
  /** 指针是否正压在那排按钮上（只在变化时告诉主进程，别每帧发） */
  const overControls = useRef(false)
  const controlsRef = useRef<HTMLDivElement | null>(null)
  const api = window.insPin?.snapshotWindow ?? null

  useEffect(() => {
    if (!api) {
      setNotice('快照没能加载上，请按 ⌘Q 退出 InsPin 后重新打开')
      return
    }
    let alive = true
    void api.get().then((next) => {
      if (alive) setView(next)
    })
    // 刷新完、程序坞切了穿透，主进程都会推过来
    const offChanged = api.onChanged((next) => setView(next))
    // 刷新成没成（刷新入口在右键菜单里，结果只能从主进程推回来）
    const offNotice = api.onNotice((message) => setNotice(message))
    return () => {
      alive = false
      offChanged()
      offNotice()
    }
  }, [api])

  const patch = (next: SnapshotPatch): void => {
    void api?.update(next).then((updated) => {
      if (updated) setView(updated)
    })
  }

  // 刷新成功只需要确认一下即可，1 秒后自动让出画面；失败提示仍留给用户手动查看。
  useEffect(() => {
    if (notice !== '已刷新') return
    const timer = window.setTimeout(() => setNotice(null), 1000)
    return () => window.clearTimeout(timer)
  }, [notice])

  /** 指针落到那排按钮上了吗（留一点余量，贴着边也算）。 */
  const isOverControls = (x: number, y: number): boolean => {
    const rect = controlsRef.current?.getBoundingClientRect()
    if (!rect) return false
    const pad = 4
    return (
      x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad
    )
  }

  const syncControlsHover = (inside: boolean): void => {
    if (overControls.current === inside) return
    overControls.current = inside
    // 穿透开着时，主进程据此临时放行鼠标，按钮才点得着
    api?.hoverControls(inside)
  }

  // 指针离开浮窗（或窗口失焦）时把状态收干净，免得按钮一直挂着、鼠标也一直被放行
  useEffect(() => {
    const stop = (): void => {
      setHovering(false)
      syncControlsHover(false)
      if (dragging.current) {
        dragging.current = false
        api?.drag({ phase: 'end' })
      }
    }
    window.addEventListener('blur', stop)
    return () => window.removeEventListener('blur', stop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !api) return
    if (view?.locked) return
    // 点在控件上不是"拖窗口"
    if ((event.target as HTMLElement).closest('.snap__controls')) return
    dragging.current = true
    api.drag({ phase: 'start', offsetX: event.clientX, offsetY: event.clientY })
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    setHovering(true)
    syncControlsHover(isOverControls(event.clientX, event.clientY))
    if (!dragging.current) return
    api?.drag({ phase: 'move', screenX: event.screenX, screenY: event.screenY })
  }

  function onPointerLeave(): void {
    setHovering(false)
    syncControlsHover(false)
    if (!dragging.current) return
    dragging.current = false
    api?.drag({ phase: 'end' })
  }

  const zoom = view?.zoom ?? 1
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)

  return (
    <div
      className="snap"
      data-locked={view?.locked ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        if (!dragging.current) return
        dragging.current = false
        api?.drag({ phase: 'end' })
      }}
      onPointerCancel={onPointerLeave}
      onPointerLeave={onPointerLeave}
      onContextMenu={(event) => {
        event.preventDefault()
        // 锁定（= 鼠标穿透）时事件根本到不了这里，不用额外判断。
        // 菜单是另一扇固定尺寸的浮窗，不会被图片缩放拖着变形。
        if (view) api?.menu()
      }}
    >
      <div className="snap__content">
        {view?.content.layers.map((layer) => {
          // 组 / 框架本身没有画面，它们只是容器；子节点各自是一层
          if (layer.kind !== 'asset' || !layer.assetId) return null

          const geometry = snapshotLayerGeometry(layer, zoom)
          const outerStyle: CSSProperties = {
            left: geometry.outer.left,
            top: geometry.outer.top,
            width: geometry.outer.width,
            height: geometry.outer.height
          }
          if (layer.rotation) outerStyle.transform = `rotate(${layer.rotation}deg)`

          const info = view.content.assets[layer.assetId]
          if (view.content.missing.includes(layer.assetId) || !info) {
            return (
              <div key={layer.nodeId} className="snap__missing" style={outerStyle} title={layer.name}>
                图找不到了
              </div>
            )
          }
          // 浮窗通常只有几百像素宽：图在屏幕上撑不满缩略图分辨率时就不解码原图，
          // 一屏钉子图因此不用各自扛一份大位图（放大到需要时下个渲染就换回原图）。
          const src = needsOriginal(layer, geometry.crop, zoom, pixelRatio)
            ? api?.assetUrl(info.fileName)
            : api?.thumbUrl(info.fileName)
          return (
            <div key={layer.nodeId} className="snap__layer" style={outerStyle}>
              <img
                className="snap__img"
                style={geometry.image}
                src={src}
                alt={layer.name}
                draggable={false}
                decoding="async"
              />
            </div>
          )
        })}
      </div>

      {/* 右上角控制区：鼠标移上来才浮出。穿透开着时也点得着——指针压过来，
          主进程会把穿透临时关掉（见 SnapshotManager.hoverControls） */}
      <div className="snap__controls" data-visible={hovering} ref={controlsRef}>
        <button
          type="button"
          className="snap__ctrl"
          title={view?.locked ? '解锁位置' : '锁定位置'}
          aria-label={view?.locked ? '解锁位置' : '锁定位置'}
          onClick={() => patch({ locked: !view?.locked })}
        >
          {view?.locked ? <LockKeyholeOpen size={16} /> : <Lock size={16} />}
        </button>
        <button
          type="button"
          className="snap__ctrl snap__ctrl--close"
          title="取消钉住"
          aria-label="取消钉住"
          onClick={() => void api?.close()}
        >
          <X size={16} />
        </button>
      </div>

      {view && view.content.layers.length === 0 && <p className="snap__empty">这一条快照没有内容</p>}

      {notice && (
        <button type="button" className="snap__notice" onClick={() => setNotice(null)}>
          {notice}
        </button>
      )}
    </div>
  )
}
