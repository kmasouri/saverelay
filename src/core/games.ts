// Game definitions supply discovery and lifecycle hints only. The history and
// sync model never depends on them; any folder can be shared as a custom game.

export interface GameDefinition {
  id: string
  name: string
  /** Executable names used to detect a running session (case-insensitive). */
  processNames: string[]
  /** Default include/exclude globs relative to the world folder. */
  include: string[]
  exclude: string[]
  discovery?: {
    platform: NodeJS.Platform
    /** Base folder; `{documents}` resolves to the user's real Documents folder. */
    base: string
    /** Number of directory levels below base where world folders live. */
    depth: number
    /** A candidate folder must directly contain a file matching this glob. */
    mustContain: string
  }
  notes: string
}

export const GAMES: GameDefinition[] = [
  {
    id: 'anno-1800',
    name: 'Anno 1800',
    processNames: ['Anno1800.exe', 'Anno1800_plus.exe'],
    include: ['*.a7s'],
    exclude: ['accountdata.a7s'],
    discovery: { platform: 'win32', base: '{documents}/Anno 1800/accounts', depth: 2, mustContain: '*.a7s' },
    notes:
      'Initial test adapter. Process names and save layout are unvalidated assumptions; ' +
      'byte identity of saves across multiplayer participants is unknown.',
  },
]

export const CUSTOM_GAME_ID = 'custom'

export function gameById(id: string): GameDefinition | undefined {
  return GAMES.find((g) => g.id === id)
}
