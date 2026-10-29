// 直接跑真实的 ImageSearchService（不经过界面），验证素材解析 → 开标签 → 注入 → 等结果。
// 单次：npm run experiment:service -- --engine=google
// 验收：npm run experiment:service -- --acceptance
import { app, BrowserWindow, clipboard, nativeImage, session, WebContentsView } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/main/db'
import { saveAsset } from '../src/main/assets'
import { ImageSearchService } from '../src/main/image-search/service'
import { collectCaptureCandidates } from '../src/main/capture-candidates'
import { VISIBLE_IMAGES_SCRIPT, collectVisibleImages } from '../src/main/image-search/collect'
import { createProject } from '../src/main/projects'
import type { ImageSearchEngineId, ImageSearchStartResult } from '../src/shared/image-search'

const arg = (name: string, fallback: string): string =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const ENGINE = arg('engine', 'google') as ImageSearchEngineId
const ACCEPTANCE = process.argv.includes('--acceptance')
/** --crop=x,y,w,h（0–1 归一化），验证「框选局部搜索」只上传框内区域 */
const CROP = (() => {
  const raw = arg('crop', '')
  if (!raw) return undefined
  const [x, y, w, h] = raw.split(',').map(Number)
  return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : undefined
})()
const DEFAULT_PARTITION = process.env.INSPIN_LAB_PARTITION || 'persist:inspin-browser'

const passed: string[] = []
const failed: string[] = []

function record(name: string, ok: boolean, detail: unknown): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`, JSON.stringify(detail))
  ;(ok ? passed : failed).push(name)
}

function convert(source: string, target: string, args: string[]): string {
  execFileSync('/usr/bin/sips', [...args, source, '--out', target], { stdio: 'ignore' })
  return target
}

/** 卡住的用例要变成失败，而不是让整个验收一直挂着。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
      timer.unref?.()
    })
  ])
}

async function main(): Promise<void> {
  await app.whenReady()

  const root = mkdtempSync(join(tmpdir(), 'inspin-service-'))
  const assetsDir = join(root, 'assets')
  mkdirSync(assetsDir)
  const db = openDatabase(join(root, 'test.db'))

  // 用 InsPin 自己的图标当测试图：不上传用户素材（裸脚本下 app.getAppPath() 不是仓库根）
  const pngPath = join(process.cwd(), 'build', 'icon.png')
  const pngBytes = readFileSync(pngPath)

  const win = new BrowserWindow({
    width: 1000,
    height: 780,
    show: true,
    title: `InsPin service experiment — ${ACCEPTANCE ? 'acceptance' : ENGINE}`
  })
  // 先等窗口自己的文档就绪，后面借它的 webContents 生成 WebP 测试图
  await win.webContents.loadURL('about:blank')

  let view: WebContentsView | null = null
  let partition = DEFAULT_PARTITION

  const openTab = (url: string): { tabId: string; webContents: Electron.WebContents } => {
    if (view) {
      try {
        win.contentView.removeChildView(view)
      } catch {
        // already detached
      }
      try {
        view.webContents.close()
      } catch {
        // already closed
      }
    }
    view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1000, height: 780 })
    void view.webContents.loadURL(url)
    return { tabId: 'experiment-tab', webContents: view.webContents }
  }

  const logger = {
    info: (event: string, fields?: Record<string, unknown>) =>
      console.log('[info]', event, JSON.stringify(fields ?? {})),
    error: (event: string, fields?: Record<string, unknown>) =>
      console.log('[error]', event, JSON.stringify(fields ?? {}))
  }

  const createService = (hasConsent = true): ImageSearchService =>
    new ImageSearchService({
      db,
      assetsDir,
      openPanel: () => {},
      openTab,
      hasConsent: () => hasConsent,
      logger
    })

  async function saveBytes(bytes: Uint8Array): Promise<string> {
    const saved = await saveAsset(db, assetsDir, { bytes, importMethod: 'file' })
    return saved.asset.fileName
  }

  async function saveHeic(heicPath: string, bytes: Uint8Array): Promise<string> {
    // 用一张尺寸不同的 PNG 建独立素材行，避免和上面的 png 去重成同一条记录
    const saved = await saveAsset(db, assetsDir, { bytes, importMethod: 'file' })
    writeFileSync(join(assetsDir, 'test.heic'), readFileSync(heicPath))
    db.prepare('UPDATE assets SET file_name = ?, mime = ? WHERE id = ?').run(
      'test.heic',
      'image/heic',
      saved.asset.id
    )
    return 'test.heic'
  }

  async function makeWebp(target: string): Promise<string> {
    const base64 = pngBytes.toString('base64')
    const data = await win.webContents.executeJavaScript(`(async () => {
      const blob = await (await fetch('data:image/png;base64,${base64}')).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      return canvas.toDataURL('image/webp').split(',')[1]
    })()`)
    writeFileSync(target, Buffer.from(data, 'base64'))
    return target
  }

  if (!ACCEPTANCE) {
    const fileName = await saveBytes(pngBytes)
    console.log('asset', fileName)
    const started = Date.now()
    const result = await createService(true).start({
      engineId: ENGINE,
      assetFileName: fileName,
      projectId: 'experiment',
      mode: arg('mode', 'auto') === 'paste' ? 'paste' : 'auto',
      ...(CROP ? { crop: CROP } : {})
    })
    console.log('[result]', JSON.stringify(result), `${Date.now() - started}ms`)
    console.log('[url]', view?.webContents.getURL())

    if (process.argv.includes('--collect-import') && result.ok && view) {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const project = createProject(db, 'collect-test')
      const collected = await collectVisibleImages(
        {
          db,
          assetsDir,
          measure: (bytes) => {
            const image = nativeImage.createFromBuffer(Buffer.from(bytes))
            if (image.isEmpty()) return null
            const size = image.getSize()
            return size.width > 0 && size.height > 0 ? size : null
          },
          fetchImpl: (url, init) => session.fromPartition(partition).fetch(url, init),
          logger
        },
        project.id,
        view.webContents,
        {
          limit: Number(arg('limit', '12')),
          layout: { x: 120, y: 120, maxWidth: 1600 }
        }
      )
      console.log(
        '[collect-import]',
        JSON.stringify(
          collected.ok
            ? { ok: true, importedCount: collected.importedCount, errors: collected.errors.length }
            : { ok: false, message: collected.message }
        )
      )
      console.log('[collect-import-nodes]', collected.ok ? Object.keys(collected.graph.nodes).length : 0)
      if (collected.ok) {
        const boxes = Object.values(collected.graph.nodes)
          .filter((node) => node.type === 'asset')
          .map((node) => ({
            x: Math.round(node.x),
            y: Math.round(node.y),
            w: Math.round(node.w),
            h: Math.round(node.h)
          }))
          .sort((a, b) => a.y - b.y || a.x - b.x)
        console.log('[collect-layout]', JSON.stringify(boxes))
      }
    }

    const ok = result.ok === true && result.mode === 'inject'
    console.log(ok ? 'SERVICE-OK' : 'SERVICE-FAIL')
    setTimeout(() => app.exit(ok ? 0 : 1), 500)
    return
  }

  // ---------- 验收矩阵 ----------
  console.log('[prep] 生成测试格式…')
  const jpgPath = convert(pngPath, join(root, 'test.jpg'), ['-s', 'format', 'jpeg'])
  const heicPath = convert(pngPath, join(root, 'test.heic'), ['-s', 'format', 'heic'])
  const heicSource = convert(pngPath, join(root, 'heic-source.png'), ['-z', '64', '64'])
  const webpPath = await makeWebp(join(root, 'test.webp'))

  const pngName = await saveBytes(pngBytes)
  const jpgName = await saveBytes(readFileSync(jpgPath))
  const webpName = await saveBytes(readFileSync(webpPath))
  const heicName = await saveHeic(heicPath, readFileSync(heicSource))

  const cases: {
    name: string
    engine: ImageSearchEngineId
    fileName: string
    mode?: 'auto' | 'paste'
    consent?: boolean
    cancelAfterMs?: number
    freshPartition?: boolean
    expect: 'inject' | 'paste' | 'consent-required' | 'cancelled' | 'login-required'
  }[] = [
    { name: 'google-png', engine: 'google', fileName: pngName, expect: 'inject' },
    { name: 'pinterest-png', engine: 'pinterest', fileName: pngName, expect: 'inject' },
    { name: 'huaban-png', engine: 'huaban', fileName: pngName, expect: 'inject' },
    { name: 'zcool-png', engine: 'zcool', fileName: pngName, expect: 'inject' },
    { name: 'pinterest-jpg', engine: 'pinterest', fileName: jpgName, expect: 'inject' },
    { name: 'zcool-webp', engine: 'zcool', fileName: webpName, expect: 'inject' },
    { name: 'google-heic', engine: 'google', fileName: heicName, expect: 'inject' },
    { name: 'google-paste-fallback', engine: 'google', fileName: pngName, mode: 'paste', expect: 'paste' },
    { name: 'consent-required', engine: 'google', fileName: pngName, consent: false, expect: 'consent-required' },
    { name: 'cancel-mid-flight', engine: 'google', fileName: pngName, cancelAfterMs: 400, expect: 'cancelled' },
    {
      name: 'pinterest-logged-out',
      engine: 'pinterest',
      fileName: pngName,
      freshPartition: true,
      expect: 'login-required'
    },
    {
      name: 'huaban-logged-out',
      engine: 'huaban',
      fileName: pngName,
      freshPartition: true,
      expect: 'login-required'
    }
  ]

  const only = arg('only', '')
  for (const testCase of cases.filter((item) => !only || item.name === only)) {
    partition = testCase.freshPartition
      ? `persist:inspin-lab-fresh-${Date.now()}`
      : DEFAULT_PARTITION
    const service = createService(testCase.consent !== false)
    const started = Date.now()
    console.log(`[case] ${testCase.name} …`)
    let cancelTimer: ReturnType<typeof setTimeout> | null = null
    if (testCase.cancelAfterMs) {
      cancelTimer = setTimeout(() => service.cancel(), testCase.cancelAfterMs)
    }
    let result: ImageSearchStartResult
    try {
      result = await withTimeout(
        service.start({
          engineId: testCase.engine,
          assetFileName: testCase.fileName,
          projectId: 'acceptance',
          mode: testCase.mode ?? 'auto'
        }),
        60_000,
        testCase.name
      )
    } catch (error) {
      service.cancel()
      record(testCase.name, false, {
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started
      })
      continue
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer)
    }

    let ok = false
    if (testCase.expect === 'inject') ok = result.ok === true && result.mode === 'inject'
    else if (testCase.expect === 'paste') ok = result.ok === true && result.mode === 'paste'
    else ok = result.ok === false && result.reason === testCase.expect

    if (testCase.expect === 'paste' && ok) {
      try {
        const items = await clipboard.read()
        const hasImage = items.some((item) => item.types.includes('image/png'))
        record(`${testCase.name}-clipboard`, hasImage, { types: items.map((item) => item.types) })
      } catch {
        record(`${testCase.name}-clipboard`, false, { note: 'clipboard.read 不可用' })
      }
    }

    record(testCase.name, ok, {
      result,
      ms: Date.now() - started,
      url: view?.webContents.getURL()
    })

    // P1 侦察：结果页上现有的智能采集能识别出多少候选、其中多少带原图
    const collectNames = new Set(['google-png', 'pinterest-png', 'huaban-png', 'zcool-png'])
    if (process.argv.includes('--collect') && collectNames.has(testCase.name) && result.ok && view) {
      // 等结果页把图片渲染完再采样，否则量到的是"还在加载"
      await new Promise((resolve) => setTimeout(resolve, 2500))
      try {
        const collection = await collectCaptureCandidates(view.webContents, {
          x: 0,
          y: 0,
          width: 1000,
          height: 780
        })
        console.log(
          '[collect]',
          testCase.name,
          JSON.stringify({
            candidates: collection.candidates.length,
            withOriginal: collection.candidates.filter((item) => item.originalAvailable).length,
            sample: collection.candidates
              .filter((item) => item.originalAvailable)
              .slice(0, 3)
              .map((item) => ({ w: Math.round(item.width), h: Math.round(item.height) }))
          })
        )
        // P1 新入口：直接扫可见大图的命中数，和智能采集候选做对比
        const visibleUrls = (await view.webContents.executeJavaScript(
          VISIBLE_IMAGES_SCRIPT
        )) as string[]
        console.log('[visible]', testCase.name, JSON.stringify({ count: visibleUrls.length }))
      } catch (error) {
        console.log(
          '[collect]',
          testCase.name,
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        )
      }
    }
  }

  console.log(`\n验收合计 ${passed.length + failed.length} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) console.log('失败项：' + failed.join(', '))
  setTimeout(() => app.exit(failed.length === 0 ? 0 : 1), 500)
}

void main().catch((error: unknown) => {
  console.error('[fatal]', error instanceof Error ? error.stack ?? error.message : String(error))
  app.exit(1)
})
