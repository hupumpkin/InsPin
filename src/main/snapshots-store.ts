import { readFile, rename, writeFile } from 'node:fs/promises'
import { reviveSnapshotRecord, type SnapshotRecord } from '../shared/snapshot'

/**
 * 参考快照的落盘（D5.6 重启恢复）。
 *
 * 放在 `sessions/snapshots.json`，与面板偏好、标签同目录。内容本身（盒子 + 素材信息）
 * 已经冻结在记录里，所以重启后不需要源项目也在，就能把浮窗原样摆回来。
 *
 * 写盘走"临时文件 + 改名"，中途被杀不会留下半个文件；读回来一律过
 * `reviveSnapshotRecord`，坏的那条丢掉、好的照常恢复。
 */

export async function loadSnapshots(file: string): Promise<SnapshotRecord[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    // 文件不存在（第一次启动）或内容坏了：都当没存过
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => reviveSnapshotRecord(entry))
    .filter((entry): entry is SnapshotRecord => entry !== null)
}

export async function saveSnapshots(file: string, records: SnapshotRecord[]): Promise<void> {
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(records), 'utf8')
  await rename(temp, file)
}
