// Renderer-side view of the main process state. Mirrors Engine.snapshot().

export { uploadingLine } from '../../../core/names'

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
  policy: { policy: Policy; preferredDeviceId?: string; keepVersions: number; setBy?: string; setAt?: number }
  /** Space this save takes on this PC (history and backups); null until first counted. */
  storageBytes: number | null
  download: Download | null
  conflict: Candidate[] | null
  autoNote: string | null
  /** Online friends still downloading a save from this PC, with how far along they are. */
  uploading: { name: string; percent: number }[]
  /** This PC's choice that lost to a friend's made at about the same time, until dismissed. */
  overruled: { decisionId: string; at: number; byName: string } | null
  acceptedContentId: string | null
  liveContentId: string | null
  lastAppliedAt: number
  lastCaptureAt: number
}

export interface Download {
  haveBytes: number
  totalBytes: number
  fromNames: string[]
  fromLastSeenAt: number
  savedAt: number
  paused: boolean
  etaSeconds: number | null
}

export const downloadPercent = (d: Download): number => (d.totalBytes ? Math.floor((d.haveBytes / d.totalBytes) * 100) : 0)

/** "DefectiveWombat's save from Nov 26 · 480 MB of 843 MB · about 2 min left", or why it's paused. */
export function downloadLine(d: Download): string {
  const from = d.fromNames.length ? d.fromNames.join(' and ') : 'a friend'
  if (d.paused) return `Continues when ${from} ${d.fromNames.length > 1 ? 'are' : 'is'} online${d.fromLastSeenAt ? ` · last online ${when(d.fromLastSeenAt)}` : ''}`
  const eta = d.etaSeconds === null ? '' : d.etaSeconds < 60 ? ' · less than a minute left' : ` · about ${d.etaSeconds < 3600 ? `${Math.round(d.etaSeconds / 60)} min` : `${(d.etaSeconds / 3600).toFixed(1)} h`} left`
  return `${d.fromNames.length ? `${from}’s` : 'The'} save from ${when(d.savedAt)} · ${bytes(d.haveBytes)} of ${bytes(d.totalBytes)}${eta}`
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
  device: { name: string; nameChosen: boolean; deviceId: string; syncthingId: string; invite: string; startAtLogin: boolean; autoUpdate: boolean }
  transport: { ok: boolean; error: string | null }
  /** How far off this PC's clock is ("7 minutes ahead"), when it's enough to warn about. */
  clockWarning: string | null
  peers: { deviceId: string; name: string; connected: boolean; lastSeenAt: number; addedAt: number }[]
  pendingDevices: { deviceId: string; name: string; address: string }[]
  friendRequests: { syncthingId: string; deviceId: string; name: string }[]
  invitations: { folderId: string; label: string; offeredBy: string[] }[]
  games: Game[]
  worlds: World[]
  app: { version: string; packaged: boolean; logFile: string; crashedLastTime: boolean }
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
  cleared: boolean
}

export interface Graph {
  nodes: GraphNode[]
  lanes: number
  keepVersions: number
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
