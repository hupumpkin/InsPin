import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactHomePath, redactText } from './redact'

export interface DiagnosticAppInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
}

export interface DiagnosticLogFile {
  name: string
  /** 已脱敏的日志原文，一行一条 JSON */
  lines: string[]
}

export interface DiagnosticBundle {
  generatedAt: string
  note: string
  app: DiagnosticAppInfo
  dataRoot: string
  summary: { logFiles: number; logLines: number; errorLines: number }
  logFiles: DiagnosticLogFile[]
}

/** 诊断包文件名里的时间戳，如 `2026-10-14-1230`。 */
export function stampForFileName(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** 只读 `logs/` 下的 `.jsonl`，不碰素材、缩略图、数据库与会话目录。 */
export async function collectLogFiles(logDir: string): Promise<{ name: string; lines: string[] }[]> {
  let names: string[]
  try {
    names = await readdir(logDir)
  } catch {
    return []
  }

  const jsonl = names.filter((name) => name.endsWith('.jsonl')).sort()
  const files: { name: string; lines: string[] }[] = []
  for (const name of jsonl) {
    const raw = await readFile(join(logDir, name), 'utf8')
    files.push({ name, lines: raw.split('\n').filter((line) => line.length > 0) })
  }
  return files
}

function countErrors(lines: string[]): number {
  let errors = 0
  for (const line of lines) {
    try {
      if ((JSON.parse(line) as { level?: string }).level === 'error') errors += 1
    } catch {
      // 坏行不计入，也不影响导出
    }
  }
  return errors
}

/**
 * 组装诊断包。**只包含**应用信息与脱敏后的日志：
 * 不含图片、Cookie、会话文件，也不含完整网址。
 */
export function buildDiagnosticBundle(input: {
  generatedAt: string
  app: DiagnosticAppInfo
  dataRoot: string
  logFiles: { name: string; lines: string[] }[]
  /** 测试可注入；默认取当前用户主目录 */
  homeDir?: string
}): DiagnosticBundle {
  const homeDir = input.homeDir ?? homedir()
  const clean = (text: string): string => redactHomePath(redactText(text), homeDir)
  const logFiles = input.logFiles.map((file) => ({
    name: file.name,
    lines: file.lines.map(clean)
  }))
  const logLines = logFiles.reduce((total, file) => total + file.lines.length, 0)
  const errorLines = logFiles.reduce((total, file) => total + countErrors(file.lines), 0)

  return {
    generatedAt: input.generatedAt,
    note: '本诊断包已脱敏：完整网址已替换为「域名 + 哈希」，用户主目录已隐藏；不含图片、Cookie 与登录信息。',
    app: input.app,
    dataRoot: clean(input.dataRoot),
    summary: { logFiles: logFiles.length, logLines, errorLines },
    logFiles
  }
}
