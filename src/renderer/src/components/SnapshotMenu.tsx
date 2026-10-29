import { useEffect, useRef, useState } from 'react'
import {
  SNAPSHOT_MAX_OPACITY,
  SNAPSHOT_MAX_ZOOM,
  SNAPSHOT_MIN_OPACITY,
  SNAPSHOT_MIN_ZOOM,
  type SnapshotPatch,
  type SnapshotView
} from '../../../shared/snapshot'

/**
 * 钉住图的右键设置菜单（设计规范 2.3.9 / 42:2953）。
 *
 * 它故意是一扇独立、固定尺寸的小窗口：缩放钉住图时，这里的滑杆不能跟着位移或
 * 改宽，否则指针还在拖，滑块已经换了坐标，数值会直接跳到最小的 25%。
 */
export default function SnapshotMenu(): React.JSX.Element {
  const [view, setView] = useState<SnapshotView | null>(null)
  const pendingPatch = useRef<SnapshotPatch | null>(null)
  const patchFrame = useRef<number | null>(null)
  const sequence = useRef(0)
  const api = window.insPin?.snapshotWindow ?? null

  useEffect(() => {
    let alive = true
    void api?.get().then((next) => {
      if (alive) setView(next)
    })
    const offChanged = api?.onChanged(setView) ?? (() => undefined)
    return () => {
      alive = false
      offChanged()
    }
  }, [api])

  useEffect(
    () => () => {
      if (patchFrame.current !== null) window.cancelAnimationFrame(patchFrame.current)
    },
    []
  )

  const patch = (next: SnapshotPatch): void => {
    // 本地值立即跟手；一帧内只提交最终值，过期回包不能倒灌旧比例。
    setView((current) => (current ? { ...current, ...next } : current))
    pendingPatch.current = { ...pendingPatch.current, ...next }
    if (patchFrame.current !== null) return
    patchFrame.current = window.requestAnimationFrame(() => {
      patchFrame.current = null
      const update = pendingPatch.current
      pendingPatch.current = null
      if (!update) return
      const id = ++sequence.current
      void api?.update(update).then((updated) => {
        if (updated && id === sequence.current && pendingPatch.current === null) setView(updated)
      })
    })
  }

  const opacityPercent = Math.round((view?.opacity ?? 1) * 100)
  const zoomPercent = Math.round((view?.zoom ?? 1) * 100)
  const track = (percent: number, min: number, max: number): string => {
    const progress = `${Math.max(0, Math.min(100, ((percent - min) / (max - min)) * 100))}%`
    return `linear-gradient(to right, #6D54EB ${progress}, #F1F1F1 ${progress})`
  }

  return (
    <main className="snapshot-menu" onContextMenu={(event) => event.preventDefault()}>
      <div className="snapshot-menu__controls">
        <label className="snapshot-menu__control">
          <span>透明</span>
          <input
            type="range"
            min={SNAPSHOT_MIN_OPACITY * 100}
            max={SNAPSHOT_MAX_OPACITY * 100}
            step="1"
            value={opacityPercent}
            aria-label={`透明度：${opacityPercent}%`}
            style={{ background: track(opacityPercent, SNAPSHOT_MIN_OPACITY * 100, SNAPSHOT_MAX_OPACITY * 100) }}
            onChange={(event) => patch({ opacity: Number(event.target.value) / 100 })}
          />
        </label>

        <label className="snapshot-menu__control">
          <span>缩放</span>
          <input
            type="range"
            min={SNAPSHOT_MIN_ZOOM * 100}
            max={SNAPSHOT_MAX_ZOOM * 100}
            step="1"
            value={zoomPercent}
            aria-label={`缩放：${zoomPercent}%`}
            style={{ background: track(zoomPercent, SNAPSHOT_MIN_ZOOM * 100, SNAPSHOT_MAX_ZOOM * 100) }}
            onChange={(event) => patch({ zoom: Number(event.target.value) / 100 })}
          />
        </label>
      </div>

      <div className="snapshot-menu__actions">
        <button
          type="button"
          onClick={() => {
            patch({ locked: !view?.locked })
            window.close()
          }}
        >
          {view?.locked ? '解锁' : '锁定'}
        </button>
        <button
          type="button"
          onClick={() => {
            void api?.refresh()
            window.close()
          }}
        >
          刷新
        </button>
        <button type="button" onClick={() => void api?.close()}>取消</button>
      </div>
    </main>
  )
}
