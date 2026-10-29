import { readFile, rename, writeFile } from 'node:fs/promises'
import { normalizeSettings, type AppSettings } from '../shared/settings'

/**
 * 设置落盘：数据目录根下的 `settings.json`。
 *
 * 和面板偏好一样走"临时文件 + 改名"，写到一半被杀不会留下半个文件。
 * 读回来一律过 `normalizeSettings`，坏数据宁可回到默认，也不能让应用打不开。
 */
export async function loadSettings(file: string): Promise<AppSettings> {
  try {
    return normalizeSettings(JSON.parse(await readFile(file, 'utf8')) as unknown)
  } catch {
    return normalizeSettings(null)
  }
}

/**
 * 写盘排队：连续改两次设置（比如拖色板）时，两个 IPC 可能同时在写同一个
 * `.tmp`。不排队的话后一个可能被前一个的 rename 覆盖，界面刚改的值又弹回去。
 */
let writeQueue: Promise<void> = Promise.resolve()

export function saveSettings(file: string, settings: AppSettings): Promise<void> {
  const payload = JSON.stringify(settings, null, 2)
  const task = writeQueue.then(async () => {
    const temp = `${file}.tmp`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, file)
  })
  writeQueue = task.catch(() => undefined)
  return task
}
