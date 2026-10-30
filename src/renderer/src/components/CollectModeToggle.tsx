import { useState } from 'react'
import { useGraphStore } from '../state/graph'

/**
 * 智能采集进行中的"滚动屏幕 / 锁定屏幕"分段开关。
 *
 * 设计规范 §2.1.5：轨道 r8、内边距 2、按钮高 26 / r6；
 * 选中态是滑动的白色胶囊。点击先乐观移动滑块，不等主进程抓图完成，
 * 真正切换失败时再退回原位置。
 */
export default function CollectModeToggle(): React.JSX.Element | null {
  const capture = useGraphStore((state) => state.capture)
  const setCaptureFreeze = useGraphStore((state) => state.setCaptureFreeze)
  const [optimisticLive, setOptimisticLive] = useState<boolean | null>(null)

  if (!capture || capture.mode !== 'collect') return null
  const live = optimisticLive ?? capture.live === true

  const choose = async (nextFreeze: boolean): Promise<void> => {
    const wantLive = !nextFreeze
    if (wantLive === live) return
    setOptimisticLive(wantLive)
    try {
      await setCaptureFreeze(nextFreeze)
    } finally {
      setOptimisticLive(null)
    }
  }

  return (
    <div
      className="collect-mode"
      role="group"
      aria-label="采集时屏幕是否可滚动"
      data-live={live ? 'true' : 'false'}
    >
      <span className="collect-mode__thumb" aria-hidden="true" />
      <button
        type="button"
        aria-pressed={live}
        title="采集中可以继续滚动网页"
        onClick={() => void choose(false)}
      >
        滚动屏幕
      </button>
      <button
        type="button"
        aria-pressed={!live}
        title="采集中网页保持锁定"
        onClick={() => void choose(true)}
      >
        锁定屏幕
      </button>
    </div>
  )
}
