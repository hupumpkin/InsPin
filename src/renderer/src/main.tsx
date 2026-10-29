// PixiJS 的 WebGL 渲染器默认用 `new Function()` 生成着色器代码，而画布页面的 CSP
// 不允许 unsafe-eval（index.html 里那条）。这个模块把那条路换成**不用 eval** 的实现，
// 是 Pixi 官方给 CSP 受限环境的方案。必须在创建 Application 之前导入。
import 'pixi.js/unsafe-eval'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installErrorReporting } from './error-reporting'
import './coloris'
import './styles/tokens.css'
import './styles/app.css'

installErrorReporting()

const host = document.getElementById('root')
if (!host) throw new Error('#root not found')

createRoot(host).render(<App />)
