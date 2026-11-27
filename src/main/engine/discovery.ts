// Finds save folders on this PC from the games/ catalogue. Each game's path is
// resolved from a known placeholder, then walked one folder level per segment.
// A game whose starting folder doesn't exist costs one failed readdir, so
// thousands of games still scan quickly.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { GameDefinition, Placeholder } from '../../core/games'
import { globToRegExp } from '../../core/paths'

export interface FoundSave {
  gameId: string
  gameName: string
  name: string
  path: string
  lastPlayedAt: number
}

type Lister = (dir: string) => Promise<Dirent[]>

/** Lists each folder once per scan: many games start in the same few folders. */
function cachedLister(): Lister {
  const cache = new Map<string, Promise<Dirent[]>>()
  return (dir) => {
    let p = cache.get(dir)
    if (!p) cache.set(dir, (p = readdir(dir, { withFileTypes: true }).catch(() => [])))
    return p
  }
}

/** Expands `{placeholder}/a/*\/b` into the folders that exist. */
export async function expandSavePath(pattern: string, places: Partial<Record<Placeholder, string>>, list: Lister = cachedLister()): Promise<string[]> {
  const m = /^\{([a-z]+)\}(.*)$/.exec(pattern)
  const root = m ? places[m[1] as Placeholder] : undefined
  if (!m || !root) return []
  let level = [root]
  for (const segment of m[2].split('/').filter(Boolean)) {
    const next: string[] = []
    for (const dir of level) {
      const entries = await list(dir)
      const match = segment.includes('*') || segment.includes('?') ? globToRegExp(segment) : null
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (match ? match.test(e.name) : e.name.toLowerCase() === segment.toLowerCase()) next.push(join(dir, e.name))
      }
    }
    level = next
    if (!level.length) break
  }
  return level
}

export async function findSaves(games: GameDefinition[], places: Partial<Record<Placeholder, string>>): Promise<FoundSave[]> {
  const out: FoundSave[] = []
  const list = cachedLister()
  for (const game of games) {
    if (!game.discovery) continue
    const want = globToRegExp(game.discovery.contains)
    for (const dir of await expandSavePath(game.discovery.saves, places, list)) {
      const files = await readdir(dir).catch(() => [] as string[])
      const saves = files.filter((f) => want.test(f))
      if (!saves.length) continue
      const times = await Promise.all(saves.map((f) => stat(join(dir, f)).then((s) => s.mtimeMs, () => 0)))
      const folder = basename(dir)
      const name = game.stripPrefix && folder.startsWith(game.stripPrefix) ? folder.slice(game.stripPrefix.length) : folder
      out.push({ gameId: game.id, gameName: game.name, name, path: dir, lastPlayedAt: Math.max(...times) })
    }
  }
  return out
}
