// Journaled replacement of the live save folder. Every file that is replaced or
// removed is backed up first; an interrupted apply is rolled back on next start.

import { copyFile, mkdir, readFile, realpath, rename, rm, unlink, utimes } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { normalizeRelPath } from '../../core/paths'
import type { FileEntry } from '../../core/types'
import { TMP_SUFFIX, scanFolder } from './scanner'
import type { WorldStore } from './store'
import { writeJsonAtomic } from './store'

interface Journal {
  root: string
  backupDir: string
  /** Live files (relative) that existed before the apply and are in backupDir. */
  previous: string[]
}

/** Resolves a relative path inside root, refusing anything that escapes it (including via links). */
async function safeTarget(root: string, rel: string): Promise<string> {
  const norm = normalizeRelPath(rel)
  if (!norm) throw new Error(`Unsafe path in snapshot: ${rel}`)
  const realRoot = await realpath(root)
  const target = resolve(realRoot, ...norm.split('/'))
  if (!target.startsWith(realRoot + sep)) throw new Error(`Path escapes save folder: ${rel}`)
  await mkdir(dirname(target), { recursive: true })
  const realParent = await realpath(dirname(target))
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) throw new Error(`Path escapes save folder via link: ${rel}`)
  return target
}

export async function backupFolder(root: string, include: string[], exclude: string[], backupDir: string): Promise<string[]> {
  const scan = await scanFolder(root, include, exclude)
  for (const f of scan.files) {
    const dest = join(backupDir, ...f.path.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(root, ...f.path.split('/')), dest)
  }
  return scan.files.map((f) => f.path)
}

export async function applySnapshot(opts: {
  root: string
  files: FileEntry[]
  store: WorldStore
  include: string[]
  exclude: string[]
  backupDir: string
  journalPath: string
}): Promise<void> {
  const { root, files, store, include, exclude, backupDir, journalPath } = opts

  for (const f of files) {
    if (!(await store.verifyObject(f.sha256, f.size))) throw new Error(`Staged content failed verification: ${f.path}`)
  }

  const previous = await backupFolder(root, include, exclude, backupDir)
  const journal: Journal = { root, backupDir, previous }
  await writeJsonAtomic(journalPath, journal)

  const wanted = new Set(files.map((f) => f.path.toLowerCase()))
  for (const f of files) {
    const target = await safeTarget(root, f.path)
    const tmp = target + TMP_SUFFIX
    await copyFile(store.objectPath(f.sha256), tmp)
    // Keep the original save time so the game and latest-modified policy see true ordering.
    const t = new Date(f.mtimeMs)
    await utimes(tmp, t, t)
    await rename(tmp, target)
  }
  // Leftover saves (e.g. newer-named autosaves) could make the game load stale progress.
  // They are already in the backup, so removing them is recoverable.
  for (const rel of previous) {
    if (!wanted.has(rel.toLowerCase())) await unlink(await safeTarget(root, rel))
  }
  await rm(journalPath, { force: true })
}

/** Rolls back an apply that was interrupted (crash, power loss). Returns true if it did anything. */
export async function recoverJournal(journalPath: string, include: string[], exclude: string[]): Promise<boolean> {
  let journal: Journal
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'))
  } catch {
    return false
  }
  const current = await scanFolder(journal.root, include, exclude)
  for (const f of current.files) await unlink(join(journal.root, ...f.path.split('/')))
  for (const rel of journal.previous) {
    const target = await safeTarget(journal.root, rel)
    await copyFile(join(journal.backupDir, ...rel.split('/')), target)
  }
  await rm(journalPath, { force: true })
  return true
}
