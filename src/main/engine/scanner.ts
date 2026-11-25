import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isIncluded, normalizeRelPath } from '../../core/paths'
import { MAX_FILES_PER_SNAPSHOT } from '../../core/validate'

export const TMP_SUFFIX = '.ce-tmp'

export interface ScannedFile {
  path: string
  size: number
  mtimeMs: number
}

export interface Scan {
  files: ScannedFile[]
  /** Cheap stat signature; changes whenever any included file's size/mtime/name changes. */
  sig: string
  skipped: string[]
}

/** Stat-only scan of included regular files. Links are never followed. */
export async function scanFolder(root: string, include: string[], exclude: string[]): Promise<Scan> {
  const files: ScannedFile[] = []
  const skipped: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.name.endsWith(TMP_SUFFIX)) continue
      if (entry.isSymbolicLink()) {
        skipped.push(`${relPath} (link)`)
        continue
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relPath)
      } else if (entry.isFile()) {
        if (!isIncluded(relPath, include, exclude)) continue
        if (!normalizeRelPath(relPath)) {
          skipped.push(`${relPath} (unsupported name)`)
          continue
        }
        const st = await lstat(join(dir, entry.name))
        files.push({ path: relPath, size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
        if (files.length > MAX_FILES_PER_SNAPSHOT) throw new Error(`More than ${MAX_FILES_PER_SNAPSHOT} files in save folder`)
      }
    }
  }
  await walk(root, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const sig = createHash('sha256')
    .update(files.map((f) => `${f.path}\0${f.size}\0${f.mtimeMs}`).join('\n'))
    .digest('hex')
  return { files, sig, skipped }
}

export function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let size = 0
    createReadStream(path)
      .on('data', (chunk: string | Buffer) => {
        size += chunk.length
        hash.update(chunk)
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), size }))
  })
}
