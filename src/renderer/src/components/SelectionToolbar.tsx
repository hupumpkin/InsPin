import { useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { Camera, CloseCircle } from 'reicon-react'
import type { AlignMode } from '../canvas/alignment'
import type { ImageSearchEngineId } from '../../../shared/image-search'
import MaskIcon from './MaskIcon'
import pinIcon from '../assets/icons/relay-pin.svg'
import cropIcon from '../assets/icons/relay-crop.svg'
import cutoutIcon from '../assets/icons/relay-cutout.svg'
import sourceIcon from '../assets/icons/relay-source.svg'
import copyIcon from '../assets/icons/relay-copy.svg'
import autoLayoutIcon from '../assets/icons/relay-auto-layout.svg'
import alignLeftIcon from '../assets/icons/relay-align-left.svg'
import alignCenterXIcon from '../assets/icons/relay-align-center-x.svg'
import alignRightIcon from '../assets/icons/relay-align-right.svg'
import alignTopIcon from '../assets/icons/relay-align-top.svg'
import alignCenterYIcon from '../assets/icons/relay-align-center-y.svg'
import alignBottomIcon from '../assets/icons/relay-align-bottom.svg'

interface SingleActions {
  onSnapshot: () => void
  onCrop: () => void
  onSource: () => void
  onCopy: () => void
  cutout?: { busy: boolean; onRun: () => void }
  searchByImage?: {
    engines: { id: ImageSearchEngineId; label: string }[]
    busy: ImageSearchEngineId | null
    onPick: (id: ImageSearchEngineId, mode: 'auto' | 'paste') => void
    /** 先框选一块，再选站点搜索 */
    onCropSearch: () => void
    /** 搜索进行中，点这里叫停 */
    onCancel: () => void
  }
}

interface MultiActions {
  onSnapshot: () => void
  onCopy: () => void
  onAutoLayout: () => void
  onAlign: (mode: AlignMode) => void
}

interface PinOnlyActions {
  onSnapshot: () => void
  onCopy: () => void
}

interface Props {
  style?: CSSProperties
  containerRef?: Ref<HTMLDivElement>
  single?: SingleActions
  multi?: MultiActions
  pinOnly?: PinOnlyActions
}

/**
 * 选择即语境：单图只露出内容处理，多个对象只露出布局处理。
 * 避免把“去背景、裁切”误用到一组选区，也避免单图工具栏塞满排版动作。
 */
export default function SelectionToolbar({ style, containerRef, single, multi, pinOnly }: Props): React.JSX.Element | null {
  const [alignOpen, setAlignOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchMode, setSearchMode] = useState<'auto' | 'paste'>('auto')
  if (!single && !multi && !pinOnly) return null

  if (pinOnly) {
    return (
      <div className="seltool" role="toolbar" aria-label="对象钉住" style={style} ref={containerRef}>
        <div className="seltool__group">
          <ToolButton label="钉住" iconSrc={pinIcon} onClick={pinOnly.onSnapshot} />
          <ToolButton label="复制" iconSrc={copyIcon} onClick={pinOnly.onCopy} title="复制（⌘C）" />
        </div>
      </div>
    )
  }

  if (single) {
    return (
      <div className="seltool" role="toolbar" aria-label="图片操作" style={style} ref={containerRef}>
        <div className="seltool__group">
          <ToolButton label="钉住" iconSrc={pinIcon} onClick={single.onSnapshot} />
          <ToolButton label="裁切" iconSrc={cropIcon} onClick={single.onCrop} />
          {single.cutout && (
            <ToolButton
              label={single.cutout.busy ? '处理中' : '去背景'}
              iconSrc={cutoutIcon}
              onClick={single.cutout.onRun}
              disabled={single.cutout.busy}
            />
          )}
          <ToolButton label="来源" iconSrc={sourceIcon} onClick={single.onSource} title="打开来源页" />
          {single.searchByImage &&
            (single.searchByImage.busy ? (
              <ToolButton
                label="取消搜索"
                icon={<CloseCircle size={16} />}
                onClick={single.searchByImage.onCancel}
                title={`正在用 ${
                  single.searchByImage.engines.find((engine) => engine.id === single.searchByImage!.busy)?.label ??
                  '站点'
                } 搜索，点这里取消`}
              />
            ) : (
              <div className="seltool__menu-wrap">
                <ToolButton
                  label="搜图"
                  icon={<Camera size={16} />}
                  onClick={() => {
                    if (!searchOpen) setSearchMode('auto')
                    setSearchOpen(!searchOpen)
                  }}
                  ariaExpanded={searchOpen}
                />
                {searchOpen && (
                  <SearchMenu
                    engines={single.searchByImage.engines}
                    mode={searchMode}
                    onModeChange={setSearchMode}
                    onPick={(id, mode) => {
                      setSearchOpen(false)
                      setSearchMode('auto')
                      single.searchByImage!.onPick(id, mode)
                    }}
                    onCropSearch={() => {
                      setSearchOpen(false)
                      single.searchByImage!.onCropSearch()
                    }}
                  />
                )}
              </div>
            ))}
          <ToolButton
            label="复制"
            iconSrc={copyIcon}
            onClick={single.onCopy}
            title="复制（⌘C）"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="seltool" role="toolbar" aria-label="多个对象操作" style={style} ref={containerRef}>
      <div className="seltool__group">
        <ToolButton label="钉住" iconSrc={pinIcon} onClick={multi!.onSnapshot} />
        <ToolButton label="自动整理" iconSrc={autoLayoutIcon} onClick={multi!.onAutoLayout} />
        <div className="seltool__menu-wrap">
          <ToolButton
            label="对齐"
            iconSrc={alignLeftIcon}
            onClick={() => setAlignOpen((open) => !open)}
            ariaExpanded={alignOpen}
          />
          {alignOpen && <AlignmentMenu onPick={(mode) => { multi!.onAlign(mode); setAlignOpen(false) }} />}
        </div>
        <ToolButton label="复制" iconSrc={copyIcon} onClick={multi!.onCopy} title="复制（⌘C）" />
      </div>
    </div>
  )
}

function ToolButton({
  label,
  iconSrc,
  icon,
  onClick,
  disabled = false,
  title = label,
  ariaExpanded
}: {
  label: string
  iconSrc?: string
  icon?: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  ariaExpanded?: boolean
}): React.JSX.Element {
  return (
    <button type="button" className="seltool__btn" title={title} onClick={onClick} disabled={disabled} aria-expanded={ariaExpanded}>
      {icon ?? (iconSrc ? <MaskIcon className="seltool__asset-icon" src={iconSrc} /> : null)}
      <span className="seltool__label">{label}</span>
    </button>
  )
}

export function SearchMenu({
  engines,
  mode,
  onPick,
  onModeChange,
  onCropSearch
}: {
  engines: { id: ImageSearchEngineId; label: string }[]
  mode: 'auto' | 'paste'
  onPick: (id: ImageSearchEngineId, mode: 'auto' | 'paste') => void
  onModeChange: (mode: 'auto' | 'paste') => void
  onCropSearch: () => void
}): React.JSX.Element {
  return (
    <div className="seltool__search-menu" role="menu" aria-label="选择搜图站点">
      {engines.map((engine) => (
        <button key={engine.id} type="button" role="menuitem" onClick={() => onPick(engine.id, mode)}>
          {engine.label}
        </button>
      ))}
      <div className="seltool__search-divider" role="separator" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={mode === 'paste'}
        onClick={() => onModeChange(mode === 'paste' ? 'auto' : 'paste')}
      >
        {mode === 'paste' ? '✓ ' : ''}复制图片并手动粘贴
      </button>
      <button type="button" role="menuitem" onClick={onCropSearch}>
        框选局部搜索
      </button>
    </div>
  )
}

function AlignmentMenu({ onPick }: { onPick: (mode: AlignMode) => void }): React.JSX.Element {
  const actions: { mode: AlignMode; label: string; iconSrc: string }[] = [
    { mode: 'left', label: '左对齐', iconSrc: alignLeftIcon },
    { mode: 'center-x', label: '水平居中', iconSrc: alignCenterXIcon },
    { mode: 'right', label: '右对齐', iconSrc: alignRightIcon },
    { mode: 'top', label: '顶对齐', iconSrc: alignTopIcon },
    { mode: 'center-y', label: '垂直居中', iconSrc: alignCenterYIcon },
    { mode: 'bottom', label: '底对齐', iconSrc: alignBottomIcon }
  ]
  return (
    <div className="seltool__align-menu" role="menu" aria-label="对齐选项">
      {actions.map(({ mode, label, iconSrc }) => (
        <button key={mode} type="button" role="menuitem" onClick={() => onPick(mode)} title={label}>
          <MaskIcon className="seltool__align-icon" src={iconSrc} />
        </button>
      ))}
    </div>
  )
}
