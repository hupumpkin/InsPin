import { createHash } from 'node:crypto'

/**
 * 导出诊断包时的脱敏。只在这里做，本机日志里保留完整 URL（排查靠它）。
 * 规则：完整网址 → `域名/8位哈希`，域名保留以便判断是哪个站点，路径与查询串不可读。
 */

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.host}/${shortHash(raw)}`
  } catch {
    return `<url:${shortHash(raw)}>`
  }
}

/** 把一段文本里出现的所有完整网址替换为脱敏形式。 */
export function redactText(text: string): string {
  return text.replace(URL_PATTERN, (matched) => redactUrl(matched))
}

/** 把用户主目录替换成 `~`，避免诊断包带出用户名和绝对路径。 */
export function redactHomePath(text: string, homeDir: string): string {
  if (!homeDir) return text
  return text.split(homeDir).join('~')
}
