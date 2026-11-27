// Guards the games/ catalogue. Every contributed file must pass these, and its
// example must actually be found, before it can ship.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GAME_FILES, GAMES, PLACEHOLDERS, checkGameFile, type GameDefinition } from '../src/core/games'
import { findSaves } from '../src/main/engine/discovery'

const files = Object.entries(GAME_FILES).map(([path, raw]) => ({ id: path.split('/').pop()!.replace(/\.json$/, ''), raw }))
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

describe('games catalogue', () => {
  it('has at least one game', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('$id.json follows the rules', ({ id, raw }) => {
    expect(checkGameFile(id, raw)).toEqual([])
  })

  it('has no two games with the same name', () => {
    const names = GAMES.map((g) => g.name.toLowerCase())
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  })

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

describe('game file rules', () => {
  const good = {
    name: 'Some Game',
    windows: { saves: '{savedgames}/Some Game/*', contains: '*.sav', exe: ['SomeGame.exe'] },
    include: ['*.sav'],
    verified: false,
  }
  const problems = (patch: Record<string, unknown>, id = 'some-game'): string[] => checkGameFile(id, { ...good, ...patch })

  it('accepts a minimal game', () => {
    expect(problems({})).toEqual([])
  })
  it('refuses paths that could reach outside the known folders', () => {
    for (const saves of ['C:/Users/me', '{documents}/../.ssh', '{programfiles}/Game', '{documents}\\Game', '{documents}/a//b', '{documents}/**']) {
      expect(problems({ windows: { ...good.windows, saves } }).length, saves).toBeGreaterThan(0)
    }
    expect(problems({ include: ['../secret'] }).length).toBeGreaterThan(0)
  })
  it('catches typos and bad names', () => {
    expect(problems({ exe: ['x.exe'] })).toContain('unknown field "exe"')
    expect(problems({ windows: { ...good.windows, exe: ['Game'] } }).length).toBeGreaterThan(0)
    expect(problems({}, 'Some_Game').length).toBeGreaterThan(0)
  })
})
