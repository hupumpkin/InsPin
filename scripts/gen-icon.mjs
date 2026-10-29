// 生成应用图标 build/icon.png（1024×1024），electron-builder 会把它转成 .icns。
// 颜色取自设计规范：深灰 --control (#3D414D) 底 + 白色钉子，与界面内的品牌标记一致
// （设计规范里 .bmark 就是"白图标 + --control 底"）。刻意不做彩色，保持整套视觉零彩度。
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePNG } from './png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const buildDir = join(here, '..', 'build')
mkdirSync(buildDir, { recursive: true })

// 品牌图标由设计提供，放在仓库的 design-assets/icons 下；存在时直接采用。
// 该 PNG 必须是 1024×1024、四角透明、已带 macOS 圆角遮罩（824×824 主体居中）的成品：
// 程序坞不会替应用裁圆角，整块底色导出就会显示成方块。
// 下面的程序化绘制只作为没有品牌资源时的兜底。
const brandIcon = join(here, '..', '..', 'design-assets', 'icons', 'inspin-dock.png')
if (existsSync(brandIcon)) {
  copyFileSync(brandIcon, join(buildDir, 'icon.png'))
  console.log('使用品牌图标 design-assets/icons/inspin-dock.png')
  process.exit(0)
}

const S = 1024
const R = 228 // macOS 圆角近似
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
const mix = (a, b, t) => a + (b - a) * t

function roundedCoverage(x, y) {
  const cx = Math.min(Math.max(x, R), S - R)
  const cy = Math.min(Math.max(y, R), S - R)
  const d = Math.hypot(x - cx, y - cy)
  if (d <= R - 1) return 1
  if (d >= R + 1) return 0
  return 1 - (d - (R - 1)) / 2
}

// 钉子：实心圆头 + 收细的针身
const HEAD = { x: 512, y: 392, r: 150 }
function pinCoverage(x, y) {
  if (Math.hypot(x - HEAD.x, y - HEAD.y) <= HEAD.r) return 1
  const topY = HEAD.y + HEAD.r - 40
  const botY = 792
  if (y < topY || y > botY) return 0
  const t = (y - topY) / (botY - topY)
  const halfW = mix(46, 0, t * t)
  return Math.abs(x - 512) <= halfW ? 1 : 0
}

// 底色 #3D414D，右下略深一点做体积感
const BG_TOP = [66, 70, 83]
const BG_BOTTOM = [46, 50, 60]

const png = encodePNG(S, S, (x, y) => {
  const bg = roundedCoverage(x, y)
  if (bg <= 0) return [0, 0, 0, 0]

  const t = (x / S) * 0.3 + (y / S) * 0.7
  const base = [
    clamp(mix(BG_TOP[0], BG_BOTTOM[0], t)),
    clamp(mix(BG_TOP[1], BG_BOTTOM[1], t)),
    clamp(mix(BG_TOP[2], BG_BOTTOM[2], t))
  ]
  const pin = pinCoverage(x, y)
  if (pin > 0) return [255, 255, 255, clamp(255 * bg)]
  return [base[0], base[1], base[2], clamp(255 * bg)]
})

const target = join(buildDir, 'icon.png')
writeFileSync(target, png)
console.log(`icon written: ${target}`)
