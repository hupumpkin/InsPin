/**
 * 「数据与备份」设置页（D6a.1 / D6a.2 / D6a.3 + D6b.1）要用的共用类型。
 *
 * 主进程算、界面显示；形状放在 shared 里两边共用一份。
 */

/** 设置页要显示的本机信息。 */
export interface AppDataInfo {
  /** 数据根目录（给用户看，也能一键在访达里打开） */
  dataRoot: string
  appVersion: string
}

/** 素材体检的逐条结果（只带界面要显示的字段，不暴露绝对路径）。 */
export interface MissingAssetInfo {
  projectName: string
  nodeName: string
}

/** 托管素材的占用（原图字节数；不含缩略图缓存）。 */
export interface LibraryUsage {
  managedCount: number
  managedBytes: number
  /** 其中"长期保留"的部分：从 Finder / 剪贴板导入或从素材库放进画布的素材 */
  permanentCount: number
  permanentBytes: number
  trashCount: number
  trashBytes: number
}

export interface HealthReport {
  /** 检查了多少个素材节点 */
  checkedNodes: number
  /** 涉及多少个素材文件 */
  checkedAssets: number
  /** 文件已经不在磁盘上的那些（界面只显示前若干条） */
  missing: MissingAssetInfo[]
  /** 缺失素材按库里的记录算占多少字节 */
  missingBytes: number
}

/**
 * 「做一件事」的结果：一律带一句能直接显示给用户的话。
 * 成功也可能有细节（备份到哪了、导出了几条），放 `detail`。
 */
export type MaintenanceResult =
  | { ok: true; message: string; detail?: string }
  /** 失败也允许带 `detail`：体检要列清哪些对象丢了素材 */
  | { ok: false; message: string; detail?: string }
