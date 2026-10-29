import type { Rectangle, WebContents } from 'electron'
import type { CaptureCandidate } from '../shared/capture-candidates'

/** 只读当前视口的元素几何；不返回网页文字、地址或属性，也不往网页挂常驻节点。 */
export const PAGE_CANDIDATES_SCRIPT = `(() => {
  const mediaSelector = 'img, video, canvas, svg, picture, iframe';
  const semanticSelector = 'a[href], article, figure, li, [role="article"], [role="listitem"]';
  const candidates = new Set();
  const mediaOwners = new Set();
  const add = (element) => { if (element instanceof Element) candidates.add(element); };

  for (const media of document.querySelectorAll(mediaSelector)) {
    let current = media;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      add(current);
      mediaOwners.add(current);
    }
  }
  for (const element of document.querySelectorAll(semanticSelector)) add(element);

  const viewportWidth = Math.max(1, window.innerWidth);
  const viewportHeight = Math.max(1, window.innerHeight);
  const viewportArea = viewportWidth * viewportHeight;
  const bestByRect = new Map();

  // 采集到的是卡片中的一张图时，锚点应指向作品详情，不应误指向作者主页、搜索或登录页。
  const sourceUrlFor = (element, primaryImage) => {
    const links = new Set();
    const add = (link) => { if (link instanceof HTMLAnchorElement && link.href) links.add(link); };
    if (element instanceof HTMLAnchorElement) add(element);
    add(element.closest('a[href]'));
    if (primaryImage) add(primaryImage.closest('a[href]'));
    for (const link of element.querySelectorAll('a[href]')) add(link);

    let best = null;
    let bestScore = -Infinity;
    for (const link of links) {
      let url;
      try { url = new URL(link.href); } catch { continue; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      // 采集页里的外链通常是作者官网或广告，不是当前平台上的作品帖；宁可回退列表页。
      if (url.origin !== location.origin) continue;
      const path = url.pathname.toLowerCase();
      if (/\\/(?:profile|user|users|people|search|login|signup|following|followers)(?:\\/|$)/.test(path)) continue;
      let score = 0;
      if (primaryImage && link.contains(primaryImage)) score += 80;
      if (link === element || link.contains(element)) score += 40;
      // Behance 的作品详情稳定使用 /gallery/；其它主流站点也优先常见的详情路径。
      if (/\\/(?:gallery|project|shots|pin|post|artwork)(?:\\/|$)/.test(path)) score += 120;
      score += 12;
      if (path === '/' || path.length < 3) score -= 80;
      if (score > bestScore) { bestScore = score; best = url.href; }
    }
    return bestScore >= 35 ? best : null;
  };

  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewportWidth, rect.right);
    const bottom = Math.min(viewportHeight, rect.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width < 32 || height < 32) continue;

    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) continue;

    const tag = element.tagName.toLowerCase();
    const isMedia = element.matches(mediaSelector);
    const isSemantic = element.matches(semanticSelector);
    const hasVisibleBorder =
      (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none') ||
      (parseFloat(style.borderRightWidth) > 0 && style.borderRightStyle !== 'none') ||
      (parseFloat(style.borderBottomWidth) > 0 && style.borderBottomStyle !== 'none') ||
      (parseFloat(style.borderLeftWidth) > 0 && style.borderLeftStyle !== 'none');
    const hasRoundedCorner = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius
    ].some((radius) => parseFloat(radius) > 0);
    const hasSurface =
      style.overflow !== 'visible' ||
      style.overflowX !== 'visible' ||
      style.overflowY !== 'visible' ||
      hasRoundedCorner ||
      hasVisibleBorder ||
      style.boxShadow !== 'none' ||
      (style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)');
    if (!isMedia && !isSemantic && !hasSurface) continue;

    const candidateArea = width * height;
    let originalUrl = null;
    let originalCoverage = 0;
    let primaryImage = null;
    for (const media of document.querySelectorAll('img')) {
      if (!(media instanceof HTMLImageElement)) continue;
      const mediaRect = media.getBoundingClientRect();
      const mediaLeft = Math.max(left, mediaRect.left, 0);
      const mediaTop = Math.max(top, mediaRect.top, 0);
      const mediaRight = Math.min(right, mediaRect.right, viewportWidth);
      const mediaBottom = Math.min(bottom, mediaRect.bottom, viewportHeight);
      const coverage = Math.max(0, mediaRight - mediaLeft) * Math.max(0, mediaBottom - mediaTop) / candidateArea;
      const url = media.currentSrc || media.src;
      if (coverage > originalCoverage && /^https?:\\/\\//i.test(url)) {
        originalCoverage = coverage;
        originalUrl = url;
        primaryImage = media;
      }
    }
    const sourceUrl = sourceUrlFor(element, primaryImage);

    let priority = 0;
    if (isMedia) priority += 38;
    if (isSemantic) priority += 80;
    if (tag === 'a') priority += 30;
    if (mediaOwners.has(element) && !isMedia) priority += 26;
    if (hasSurface && !isMedia) priority += 28;
    if (width * height > viewportArea * 0.82 && tag !== 'iframe') priority -= 110;

    const key = [Math.round(left), Math.round(top), Math.round(width), Math.round(height)].join(':');
    const previous = bestByRect.get(key);
    if (!previous || previous.priority < priority) {
      bestByRect.set(key, {
        x: left,
        y: top,
        width,
        height,
        priority,
        originalUrl: originalCoverage >= 0.88 ? originalUrl : null,
        sourceUrl
      });
    }
  }

  return {
    viewportWidth,
    viewportHeight,
    candidates: [...bestByRect.values()]
      .sort((a, b) => b.priority - a.priority || a.width * a.height - b.width * b.height)
      .slice(0, 260)
  };
})()`

interface PageCandidate {
  x: number
  y: number
  width: number
  height: number
  priority: number
  originalUrl: string | null
  sourceUrl: string | null
}

interface PageCandidateResult {
  viewportWidth: number
  viewportHeight: number
  candidates: PageCandidate[]
}

export interface CaptureCandidateCollection {
  candidates: CaptureCandidate[]
  originalUrls: Map<string, string>
  /** 详情页锚点只在主进程中保存，界面只接收几何信息。 */
  sourceUrls: Map<string, string>
  /** 采样时网页的 CSS 视口尺寸；把指针 / 高亮框换算到窗口坐标时要用。 */
  viewportWidth: number
  viewportHeight: number
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function pageCandidateResult(value: unknown): PageCandidateResult | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const viewportWidth = number(raw['viewportWidth'])
  const viewportHeight = number(raw['viewportHeight'])
  if (!viewportWidth || !viewportHeight || viewportWidth <= 0 || viewportHeight <= 0) return null
  if (!Array.isArray(raw['candidates'])) return null

  const candidates = raw['candidates'].flatMap((item): PageCandidate[] => {
    if (!item || typeof item !== 'object') return []
    const rawCandidate = item as Record<string, unknown>
    const x = number(rawCandidate['x'])
    const y = number(rawCandidate['y'])
    const width = number(rawCandidate['width'])
    const height = number(rawCandidate['height'])
    const priority = number(rawCandidate['priority'])
    const originalUrl = typeof rawCandidate['originalUrl'] === 'string' ? rawCandidate['originalUrl'] : null
    const sourceUrl = typeof rawCandidate['sourceUrl'] === 'string' ? rawCandidate['sourceUrl'] : null
    if (x === null || y === null || width === null || height === null || priority === null) return []
    return [{ x, y, width, height, priority, originalUrl, sourceUrl }]
  })
  return { viewportWidth, viewportHeight, candidates }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

/** 把网页视口坐标转换成主窗口坐标；第三方页面返回的数值会在这里二次夹紧。 */
export function toCaptureCandidates(value: unknown, box: Rectangle): CaptureCandidateCollection {
  const result = pageCandidateResult(value)
  if (!result || box.width <= 0 || box.height <= 0) {
    return {
      candidates: [],
      originalUrls: new Map(),
      sourceUrls: new Map(),
      viewportWidth: 1,
      viewportHeight: 1
    }
  }

  const scaleX = box.width / result.viewportWidth
  const scaleY = box.height / result.viewportHeight
  const right = box.x + box.width
  const bottom = box.y + box.height
  const unique = new Map<
    string,
    Omit<CaptureCandidate, 'id'> & { originalUrl: string | null; sourceUrl: string | null }
  >()

  for (const candidate of result.candidates) {
    const left = clamp(box.x + candidate.x * scaleX, box.x, right)
    const top = clamp(box.y + candidate.y * scaleY, box.y, bottom)
    const candidateRight = clamp(box.x + (candidate.x + candidate.width) * scaleX, box.x, right)
    const candidateBottom = clamp(box.y + (candidate.y + candidate.height) * scaleY, box.y, bottom)
    const width = candidateRight - left
    const height = candidateBottom - top
    if (width < 32 || height < 32) continue

    const item = {
      x: left,
      y: top,
      width,
      height,
      priority: Math.round(candidate.priority),
      originalUrl: candidate.originalUrl,
      sourceUrl: candidate.sourceUrl
    }
    const key = [Math.round(left), Math.round(top), Math.round(width), Math.round(height)].join(':')
    const previous = unique.get(key)
    if (!previous || previous.priority < item.priority) unique.set(key, item)
  }

  const originalUrls = new Map<string, string>()
  const sourceUrls = new Map<string, string>()
  const candidates = [...unique.values()]
    .sort((a, b) => b.priority - a.priority || a.width * a.height - b.width * b.height)
    .slice(0, 260)
    .map((candidate, index) => {
      const id = `capture-${index}`
      if (candidate.originalUrl) originalUrls.set(id, candidate.originalUrl)
      if (candidate.sourceUrl) sourceUrls.set(id, candidate.sourceUrl)
      return {
        id,
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        priority: candidate.priority,
        ...(candidate.originalUrl ? { originalAvailable: true } : {})
      }
    })
  return {
    candidates,
    originalUrls,
    sourceUrls,
    viewportWidth: result.viewportWidth,
    viewportHeight: result.viewportHeight
  }
}

export async function collectCaptureCandidates(webContents: WebContents, box: Rectangle): Promise<CaptureCandidateCollection> {
  try {
    // 页面持续 loading 时 Electron 会延后执行注入脚本；智能吸附不能拖慢普通截图。
    const raw = await Promise.race([
      webContents.executeJavaScriptInIsolatedWorld(999, [{ code: PAGE_CANDIDATES_SCRIPT }]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 240))
    ])
    return toCaptureCandidates(raw, box)
  } catch {
    // 某些受保护页、PDF 查看器或刚卸载的页面不允许脚本执行：自由框选仍完整可用。
    return {
      candidates: [],
      originalUrls: new Map(),
      sourceUrls: new Map(),
      viewportWidth: 1,
      viewportHeight: 1
    }
  }
}
