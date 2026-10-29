import Coloris from '@melloware/coloris'
import '@melloware/coloris/dist/coloris.css'

/**
 * 全局只初始化一次。Coloris 的取色面板是单例，动态挂载的 `[data-coloris]`
 * 输入框通过它的 document 级委托自动生效，组件里不用再逐个绑定。
 */
Coloris.init()
Coloris({
  wrap: false,
  alpha: false,
  format: 'hex',
  theme: 'default',
  themeMode: 'light',
  focusInput: true,
  selectInput: true,
  a11y: {
    open: '打开取色器',
    close: '关闭取色器',
    clear: '清除颜色',
    marker: '饱和度：{s}。明度：{v}。',
    hueSlider: '色相',
    alphaSlider: '不透明度',
    input: '颜色值',
    format: '颜色格式',
    swatch: '色块',
    instruction: '饱和度和明度选择区。用方向键调整。'
  }
} as Partial<Parameters<typeof Coloris>[0]> as Parameters<typeof Coloris>[0])

export function closeColorPicker(): void {
  Coloris.close()
}
