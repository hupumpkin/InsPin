import { readFile, rename, writeFile } from 'node:fs/promises'

/** 同一临时文件不能并发写；连续标签状态变更按顺序落盘，最后一次始终保留。 */
let writeQueue: Promise<void> = Promise.resolve()

/**
 * 标签的落盘（路线图 D3.4 会话恢复）。
 *
 * 放在 `sessions/browser-tabs.json`（与浏览器登录态同目录）。写盘走
 * "临时文件 + 改名"，中途被杀不会留下半个文件被当成有效数据读回来。
 * 读回来的内容一律交给 `deserializeTabs` 做校验——坏数据宁可丢掉。
 */

export async function loadBrowserTabs(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    // 文件不存在（第一次启动）、或内容坏了：都当没有存过
    return null
  }
}

export function saveBrowserTabs(file: string, raw: unknown): Promise<void> {
  const payload = JSON.stringify(raw)
  const task = writeQueue.then(async () => {
    const temp = `${file}.tmp`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, file)
  })
  writeQueue = task.catch(() => undefined)
  return task
}
