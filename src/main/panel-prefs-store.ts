import { readFile, rename, writeFile } from 'node:fs/promises'
import { normalizePanelPrefs, type PanelPrefs } from '../shared/panel'

/**
 * 面板偏好的落盘（D3.6 记住你停靠在哪、拖了多宽）。
 *
 * 放在 `sessions/browser-panel.json`，与标签、登录态同目录。写盘走"临时文件 +
 * 改名"，中途被杀不会留下半个文件；读回来一律过 `normalizePanelPrefs`，
 * 坏数据宁可回到默认，也不能让应用打不开。
 */

export async function loadPanelPrefs(file: string): Promise<PanelPrefs> {
  try {
    return normalizePanelPrefs(JSON.parse(await readFile(file, 'utf8')) as unknown)
  } catch {
    // 文件不存在（第一次启动）或内容坏了：都当没存过
    return normalizePanelPrefs(null)
  }
}

export async function savePanelPrefs(file: string, prefs: PanelPrefs): Promise<void> {
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(prefs), 'utf8')
  await rename(temp, file)
}
