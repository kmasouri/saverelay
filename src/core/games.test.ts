import { describe, expect, it } from 'vitest'
import { GAME_FILES, GAMES, checkGameFile } from './games'

const files = Object.entries(GAME_FILES).map(([path, raw]) => ({ id: path.split('/').pop()!.replace(/\.json$/, ''), raw }))
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

})

describe('game file rules', () => {
  const good = {
    name: 'Some Game',
    windows: { saves: '{savedgames}/Some Game/*', contains: '*.sav', exe: ['SomeGame.exe'] },
    include: ['*.sav'],
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
