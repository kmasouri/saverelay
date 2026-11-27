/// <reference types="vite/client" />
// Games SaveRelay can find on its own. Each one is a JSON file in games/, written
// by contributors and checked by the tests (see CONTRIBUTING.md). They supply
// discovery and "is the game running" hints only; the history and sync model never
// depends on them, and any folder can still be shared as a custom game.

/** Folders a save path may start from. Nothing outside these can be pointed at. */
export const PLACEHOLDERS = ['documents', 'savedgames', 'appdata', 'localappdata', 'localappdatalow', 'home'] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

export interface GameDefinition {
  id: string
  name: string
  /** Executable names used to detect a running session (case-insensitive). */
  processNames: string[]
  /** Which files in a save folder are synced, relative to that folder. */
  include: string[]
  exclude: string[]
  discovery?: {
    /** e.g. `{documents}/Anno 1800/accounts/* /*`: `*` matches one folder level. */
    saves: string
    /** A save folder must directly contain a file matching this. */
    contains: string
  }
  /** Removed from folder names when showing them, e.g. `MP-`. */
  stripPrefix?: string
  notes: string
  /** Sample files and the save names discovery should find among them; checked by the tests. */
  example?: { files: string[]; finds: string[] }
}

export const CUSTOM_GAME_ID = 'custom'

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/
const FIELDS = new Set(['$schema', 'name', 'windows', 'include', 'exclude', 'stripPrefix', 'notes', 'example'])
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const isStrList = (v: unknown, max = 200): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => isStr(x, max))

/** A relative glob that stays inside the folder it's applied to. */
function safeRelative(glob: string): boolean {
  return !glob.startsWith('/') && !glob.includes('\\') && !glob.includes(':') && !glob.split('/').some((s) => s === '..' || s === '.' || s === '')
}

/** A save path: a known placeholder, then plain folder names or `*` patterns. */
export function checkSavePath(path: string): string | null {
  const m = /^\{([a-z]+)\}((?:\/[^/]+)*)$/.exec(path)
  if (!m) return 'must start with a placeholder like {documents} and use / between folders'
  if (!(PLACEHOLDERS as readonly string[]).includes(m[1])) return `unknown placeholder {${m[1]}}; use one of ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`
  const rest = m[2].slice(1)
  if (rest && !safeRelative(rest)) return 'folders after the placeholder can’t be empty, "." or "..", or contain \\ or :'
  if (rest.includes('**')) return '** isn’t supported; use one * per folder level'
  return null
}

/** Every problem with one game file, in words a contributor can act on. Empty means it's good. */
export function checkGameFile(id: string, raw: unknown): string[] {
  const problems: string[] = []
  if (!ID.test(id)) problems.push(`file name must be lowercase words joined by dashes, like anno-1800.json`)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [...problems, 'must be a JSON object']
  const g = raw as Record<string, unknown>
  for (const key of Object.keys(g)) if (!FIELDS.has(key)) problems.push(`unknown field "${key}"`)
  if (!isStr(g.name, 80)) problems.push('"name" is required')
  const w = g.windows as Record<string, unknown> | undefined
  if (!w || typeof w !== 'object') problems.push('"windows" is required')
  else {
    for (const key of Object.keys(w)) if (!['saves', 'contains', 'exe'].includes(key)) problems.push(`unknown field "windows.${key}"`)
    if (!isStr(w.saves, 300)) problems.push('"windows.saves" is required')
    else {
      const bad = checkSavePath(w.saves)
      if (bad) problems.push(`"windows.saves" ${bad}`)
    }
    if (!isStr(w.contains, 100) || w.contains.includes('/') || !safeRelative(w.contains)) problems.push('"windows.contains" must be a file pattern like *.sav')
    if (!isStrList(w.exe, 100) || !w.exe.every((e) => /^[^\\/:]+\.exe$/i.test(e))) problems.push('"windows.exe" must list program names like Game.exe')
  }
  for (const key of ['include', 'exclude'] as const) {
    const v = g[key]
    if (v === undefined && key === 'exclude') continue
    if (!Array.isArray(v) || (key === 'include' && v.length === 0) || !v.every((x) => isStr(x, 200) && safeRelative(x))) problems.push(`"${key}" must list file patterns inside the save folder, like *.sav`)
  }
  if (g.stripPrefix !== undefined && !isStr(g.stripPrefix, 40)) problems.push('"stripPrefix" must be text')
  if (g.notes !== undefined && !isStr(g.notes, 1000)) problems.push('"notes" must be text')
  const ex = g.example as Record<string, unknown> | undefined
  if (ex !== undefined) {
    if (!ex || typeof ex !== 'object' || !isStrList(ex.files, 300) || !Array.isArray(ex.finds) || !ex.finds.every((x) => isStr(x))) problems.push('"example" needs "files" and "finds" lists')
    else for (const f of ex.files as string[]) if (checkSavePath(f)) problems.push(`"example.files": ${f} ${checkSavePath(f)}`)
  }
  return problems
}

function toDefinition(id: string, g: Record<string, unknown>): GameDefinition {
  const w = g.windows as { saves: string; contains: string; exe: string[] }
  return {
    id,
    name: g.name as string,
    processNames: w.exe,
    include: g.include as string[],
    exclude: (g.exclude as string[] | undefined) ?? [],
    discovery: { saves: w.saves, contains: w.contains },
    stripPrefix: g.stripPrefix as string | undefined,
    notes: (g.notes as string | undefined) ?? '',
    example: g.example as GameDefinition['example'],
  }
}

/** Loads game files, skipping any that fail the checks (the tests catch those before release). */
export function loadGames(files: Record<string, unknown>): GameDefinition[] {
  const games: GameDefinition[] = []
  for (const [path, raw] of Object.entries(files)) {
    const id = path.split('/').pop()!.replace(/\.json$/, '')
    if (checkGameFile(id, raw).length === 0) games.push(toDefinition(id, raw as Record<string, unknown>))
  }
  return games.sort((a, b) => a.name.localeCompare(b.name))
}

export const GAME_FILES: Record<string, unknown> = import.meta.glob(['../../games/*.json', '!../../games/schema.json'], { eager: true, import: 'default' })
export const GAMES: GameDefinition[] = loadGames(GAME_FILES)

export function gameById(id: string): GameDefinition | undefined {
  return GAMES.find((g) => g.id === id)
}
