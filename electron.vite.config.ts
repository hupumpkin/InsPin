import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // 两个 preload 不能共同引用运行时模块：沙箱 preload 只能加载 electron 和
          // 内置模块，共享模块会被拆成 chunks/ 下的相对文件，导致两个都加载失败。
          browser: resolve(__dirname, 'src/browser-preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // 参考快照浮窗是独立窗口，自带一份页面（D5.1）
          snapshot: resolve(__dirname, 'src/renderer/snapshot.html'),
          // 钉住图的右键设置菜单也是独立浮窗，尺寸不随图片缩放。
          'snapshot-menu': resolve(__dirname, 'src/renderer/snapshot-menu.html')
        }
      }
    }
  }
})
