export type ReleaseChannel = 'internal' | 'stable'

export interface ReleaseConfig {
  channel: ReleaseChannel
  /** 设置页、日志里给用户看的渠道名 */
  displayName: string
  /** 渠道标签，如「内测版」 */
  channelLabel: string
  appId: string
  /** 用户数据目录名，内部版与正式版必须不同 */
  dataDirectoryName: string
  /** 反馈入口；null 表示走应用内固定说明 */
  feedbackUrl: string | null
  /** 最新版获取页面；null 表示暂不提供在线检查 */
  updatePageUrl: string | null
}

export const RELEASE_CONFIGS: Record<ReleaseChannel, ReleaseConfig> = {
  internal: {
    channel: 'internal',
    displayName: 'InsPin 内测版',
    channelLabel: '内测版',
    appId: 'com.inspin.internal',
    dataDirectoryName: 'InsPin-Internal',
    feedbackUrl: null,
    updatePageUrl: null
  },
  stable: {
    channel: 'stable',
    displayName: 'InsPin',
    channelLabel: '正式版',
    appId: 'com.inspin.app',
    dataDirectoryName: 'InsPin',
    feedbackUrl: null,
    updatePageUrl: null
  }
}

/** 当前构建的发布渠道。正式渠道首次发布前，所有构建都属于 internal。 */
export const RELEASE_CHANNEL: ReleaseChannel = 'internal'

export const currentRelease = RELEASE_CONFIGS[RELEASE_CHANNEL]
