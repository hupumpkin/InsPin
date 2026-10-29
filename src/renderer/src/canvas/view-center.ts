/**
 * 画布视口中心（世界坐标）。
 *
 * 只有一个用途：区域截图落下来时摆在哪（D3.16）——要让刚截的那张图正好出现在
 * 用户眼前，而不是按序号错开到别处。
 *
 * 特意**不放进 store**：视口每帧都在变，走 store 会让订阅者跟着重渲染。
 * 这里就是一个模块级变量，谁需要谁现取。
 */

let center = { x: 0, y: 0 }

export function setViewCenter(next: { x: number; y: number }): void {
  center = next
}

export function viewCenter(): { x: number; y: number } {
  return center
}
