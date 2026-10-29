/**
 * 网页打不开时给用户看的话（路线图 D3.2 的"错误页"，D3.14 的文案原则：
 * "发生了什么 → 为什么 → 可以怎么做"，**不暴露 `ERR_*` 这种底层报错**）。
 */

export interface LoadErrorCopy {
  title: string
  reason: string
  hint: string
}

/** Chromium 的 net error code → 人话。 */
const BY_CODE: Record<string, LoadErrorCopy> = {
  '-105': {
    title: '打不开这个网址',
    reason: '找不到这个网站，可能是地址拼错了，或者网站已经关掉了。',
    hint: '检查一下地址；也可以从浏览器里复制完整链接再试。'
  },
  '-106': {
    title: '网络好像断了',
    reason: '这台电脑现在连不上网。',
    hint: '看看 Wi-Fi 或网线；恢复网络后点地址栏右边的刷新。'
  },
  '-7': {
    title: '连接超时',
    reason: '网站一直没回应，可能是网络太慢或对方暂时不可用。',
    hint: '等一下再试，或者换一个地址。'
  },
  '-102': {
    title: '网站拒绝了连接',
    reason: '服务器在，但没有接受这次访问。',
    hint: '稍后再试；如果一直这样，可能是对方限制了访问。'
  },
  '-118': {
    title: '连接超时',
    reason: '网络请求等太久没有回应。',
    hint: '检查网络后重试。'
  },
  '-201': {
    title: '这个网站的安全证书有问题',
    reason: '证书不可信，浏览器为了安全没有继续。',
    hint: '确认网址没写错；不确定的话先别继续访问。'
  },
  '-501': {
    title: '这个网站的安全证书有问题',
    reason: '证书不可信，浏览器为了安全没有继续。',
    hint: '确认网址没写错；不确定的话先别继续访问。'
  },
  '-3': {
    title: '已停止加载',
    reason: '这次加载被取消了。',
    hint: '点刷新可以重新加载。'
  }
}

const GENERIC: LoadErrorCopy = {
  title: '打不开这个页面',
  reason: '网页没有正常加载完成。',
  hint: '检查网络后点刷新重试；也可以换一个地址。'
}

export function describeLoadError(code: number): LoadErrorCopy {
  return BY_CODE[String(code)] ?? GENERIC
}

/** 错误页的 HTML（白底、居中一段人话）。 */
export function errorPageHtml(code: number, url: string): string {
  const copy = describeLoadError(code)
  const shown = url.replace(/[<>&"]/g, '')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>${copy.title}</title>
<style>
  :root { color-scheme: light }
  body { margin: 0; height: 100vh; display: grid; place-items: center;
         background: #ffffff; color: #171a26;
         font: 14px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", Arial, sans-serif; }
  .box { max-width: 360px; padding: 24px; text-align: center }
  h1 { margin: 0 0 8px; font-size: 16px; font-weight: 600 }
  p { margin: 0 0 6px; color: #6B7078 }
  .url { margin-top: 14px; font-size: 12px; color: #6B7078; word-break: break-all }
</style></head>
<body><div class="box">
  <h1>${copy.title}</h1>
  <p>${copy.reason}</p>
  <p>${copy.hint}</p>
  <div class="url">${shown}</div>
</div></body></html>`
}

export function errorPageDataUrl(code: number, url: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(errorPageHtml(code, url))}`
}
