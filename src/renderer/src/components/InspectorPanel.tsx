import { X } from 'reicon-react'
import type { AssetInfo } from '../../../shared/ipc'
import type { Node } from '../../../shared/node'
import {
  assetBadgeLabel,
  formatBytes,
  formatDateTime,
  hostOf,
  importMethodLabel,
  nodeKindLabel
} from '../asset-format'
import { browserBridge, canvasBridge } from '../bridge'
import { useGraphStore } from '../state/graph'
import { useSelectionStore } from '../state/selection'
import { useUiStore } from '../state/ui'

/**
 * 对象检查器（路线图 D1.8；原始规格里是"右侧 280px"）。
 *
 * 设计稿没画检查器（列为"未覆盖"），所以按既定语言做一块**右侧白色浮层**：
 * **不常态展示**，只有按 ⌥⌘I 才出现，看清选中对象的来源与尺寸。整块界面仍零彩度。
 *
 * 关注点是"这张图从哪来"：来源方式、原网页域名、像素尺寸、文件大小、加入时间。
 * 网址**默认只显示域名**，不把完整链接摊在界面上（与诊断包的脱敏思路一致）。
 */

interface InspectorPanelProps {
  placement?: 'canvas-controls'
}

export default function InspectorPanel({ placement }: InspectorPanelProps): React.JSX.Element {
  const selectedIds = useSelectionStore((state) => state.ids)
  const graph = useGraphStore((state) => state.graph)
  const assets = useGraphStore((state) => state.assets)
  const toggleInspector = useUiStore((state) => state.toggleInspector)

  const node = selectedIds.length === 1 ? (graph?.nodes[selectedIds[0] ?? ''] ?? null) : null

  return (
    <aside className={`inspector${placement ? ` inspector--${placement}` : ''}`} aria-label="对象检查器">
      <div className="panel__head">
        <span className="panel__title">对象</span>
        <button
          type="button"
          className="panel__close"
          aria-label="收起检查器"
          title="收起检查器（⌥⌘I）"
          onClick={toggleInspector}
        >
          <X size={16} weight="Outline" />
        </button>
      </div>

      {!node ? (
        <p className="inspector__empty">在画布上选中一个对象，这里会显示它的来源与尺寸</p>
      ) : (
        <InspectorBody node={node} asset={node.type === 'asset' ? assets[node.props.assetId] : undefined} />
      )}
    </aside>
  )
}

function InspectorBody({ node, asset }: { node: Node; asset?: AssetInfo }): React.JSX.Element {
  const bridge = canvasBridge()
  const previewUrl = asset && bridge ? bridge.thumbUrl(asset.fileName) : null
  const origin = asset ? (hostOf(asset.pageUrl) ?? hostOf(asset.sourceUrl)) : null
  const sourcePage = asset?.pageUrl ?? asset?.sourceUrl ?? null

  const openSource = (): void => {
    if (!sourcePage) return
    if (!useUiStore.getState().panel.requested) useUiStore.getState().toggleBrowser()
    void browserBridge()?.newTab(sourcePage)
  }

  return (
    <div className="inspector__body">
      <div className="inspector__preview">
        {previewUrl ? (
          <img src={previewUrl} alt="" />
        ) : (
          <span className="inspector__preview-empty">{nodeKindLabel(node)}</span>
        )}
      </div>

      <p className="inspector__name" title={node.name}>
        {node.name}
      </p>

      <dl className="inspector__facts">
        <Fact label="类型" value={nodeKindLabel(node)} />
        <Fact label="尺寸" value={`${Math.round(node.w)} × ${Math.round(node.h)}`} />
        {node.type === 'asset' && asset && (
          <>
            <Fact
              label="原始像素"
              value={
                asset.width && asset.height ? `${asset.width} × ${asset.height}` : '未知'
              }
            />
            <Fact label="文件大小" value={formatBytes(asset.bytes)} />
            <Fact label="来源" value={importMethodLabel(asset.importMethod)} />
            {/* D3.17：粘贴 / 截图 / 原图要能区分开——"来源"说的是怎么进来的，
                "标记"说的是这是不是原图，两件事分开讲 */}
            {node.type === 'asset' && node.props.badge && (
              <Fact label="标记" value={assetBadgeLabel(node.props.badge)} />
            )}
            {origin && <Fact label="来源站点" value={origin} />}
            {sourcePage && (
              <div className="inspector__anchor">
                <span>来源锚点</span>
                <button type="button" onClick={openSource}>
                  打开来源页
                </button>
              </div>
            )}
            <Fact label="加入时间" value={formatDateTime(asset.createdAt)} />
          </>
        )}
        {(node.type === 'group' || node.type === 'frame') && (
          <Fact label="包含" value={`${node.childIds.length} 个对象`} />
        )}
      </dl>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="inspector__fact">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}
