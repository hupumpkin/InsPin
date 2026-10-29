import { useEffect, useState } from 'react'
import { currentRelease } from '../../../shared/release'
import type { AppDataInfo, LibraryUsage, MaintenanceResult } from '../../../shared/maintenance'
import { useProjectStore } from '../state/projects'
import { useUiStore } from '../state/ui'

/**
 * 设置面板的「数据与备份」页（D6a.1–D6a.3 + D6b.1）。
 *
 * 这一页的每一件事都**会改动用户的真东西**（备份、导出、导入、清数据），
 * 所以规矩是：动作前说清"会发生什么"，动作后如实说"结果如何"，
 * 失败给一句能照做的话，绝不只把错误码甩出来。
 */

type Busy = null | 'backup' | 'export' | 'import' | 'health' | 'clear' | 'diagnostics' | 'cleanup'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DataSettings(): React.JSX.Element {
  const api = window.insPin?.data
  const currentId = useProjectStore((state) => state.currentId)
  const projects = useProjectStore((state) => state.projects)
  const current = projects.find((project) => project.id === currentId) ?? null

  const assetCleanup = useUiStore((state) => state.assetCleanup)
  const setAssetCleanup = useUiStore((state) => state.setAssetCleanup)

  const [info, setInfo] = useState<AppDataInfo | null>(null)
  const [usage, setUsage] = useState<LibraryUsage | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [result, setResult] = useState<MaintenanceResult | null>(null)
  const [cleanupResult, setCleanupResult] = useState<MaintenanceResult | null>(null)
  const [graceDraft, setGraceDraft] = useState(String(assetCleanup.graceDays))
  const [trashDraft, setTrashDraft] = useState(String(assetCleanup.trashDays))

  useEffect(() => {
    void api?.info().then(setInfo)
    void api?.libraryUsage().then(setUsage)
  }, [api])

  useEffect(() => setGraceDraft(String(assetCleanup.graceDays)), [assetCleanup.graceDays])
  useEffect(() => setTrashDraft(String(assetCleanup.trashDays)), [assetCleanup.trashDays])

  const cleanupNow = async (): Promise<void> => {
    setBusy('cleanup')
    setCleanupResult(null)
    try {
      setCleanupResult(await api!.cleanupLibrary())
      setUsage(await api!.libraryUsage())
    } catch (error) {
      setCleanupResult({ ok: false, message: error instanceof Error ? error.message : '这一步没能完成' })
    } finally {
      setBusy(null)
    }
  }

  const clamp = (value: string, min: number, max: number, fallback: number): number => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || value.trim() === '') return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }

  if (!api) {
    return (
      <div className="settings__section">
        <p className="settings__lead">这一页没能加载上，请按 ⌘Q 退出 InsPin 后重新打开。</p>
      </div>
    )
  }

  /** 所有动作共用：跑的时候禁用按钮，回来后把结果摆出来。 */
  const run = async (which: Busy, task: () => Promise<MaintenanceResult>): Promise<void> => {
    setBusy(which)
    setResult(null)
    try {
      setResult(await task())
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : '这一步没能完成' })
    } finally {
      setBusy(null)
    }
  }

  const healthCheck = async (): Promise<void> => {
    setBusy('health')
    setResult(null)
    try {
      const report = await api.healthCheck()
      if (report.missing.length === 0) {
        setResult({
          ok: true,
          message: '体检通过：没有丢失的素材',
          detail: `查了 ${report.checkedNodes} 个素材对象`
        })
      } else {
        const shown = report.missing.slice(0, 5)
        setResult({
          ok: false,
          message: `有 ${report.missing.length} 个对象找不到素材文件（约 ${formatBytes(report.missingBytes)}）`,
          detail: [
            ...shown.map((item) => `· ${item.projectName} / ${item.nodeName}`),
            report.missing.length > shown.length ? `…… 还有 ${report.missing.length - shown.length} 个` : '',
            '',
            '画布上它们会显示成占位框。想恢复：把丢失的素材文件放回数据目录的 assets/ 里，再体检一次。'
          ]
            .filter(Boolean)
            .join('\n')
        })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings__section">
      <h3 className="settings__subtitle">数据在哪</h3>
      {info ? (
        <>
          <p className="settings__lead">
            项目、素材、浏览数据<strong>全部在这台电脑上</strong>，不会上传。
          </p>
          <p className="settings__path">{info.dataRoot}</p>
        </>
      ) : (
        <p className="settings__lead">正在读取…</p>
      )}
      <div className="settings__actions">
        <button
          type="button"
          className="settings__button"
          onClick={() => void api.revealRoot()}
        >
          在访达里打开
        </button>
      </div>

      <h3 className="settings__subtitle">素材清理</h3>
      <p className="settings__lead">
        临时素材失去全部画布引用后，先等宽限期，再进回收站；回收站再保留一段时间后彻底删除。
        这个流程也会在每次打开应用和素材侧栏时自动补算。参考快照里用到的素材不会被清理。
      </p>
      <div className="settings__field settings__field--toggle">
        <span className="settings__field-text">
          <strong className="settings__field-label">自动清理未使用的临时素材</strong>
          <span className="settings__hint">
            关掉后不会移动或删除任何素材；已有的无引用计时会保留，重新打开后继续计算。
          </span>
        </span>
        <input
          type="checkbox"
          checked={assetCleanup.enabled}
          onChange={(event) => setAssetCleanup({ enabled: event.target.checked })}
        />
      </div>
      <div className="settings__cleanup-row">
        <label className="settings__number-field">
          未引用
          <input
            type="number"
            className="settings__number"
            min={1}
            max={90}
            value={graceDraft}
            onChange={(event) => setGraceDraft(event.target.value)}
            onBlur={() => {
              const days = clamp(graceDraft, 1, 90, assetCleanup.graceDays)
              setGraceDraft(String(days))
              setAssetCleanup({ graceDays: days })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          天后进回收站
        </label>
        <label className="settings__number-field">
          回收站保留
          <input
            type="number"
            className="settings__number"
            min={2}
            max={365}
            value={trashDraft}
            onChange={(event) => setTrashDraft(event.target.value)}
            onBlur={() => {
              const days = clamp(trashDraft, 2, 365, assetCleanup.trashDays)
              setTrashDraft(String(days))
              setAssetCleanup({ trashDays: days })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          天
        </label>
      </div>
      {usage && (
        <>
          <p className="settings__usage">
            当前素材 {usage.managedCount} 张 · {formatBytes(usage.managedBytes)}（长期保留{' '}
            {usage.permanentCount} 张 · {formatBytes(usage.permanentBytes)}）；回收站 {usage.trashCount}{' '}
            张 · {formatBytes(usage.trashBytes)}
          </p>
          <p className="settings__hint">
            长期保留 = 从 Finder / 剪贴板导入，或从素材库放进画布的素材。它们不会被自动清理，
            要删的话请在素材库里手动移入回收站。
          </p>
        </>
      )}
      <div className="settings__actions">
        <button
          type="button"
          className="settings__button"
          disabled={busy !== null || !assetCleanup.enabled}
          onClick={() => void cleanupNow()}
        >
          {busy === 'cleanup' ? '正在整理…' : '立即检查并清理'}
        </button>
      </div>
      {cleanupResult && (
        <div className="settings__result" data-ok={cleanupResult.ok}>
          <p className="settings__result-title">{cleanupResult.message}</p>
          {cleanupResult.detail && <pre className="settings__result-detail">{cleanupResult.detail}</pre>}
        </div>
      )}

      <h3 className="settings__subtitle">备份</h3>
      <p className="settings__lead">
        把项目和素材打包成一个文件夹，存到你选的位置。备份是一份自洽的副本，
        换台机器也能用它找回内容。
      </p>
      <div className="settings__actions">
        <button
          type="button"
          className="settings__button"
          disabled={busy !== null}
          onClick={() => void run('backup', () => api.backup())}
        >
          {busy === 'backup' ? '正在备份…' : '一键备份…'}
        </button>
      </div>

      <h3 className="settings__subtitle">项目搬家</h3>
      <p className="settings__lead">
        导出一个项目会带着它的素材走；导入时会新建一个项目，
        同一张图在本机已经有的话不会重复占地方。
      </p>
      <div className="settings__actions">
        <button
          type="button"
          className="settings__button"
          disabled={busy !== null || !currentId}
          onClick={() => void run('export', () => api.exportProject(currentId ?? ''))}
        >
          {busy === 'export' ? '正在导出…' : `导出当前项目${current ? `（${current.name}）` : ''}…`}
        </button>
        <button
          type="button"
          className="settings__button"
          disabled={busy !== null}
          onClick={() => void run('import', () => api.importProject())}
        >
          {busy === 'import' ? '正在导入…' : '从文件夹导入…'}
        </button>
      </div>

      <h3 className="settings__subtitle">素材体检</h3>
      <p className="settings__lead">
        检查有没有"记录还在、文件却没了"的素材。体检只看不改，不会动你的数据。
      </p>
      <div className="settings__actions">
        <button
          type="button"
          className="settings__button"
          disabled={busy !== null}
          onClick={() => void healthCheck()}
        >
          {busy === 'health' ? '正在体检…' : '开始体检'}
        </button>
      </div>

      <h3 className="settings__subtitle">浏览数据</h3>
      <p className="settings__lead">
        清掉网页的登录态、缓存和已打开的标签；<strong>素材和项目不受影响</strong>。
      </p>
      <div className="settings__actions">
        <button
          type="button"
          className="settings__button settings__button--warn"
          disabled={busy !== null}
          onClick={() => void run('clear', () => api.clearBrowsing())}
        >
          {busy === 'clear' ? '正在清理…' : '清除浏览数据'}
        </button>
      </div>

      <h3 className="settings__subtitle">诊断</h3>
      <p className="settings__lead">
        导出一份运行记录（已脱敏，不含图片和登录信息），遇到问题时可以发给我。
      </p>
      <div className="settings__actions">
        <button
          type="button"
          className="settings__button"
          disabled={busy !== null}
          onClick={() => void run('diagnostics', () => api.exportDiagnostics())}
        >
          {busy === 'diagnostics' ? '正在导出…' : '导出诊断包…'}
        </button>
      </div>

      {result && (
        <div className="settings__result" data-ok={result.ok}>
          <p className="settings__result-title">{result.message}</p>
          {result.detail && <pre className="settings__result-detail">{result.detail}</pre>}
        </div>
      )}

      <h3 className="settings__subtitle">版本</h3>
      <p className="settings__lead">
        {currentRelease.displayName} {info?.appVersion ?? '…'}
      </p>
      <ul className="settings__list">
        <li>当前是{currentRelease.channelLabel}，不会自动检查更新；需要最新版请在群里找我</li>
        <li>这台公司管控机上，正式安装包打不开，用桌面上的「启动 InsPin.app」就行</li>
        <li>参考快照不进 Figma、也不读 Figma 的内容，只是浮在最上面</li>
        <li>浏览器登录态与网页共用一份，退出登录会一起退</li>
      </ul>
    </div>
  )
}
