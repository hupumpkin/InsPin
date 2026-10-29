import type { AssetInfo, Viewport } from '../../../shared/ipc'
import type { AssetNode } from '../../../shared/node'
import type { SceneItem } from '../../../shared/scene'
import { MISSING_ASSET_LABEL } from '../asset-format'
import { toScreen } from '../canvas/viewport'

/**
 * 挂在素材上的小标签。
 *
 * 只显示“素材缺失”（D6a.3）——原图文件已经不在磁盘上了，画布上那块是占位框。
 * 低清 / 截图副本属于对象元数据，放进对象面板读取，避免往画布上叠胶囊标签。
 *
 * 和操作层一样用 DOM 画：**字不能跟着缩放变糊**，而且只读、不参与命中测试
 * （`pointer-events: none`），点标签等于点到底下的图。
 *
 * 贴在图片左上角内侧——用户扫一眼就知道怎么回事，不用去开检查器或跑体检。
 */
export default function NodeBadges({
  items,
  assets,
  viewport
}: {
  items: SceneItem[]
  assets: Record<string, AssetInfo>
  viewport: Viewport
}): React.JSX.Element | null {
  const badged: { id: string; item: SceneItem; node: AssetNode; label: string }[] = []
  for (const item of items) {
    const node = item.node
    if (node.type !== 'asset') continue
    const missing = assets[node.props.assetId]?.missing === true
    if (!missing) continue
    badged.push({
      id: node.id,
      item,
      node,
      label: MISSING_ASSET_LABEL
    })
  }
  if (badged.length === 0) return null

  return (
    <div className="badges">
      {badged.map(({ id, item, node, label }) => {
        const at = toScreen(viewport, { x: item.absX, y: item.absY })
        return (
          <span
            key={id}
            className="badges__pill"
            data-kind="missing"
            style={{ left: at.x + 6, top: at.y + 6 }}
          >
            {label}
          </span>
        )
      })}
    </div>
  )
}
