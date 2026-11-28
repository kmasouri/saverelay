import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GAMES, PLACEHOLDERS, type GameDefinition } from '../../core/games'
import { findSaves } from './discovery'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

describe('game catalogue examples', () => {
  it.each(GAMES.filter((g) => g.example).map((g) => [g.id, g] as [string, GameDefinition]))('%s finds the saves in its example', async (_id, game) => {
    const root = await mkdtemp(join(tmpdir(), 'saverelay-games-'))
    roots.push(root)
    const places = Object.fromEntries(PLACEHOLDERS.map((p) => [p, join(root, p)]))
    for (const f of game.example!.files) {
      const path = f.replace(/^\{([a-z]+)\}/, (_m, p: string) => places[p])
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'x')
    }
    const found = await findSaves([game], places)
    expect(found.map((s) => s.name).sort()).toEqual([...game.example!.finds].sort())
  })
})
