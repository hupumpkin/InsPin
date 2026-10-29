// 以图搜图 Phase 0 实验：验证内嵌浏览器能否通过 CDP 把本地图片塞进网页的文件框。
// 跑法：npm run experiment:inject
// 只看机制本身，不依赖外网；夹具页面会记录 change 事件收到的文件名和大小。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ClipboardItem, WebContentsView } from 'electron'
import { encodePNG } from './png.mjs'

const ROOT = join(tmpdir(), 'inspin-image-search-lab')
mkdirSync(ROOT, { recursive: true })

const results = []
const failedCount = () => results.filter((entry) => !entry.ok).length
const log = (name, ok, detail) => {
  results.push({ name, ok, detail })
  const text = ok ? 'PASS' : 'FAIL'
  console.log(`[${text}] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
}

function makeTestImage(fileName, width = 320, height = 240) {
  const png = encodePNG(width, height, (x, y) => {
    const grid = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 === 0
    const diagonal = Math.abs(x - y * (width / height)) < 6
    if (diagonal) return [20, 20, 20, 255]
    return grid ? [230, 70, 60, 255] : [30, 110, 220, 255]
  })
  const path = join(ROOT, fileName)
  writeFileSync(path, png)
  return path
}

function convert(source, fileName, args) {
  const target = join(ROOT, fileName)
  execFileSync('/usr/bin/sips', [...args, source, '--out', target], { stdio: 'ignore' })
  return target
}

/** sips 不产出 WebP，借 Chromium 自己编码一张，保证测试图是可解码的真实 WebP。 */
async function makeWebp(wc, pngPath, fileName) {
  const base64 = readFileSync(pngPath).toString('base64')
  const data = await wc.executeJavaScript(`(async () => {
    const blob = await (await fetch('data:image/png;base64,${base64}')).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    return canvas.toDataURL('image/webp').split(',')[1]
  })()`)
  const target = join(ROOT, fileName)
  writeFileSync(target, Buffer.from(data, 'base64'))
  return target
}

const FIXTURE = `<!doctype html>
<meta charset="utf-8">
<title>injection fixture</title>
<body>
  <input id="visible-input" type="file" accept="image/*">
  <input id="hidden-input" type="file" style="display:none">
  <button id="reveal">模拟相机按钮</button>
  <script>
    window.__events = []
    function track(input) {
      input.addEventListener('change', () => {
        const file = input.files[0]
        window.__events.push({
          id: input.id,
          count: input.files.length,
          name: file ? file.name : null,
          size: file ? file.size : 0,
          type: file ? file.type : null,
          lastModified: file ? file.lastModified : 0
        })
      })
    }
    document.querySelectorAll('input[type=file]').forEach(track)
    document.querySelector('#reveal').addEventListener('click', () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'late-input'
      input.style.display = 'none'
      track(input)
      document.body.appendChild(input)
    })
  </script>
</body>`

const fixturePath = join(ROOT, 'fixture.html')
writeFileSync(fixturePath, FIXTURE)

const once = (wc, event, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wc.off(event, onEvent)
      reject(new Error(`等待 ${event} 超时`))
    }, timeoutMs)
    const onEvent = () => {
      clearTimeout(timer)
      resolve()
    }
    wc.once(event, onEvent)
  })

async function attach(wc) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('DOM.enable')
}

async function nodeFor(wc, selector) {
  const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 1 })
  const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId,
    selector
  })
  if (!nodeId) throw new Error(`找不到文件框：${selector}`)
  return nodeId
}

async function inject(wc, selector, filePath) {
  await attach(wc)
  const nodeId = await nodeFor(wc, selector)
  await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId })
  return nodeId
}

async function waitForSelector(wc, selector, timeoutMs = 8_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (found) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

const events = (wc) => wc.executeJavaScript('window.__events')

async function runFixtureExperiment(wc) {
  await attach(wc)
  log('debugger-attach', wc.debugger.isAttached(), { protocol: '1.3' })

  const png = makeTestImage('test-input.png')
  const webp = await makeWebp(wc, png, 'test-input.webp')
  const jpg = convert(png, 'test-input.jpg', ['-s', 'format', 'jpeg'])
  const heic = convert(png, 'test-input.heic', ['-s', 'format', 'heic'])
  const spaced = join(ROOT, '带 空格 的 图片.png')
  writeFileSync(spaced, encodePNG(64, 64, () => [0, 200, 120, 255]))

  const cases = [
    ['png-visible-input', '#visible-input', png],
    ['webp-visible-input', '#visible-input', webp],
    ['jpg-visible-input', '#visible-input', jpg],
    ['path-with-spaces-and-cjk', '#visible-input', spaced]
  ]

  for (const [name, selector, file] of cases) {
    const before = (await events(wc)).length
    await inject(wc, selector, file)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const picked = (await events(wc)).slice(before)
    const hit = picked.find((entry) => entry.name === file.split('/').pop())
    log(name, Boolean(hit), { event: hit ?? null })
  }

  // 隐藏的文件框（真实站点常见：input 被 display:none，靠按钮触发）
  const beforeHidden = (await events(wc)).length
  await inject(wc, '#hidden-input', png)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const hiddenPick = (await events(wc)).slice(beforeHidden)
  log('hidden-input', hiddenPick.some((entry) => entry.id === 'hidden-input'), {
    event: hiddenPick[0] ?? null
  })

  // 动态创建的文件框：模拟「先点相机按钮，文件框才出现」
  await wc.executeJavaScript(`document.querySelector('#reveal').click()`)
  const appeared = await waitForSelector(wc, '#late-input')
  log('late-input-appears', appeared)
  if (appeared) {
    const beforeLate = (await events(wc)).length
    await inject(wc, '#late-input', png)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const latePick = (await events(wc)).slice(beforeLate)
    log('late-input-inject', latePick.some((entry) => entry.id === 'late-input'), {
      event: latePick[0] ?? null
    })
  }

  // HEIC 走和产品里同一条路：先 sips 转 PNG，再注入
  const heicPng = convert(heic, 'test-input-from-heic.png', ['-s', 'format', 'png'])
  const beforeHeic = (await events(wc)).length
  await inject(wc, '#visible-input', heicPng)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const heicPick = (await events(wc)).slice(beforeHeic)
  log('heic-transcoded-png', heicPick.length > 0, { event: heicPick[0] ?? null })

  // 注入后 detach，确认不影响页面继续使用
  wc.debugger.detach()
  log('debugger-detach', !wc.debugger.isAttached())
  const afterDetach = await wc.executeJavaScript('document.querySelectorAll("input[type=file]").length')
  log('page-alive-after-detach', afterDetach > 0, { fileInputs: afterDetach })

  console.log('\n夹具：' + fixturePath)
  console.log('测试图：' + ROOT)
}

async function runSiteRecon(wc, url, clickSelector, injectSelector, clickText, clickPoint, filePath, scrollY) {
  console.log(`\n打开 ${url}`)
  const loaded = once(wc, 'did-finish-load', 45_000).then(() => true).catch(() => false)
  void wc.loadURL(url)
  const ok = await loaded
  log('site-load', ok, { url, finalUrl: wc.getURL() })
  if (!ok) return

  await new Promise((resolve) => setTimeout(resolve, 2500))
  if (scrollY) {
    await wc.executeJavaScript(`window.scrollTo(0, ${Number(scrollY) || 0})`)
    await new Promise((resolve) => setTimeout(resolve, 800))
    log('site-scroll', true, { y: Number(scrollY) })
  }
  if (clickPoint) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    for (const point of clickPoint.split(';')) {
      const [x, y] = point.split(',').map((value) => Number(value.trim()))
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      log('site-trigger-click-point', Number.isFinite(x) && Number.isFinite(y), { x, y })
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
  }

  if (clickSelector || clickText) {
    // 单页应用里的按钮常常晚于 did-finish-load 才挂上来，先等它出现
    const started = Date.now()
    while (Date.now() - started < 15_000) {
      const ready = await wc.executeJavaScript(`(() => {
        const selector = ${JSON.stringify(clickSelector ?? null)}
        const wanted = ${JSON.stringify(clickText ?? null)}
        if (selector && document.querySelector(selector)) return true
        if (!wanted) return false
        return [...document.querySelectorAll('button, [role=button], a, label')].some((node) => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && (node.textContent || '').trim().includes(wanted)
        })
      })()`)
      if (ready) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const target = await wc.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(clickSelector ?? null)}
      const wanted = ${JSON.stringify(clickText ?? null)}
      let node = selector ? document.querySelector(selector) : null
      if (!node && wanted) {
        node = [...document.querySelectorAll('button, [role=button], a, label, div')].find((candidate) => {
          const rect = candidate.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return false
          return (candidate.textContent || '').trim() === wanted
        })
      }
      if (!node) {
        node = [...document.querySelectorAll('button, [role=button], a, label')].find((candidate) => {
          const rect = candidate.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return false
          return wanted ? (candidate.textContent || '').trim().includes(wanted) : false
        })
      }
      if (!node) {
        return {
          notFound: true,
          candidates: [...document.querySelectorAll('button, [role=button], a, label')]
            .map((candidate) => (candidate.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 20)
        }
      }
      const rect = node.getBoundingClientRect()
      return {
        tag: node.tagName.toLowerCase(),
        text: (node.textContent || '').trim().slice(0, 20),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      }
    })()`)
    if (target && !target.notFound) {
      wc.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
      wc.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    }
    log('site-trigger-click', Boolean(target), { selector: clickSelector, text: clickText, hit: target })
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }

  const inputs = await wc.executeJavaScript(`(() => {
    return [...document.querySelectorAll('input[type=file]')].map((input) => {
      const rect = input.getBoundingClientRect()
      return {
        id: input.id || null,
        name: input.name || null,
        accept: input.accept || null,
        hidden: rect.width === 0 && rect.height === 0,
        disabled: input.disabled,
        multiple: input.multiple
      }
    })
  })()`)
  log('site-file-inputs', true, inputs)

  const triggers = await wc.executeJavaScript(`(() => {
    const hit = []
    const words = ['相机', '拍照', '搜索', '搜相似', '以图搜图', '上传', 'camera', 'lens', 'upload', 'search by image', 'visual search']
    for (const node of document.querySelectorAll('button, [role=button], a, label')) {
      const text = ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')).trim().toLowerCase()
      if (!text || text.length > 60) continue
      if (words.some((word) => text.includes(word.toLowerCase()))) {
        const rect = node.getBoundingClientRect()
        hit.push({
          tag: node.tagName.toLowerCase(),
          text: text.slice(0, 40),
          id: node.id || null,
          href: node.getAttribute('href') || null,
          rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
        })
      }
    }
    return hit.slice(0, 40)
  })()`)
  log('site-upload-triggers', true, triggers)

  if (process.env.INSPIN_PASTE) {
    const testImage = makeTestImage('paste-test-image.png', 600, 450)
    const bytes = readFileSync(testImage)
    const payload = { 'image/png': new Blob([bytes], { type: 'image/png' }) }
    await clipboard.write([new ClipboardItem(payload)])
    log('clipboard-image', true, { source: testImage, mime: 'image/png' })
    wc.focus()
    wc.paste()
    log('clipboard-paste-sent', true)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    log('paste-result', true, {
      url: wc.getURL(),
      title: await wc.executeJavaScript('document.title'),
      text: await wc.executeJavaScript(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200)`)
    })
  }

  const probes = await wc.executeJavaScript(`(() => {
    const nodes = document.querySelectorAll(
      '[id*=sbi], [class*=sbi], [id*=camera], [class*=camera], [class*=visual], [class*=lens], [class*=upload], [aria-label*="图"], [aria-label*="图片"], [title*="图"], [aria-label*="camera"], [title*="camera"], [aria-label*="搜索图片"], [title*="搜索图片"]'
    )
    return [...nodes].slice(0, 40).map((node) => ({
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      cls: (typeof node.className === 'string' ? node.className : '').slice(0, 60) || null,
      label: node.getAttribute('aria-label') || null,
      title: node.getAttribute('title') || null,
      text: (node.textContent || '').trim().slice(0, 30) || null
    }))
  })()`)
  log('site-dom-probe', true, probes)

  const topRegion = await wc.executeJavaScript(`(() => {
    const out = []
    for (const node of document.querySelectorAll('*')) {
      const rect = node.getBoundingClientRect()
      if (rect.top > 110 || rect.width < 8 || rect.height < 8) continue
      const tag = node.tagName.toLowerCase()
      if (['html', 'body', 'head', 'script', 'style', 'meta'].includes(tag)) continue
      out.push({
        tag,
        id: node.id || null,
        cls: (typeof node.className === 'string' ? node.className : '').slice(0, 50) || null,
        role: node.getAttribute('role') || null,
        label: node.getAttribute('aria-label') || null,
        title: node.getAttribute('title') || null,
        text: (node.textContent || '').trim().slice(0, 24) || null,
        x: Math.round(rect.left),
        y: Math.round(rect.top)
      })
    }
    return out.slice(-60)
  })()`)
  log('site-top-elements', true, topRegion)

  const searchBox = await wc.executeJavaScript(`(() => {
    const form = document.querySelector('#sb_form, form[role=search], form')
    if (!form) return null
    return [...form.querySelectorAll('*')].slice(0, 50).map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        cls: (typeof node.className === 'string' ? node.className : '').slice(0, 50) || null,
        role: node.getAttribute('role') || null,
        label: node.getAttribute('aria-label') || null,
        title: node.getAttribute('title') || null,
        text: (node.textContent || '').trim().slice(0, 24) || null,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    })
  })()`)
  log('site-search-box', true, searchBox)

  const cameraStack = await wc.executeJavaScript(`(() => {
    const q = document.querySelector('#sb_form_q')
    if (!q) return null
    const rect = q.getBoundingClientRect()
    const x = rect.right - 18
    const y = rect.top + rect.height / 2
    return document.elementsFromPoint(x, y).slice(0, 8).map((node) => ({
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      cls: (typeof node.className === 'string' ? node.className : '').slice(0, 50) || null,
      role: node.getAttribute('role') || null,
      label: node.getAttribute('aria-label') || null,
      title: node.getAttribute('title') || null,
      x: Math.round(x),
      y: Math.round(y)
    }))
  })()`)
  log('site-camera-at-point', true, cameraStack)

  if (injectSelector) {
    const testImage = filePath || makeTestImage('site-test-image.png', 600, 450)
    const beforeUrl = wc.getURL()
    await wc.executeJavaScript(`(() => {
      window.__labChanges = []
      document.addEventListener('change', (event) => {
        if (event.target && event.target.type === 'file') {
          window.__labChanges.push({ files: event.target.files.length, value: event.target.value })
        }
      }, true)
    })()`)
    await inject(wc, injectSelector, testImage)
    const changes = await wc.executeJavaScript('window.__labChanges')
    log('site-change-events', changes.length > 0, changes)
    log('site-inject', true, { selector: injectSelector, file: testImage })

    const inputState = await wc.executeJavaScript(`(() => {
      const input = document.querySelector(${JSON.stringify(injectSelector)})
      if (!input) return null
      const reactKey = Object.keys(input).find((key) => key.startsWith('__reactProps') || key.startsWith('__reactFiber'))
      const parent = input.parentElement
      const parentReactKey = parent ? Object.keys(parent).find((key) => key.startsWith('__reactProps') || key.startsWith('__reactFiber')) : null
      return {
        files: input.files.length,
        name: input.files[0] ? input.files[0].name : null,
        size: input.files[0] ? input.files[0].size : 0,
        reactKey: reactKey || null,
        parentTag: parent ? parent.tagName.toLowerCase() : null,
        parentReactKey: parentReactKey || null,
        html: input.outerHTML.slice(0, 200)
      }
    })()`)
    // 很多站点处理完会主动清空 input.files，这里只作观察，不计入成败
    console.log('[INFO] site-input-state ' + JSON.stringify(inputState))
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    log('site-result', wc.getURL() !== beforeUrl, {
      from: beforeUrl,
      to: wc.getURL(),
      title: await wc.executeJavaScript('document.title')
    })
    const visibleText = await wc.executeJavaScript(
      `document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300)`
    )
    console.log('页面文字：' + visibleText)
  }

  const evalArg = process.argv.find((arg) => arg.startsWith('--eval='))
  if (evalArg) {
    const result = await wc.executeJavaScript(evalArg.slice('--eval='.length))
    console.log('[eval] ' + JSON.stringify(result, null, 2))
  }

  console.log('当前地址：' + wc.getURL())
}

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1000,
    height: 780,
    show: true,
    title: 'InsPin 注入实验',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  const view = new WebContentsView({
    webPreferences: {
      // 与 InsPin 内嵌浏览器共用登录分区，Pinterest / 花瓣的登录态可以直接复用
      partition: process.env.INSPIN_LAB_PARTITION || 'persist:inspin-browser',
      preload: process.env.INSPIN_LAB_PRELOAD || undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  view.setBackgroundColor('#ffffff')
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1000, height: 780 })
  const wc = view.webContents

  if (process.env.INSPIN_NETLOG) {
    wc.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      if (!/upload|search|image|visual|lens/i.test(details.url)) return
      console.log('[net]', details.method, details.statusCode, details.url.slice(0, 140))
    })
  }

  const siteArg = process.argv.find((arg) => arg.startsWith('--site='))
  const clickArg = process.argv.find((arg) => arg.startsWith('--click='))
  const urlArg = process.argv.find((arg) => arg.startsWith('--url='))
  const injectArg = process.argv.find((arg) => arg.startsWith('--inject='))
  const clickTextArg = process.argv.find((arg) => arg.startsWith('--click-text='))
  const clickPointArg = process.argv.find((arg) => arg.startsWith('--click-point='))
  const fileArg = process.argv.find((arg) => arg.startsWith('--file='))
  const scrollArg = process.argv.find((arg) => arg.startsWith('--scroll='))

  const SITES = {
    google: 'https://lens.google.com/',
    bing: 'https://www.bing.com/visualsearch',
    pinterest: 'https://www.pinterest.com/',
    huaban: 'https://huaban.com/'
  }

  try {
    if (siteArg || urlArg) {
      const url = urlArg ? urlArg.slice('--url='.length) : SITES[siteArg.slice('--site='.length)]
      if (!url) throw new Error(`未知站点：${siteArg}`)
      await runSiteRecon(
        wc,
        url,
        clickArg ? clickArg.slice('--click='.length) : null,
        injectArg ? injectArg.slice('--inject='.length) : null,
        clickTextArg ? clickTextArg.slice('--click-text='.length) : null,
        clickPointArg ? clickPointArg.slice('--click-point='.length) : null,
        fileArg ? fileArg.slice('--file='.length) : null,
        scrollArg ? scrollArg.slice('--scroll='.length) : null
      )
      const holdArg = process.argv.find((arg) => arg.startsWith('--hold='))
      if (holdArg) {
        // 登录模式：窗口留到用户手动关掉，方便在实验分区里登录一次
        const minutes = Number(holdArg.slice('--hold='.length)) || 5
        console.log(`窗口保留 ${minutes} 分钟，登录完成后直接关闭窗口即可。`)
        win.on('closed', () => app.exit(failedCount() === 0 ? 0 : 1))
        await new Promise((resolve) => setTimeout(resolve, minutes * 60_000))
      } else {
        // 站点勘察模式下窗口留一会儿，方便肉眼确认页面状态
        await new Promise((resolve) => setTimeout(resolve, 15_000))
      }
    } else {
      const loaded = once(wc, 'did-finish-load')
      void wc.loadURL(`file://${fixturePath}`)
      await loaded
      await runFixtureExperiment(wc)
    }
  } catch (error) {
    log('experiment-crashed', false, { message: error instanceof Error ? error.message : String(error) })
  }

  try {
    const shot = await wc.capturePage()
    const shotPath = join(ROOT, 'last-screen.png')
    writeFileSync(shotPath, shot.toPNG())
    console.log('截图：' + shotPath)
  } catch {
    // 截图只是辅助证据，不影响结论
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
  setTimeout(() => app.exit(failed.length === 0 ? 0 : 1), 200)
}

void main()
