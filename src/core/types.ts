// Shared data model. Events are immutable, signed records written by exactly one
// device into its own directory of the shared staging store; history is the union.

export const SCHEMA = 1 as const

/** One file of a snapshot. `mtimeMs` is provenance only and never part of content identity. */
export interface FileEntry {
  path: string
  size: number
  sha256: string
  mtimeMs: number
}

export type Policy = 'ask' | 'latest-modified' | 'preferred-device'

interface EventBase {
  schema: typeof SCHEMA
  id: string
  worldId: string
  deviceId: string
  deviceName: string
  /** Wall-clock time the event was recorded on its device. */
  at: number
}

/** A device captured the live save folder after a local change (or initial import). */
export interface CaptureEvent extends EventBase {
  kind: 'capture'
  contentId: string
  files: FileEntry[]
  /** Version event ids the device was playing from when this was captured. */
  parents: string[]
  reason: 'local' | 'import'
}

/** A user intentionally re-activated historical content. Original attribution stays on the source. */
export interface RestoreEvent extends EventBase {
  kind: 'restore'
  contentId: string
  files: FileEntry[]
  parents: string[]
  restoredFrom: string
}

/** A device applied content to its live folder. Changes availability, never contribution. */
export interface AppliedEvent extends EventBase {
  kind: 'applied'
  contentId: string
  versionIds: string[]
}

/** Records which of several competing heads became the shared continuation. */
export interface DecisionEvent extends EventBase {
  kind: 'decision'
  candidates: string[]
  selected: string
  basis: Policy | 'user'
}

/** Group-wide conflict policy; the latest policy event wins. */
export interface PolicyEvent extends EventBase {
  kind: 'policy'
  policy: Policy
  preferredDeviceId?: string
  /** How many versions keep their files (0 = all). Absent in events from older versions. */
  keepVersions?: number
}

export type SyncEvent = CaptureEvent | RestoreEvent | AppliedEvent | DecisionEvent | PolicyEvent
export type VersionEvent = CaptureEvent | RestoreEvent
export type SignedEvent = SyncEvent & { sig: string }

export function isVersion(e: SyncEvent): e is VersionEvent {
  return e.kind === 'capture' || e.kind === 'restore'
}

/** Stable total order used everywhere a tie must converge across peers. */
export function compareEvents(a: { at: number; id: string }, b: { at: number; id: string }): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
