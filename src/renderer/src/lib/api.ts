// Renderer-side view of the main process state. Mirrors Engine.snapshot().

export type WorldStatus = 'setting-up' | 'up-to-date' | 'playing' | 'waiting-for-peer' | 'pending-update' | 'conflict' | 'error'
export type Policy = 'ask' | 'latest-modified' | 'preferred-device'

export interface FileEntry {
  path: string
  size: number
  sha256: string
  mtimeMs: number
}

export interface Candidate {
  contentId: string
  versionIds: string[]
  files: FileEntry[]
  modifiedAt: number
  deviceIds: string[]
  deviceNames: string[]
}

export interface World {
  id: string
  name: string
  gameId: string
  localPath: string
  processNames: string[]
  include: string[]
  exclude: string[]
  sharedWith: string[]
  mode: 'contribute' | 'receive'
  status: WorldStatus
  detail: string
  warnings: string[]
  pendingUpdate: boolean
  policy: { policy: Policy; preferredDeviceId?: string; setBy?: string; setAt?: number }
  conflict: Candidate[] | null
  autoNote: string | null
  acceptedContentId: string | null
  liveContentId: string | null
  lastAppliedAt: number
  lastCaptureAt: number
}

export interface Game {
  id: string
  name: string
  processNames: string[]
  include: string[]
  exclude: string[]
  notes: string
}

export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error'
  version?: string
  progress?: number
  error?: string
  checkedAt?: number
}

export interface AppState {
  device: { name: string; nameChosen: boolean; deviceId: string; syncthingId: string; invite: string; startAtLogin: boolean }
  transport: { ok: boolean; error: string | null }
  peers: { deviceId: string; name: string; connected: boolean; addedAt: number }[]
  pendingDevices: { deviceId: string; name: string; address: string }[]
  invitations: { folderId: string; label: string; offeredBy: string[] }[]
  games: Game[]
  worlds: World[]
  app: { version: string; packaged: boolean; logFile: string }
  update: UpdateState
}

export interface Contribution {
  eventId: string
  deviceId: string
  deviceName: string
  at: number
  kind: 'capture' | 'restore'
  reason: 'local' | 'import' | 'restore'
}

export interface HistoryGroup {
  contentId: string
  files: FileEntry[]
  modifiedAt: number
  contributions: Contribution[]
  availableOn: { deviceId: string; deviceName: string }[]
  firstSeenAt: number
  lastSeenAt: number
  grouping: 'exact-content'
  accepted: boolean
  live: boolean
}

export interface Discovered {
  gameId: string
  gameName: string
  name: string
  path: string
  added: boolean
  lastPlayedAt: number
}

export interface GraphNode {
  id: string
  contentId: string
  kind: 'capture' | 'restore'
  reason: 'local' | 'import' | 'restore'
  deviceId: string
  at: number
  savedAt: number
  parentId: string | null
  restoredFrom: string | null
  main: boolean
  latest: boolean
  lane: number
  row: number
  here: string[]
}

export interface Graph {
  nodes: GraphNode[]
  lanes: number
  names: Record<string, string>
}

export interface WorldInput {
  name: string
  gameId: string
  localPath: string
  processNames: string[]
  include: string[]
  exclude: string[]
  sharedWith: string[]
  mode?: 'contribute' | 'receive'
}

declare global {
  interface Window {
    sr: {
      invoke(name: string, ...args: unknown[]): Promise<unknown>
      onState(cb: (state: AppState) => void): () => void
    }
  }
}

export function call<T = void>(name: string, ...args: unknown[]): Promise<T> {
  return window.sr.invoke(name, ...args) as Promise<T>
}

export const STATUS_LABEL: Record<WorldStatus, string> = {
  'setting-up': 'Setting up',
  'up-to-date': 'Ready to play',
  playing: 'Playing',
  'waiting-for-peer': 'Downloading',
  'pending-update': 'Updating',
  conflict: 'Pick a version',
  error: 'Problem',
}

export const POLICY_LABEL: Record<Policy, string> = {
  ask: 'Ask everyone to pick one',
  'latest-modified': 'Newest save wins',
  'preferred-device': "One person's save wins",
}

export function when(ms: number): string {
  if (!ms) return 'never'
  const d = new Date(ms)
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function exact(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export const totalSize = (files: FileEntry[]): number => files.reduce((s, f) => s + f.size, 0)
export const shortId = (id: string): string => id.slice(0, 8)
export const splitList = (s: string): string[] => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
