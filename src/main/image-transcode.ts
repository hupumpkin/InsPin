import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 浏览器与 nativeImage 都不解码的格式，交给系统 `sips` 转一次。 */
const TRANSCODE_EXTENSIONS = new Set(['.heic', '.heif', '.tif', '.tiff'])

export function needsTranscode(filePath: string): boolean {
  return TRANSCODE_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/** 把 HEIC/TIFF 转成 PNG 字节；转换失败时抛错，由调用方给用户提示。 */
export async function transcodeToPng(sourcePath: string): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'inspin-transcode-'))
  const outputPath = join(dir, 'converted.png')
  try {
    await run('/usr/bin/sips', ['-s', 'format', 'png', sourcePath, '--out', outputPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
    return new Uint8Array(await readFile(outputPath))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
