// Sync policy layer: from shared history, decide which content is the accepted
// continuation. Deterministic so every peer converges on the same answer.

import { snapshotModifiedAt } from './history'
import { compareEvents, isVersion, type DecisionEvent, type FileEntry, type Policy, type PolicyEvent, type SyncEvent, type VersionEvent } from './types'

export interface Candidate {
  contentId: string
  versionIds: string[]
  files: FileEntry[]
  modifiedAt: number
  deviceIds: string[]
  deviceNames: string[]
}

/** Versions whose files are kept when nobody has chosen otherwise. */
export const DEFAULT_KEEP_VERSIONS = 20

export interface PolicySetting {
  policy: Policy
  preferredDeviceId?: string
  /** How many versions keep their files; 0 keeps all. */
  keepVersions: number
  setBy?: string
  setAt?: number
}

export type Resolution =
  | { state: 'empty'; policy: PolicySetting }
  | { state: 'ok'; accepted: Candidate; candidates: Candidate[]; policy: PolicySetting }
  | { state: 'auto-resolved'; accepted: Candidate; candidates: Candidate[]; headIds: string[]; policy: PolicySetting; note: string }
  | { state: 'conflict'; candidates: Candidate[]; headIds: string[]; policy: PolicySetting }

export function currentPolicy(events: SyncEvent[]): PolicySetting {
  const latest = events.filter((e): e is PolicyEvent => e.kind === 'policy').sort(compareEvents).at(-1)
  if (!latest) return { policy: 'ask', keepVersions: DEFAULT_KEEP_VERSIONS }
  return {
    policy: latest.policy,
    preferredDeviceId: latest.preferredDeviceId,
    keepVersions: latest.keepVersions ?? DEFAULT_KEEP_VERSIONS,
    setBy: latest.deviceName,
    setAt: latest.at,
  }
}

/** Version ids rejected by earlier decisions. Earlier decisions win; a later one cannot revive a rejected id. */
function supersededIds(events: SyncEvent[], versions: Map<string, VersionEvent>): Set<string> {
  const superseded = new Set<string>()
  const decisions = events.filter((e): e is DecisionEvent => e.kind === 'decision').sort(compareEvents)
  for (const d of decisions) {
    const selected = versions.get(d.selected)
    if (!selected || superseded.has(d.selected)) continue
    for (const id of d.candidates) {
      const v = versions.get(id)
      if (v && v.contentId !== selected.contentId) superseded.add(id)
    }
  }
  return superseded
}

export function heads(events: SyncEvent[]): VersionEvent[] {
  const versions = new Map<string, VersionEvent>()
  for (const e of events) if (isVersion(e)) versions.set(e.id, e)

  const ancestors = new Set<string>()
  const stack: string[] = []
  for (const v of versions.values()) stack.push(...v.parents)
  while (stack.length) {
    const id = stack.pop()!
    if (ancestors.has(id)) continue
    ancestors.add(id)
    const v = versions.get(id)
    if (v) stack.push(...v.parents)
  }
  const superseded = supersededIds(events, versions)
  return [...versions.values()].filter((v) => !ancestors.has(v.id) && !superseded.has(v.id))
}

function groupCandidates(headEvents: VersionEvent[]): Candidate[] {
  const byContent = new Map<string, Candidate>()
  for (const v of [...headEvents].sort(compareEvents)) {
    let c = byContent.get(v.contentId)
    if (!c) {
      c = { contentId: v.contentId, versionIds: [], files: v.files, modifiedAt: snapshotModifiedAt(v.files), deviceIds: [], deviceNames: [] }
      byContent.set(v.contentId, c)
    }
    c.versionIds.push(v.id)
    if (!c.deviceIds.includes(v.deviceId)) {
      c.deviceIds.push(v.deviceId)
      c.deviceNames.push(v.deviceName)
    }
  }
  return [...byContent.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || (a.contentId < b.contentId ? -1 : 1))
}

export function resolve(events: SyncEvent[]): Resolution {
  const policy = currentPolicy(events)
  const headEvents = heads(events)
  const candidates = groupCandidates(headEvents)
  if (candidates.length === 0) return { state: 'empty', policy }
  if (candidates.length === 1) return { state: 'ok', accepted: candidates[0], candidates, policy }

  const headIds = headEvents.map((h) => h.id).sort()
  if (policy.policy === 'latest-modified') {
    // Candidates are already ordered by original modification time, contentId as a stable tie-break.
    const tie = candidates[0].modifiedAt === candidates[1].modifiedAt
    return {
      state: 'auto-resolved',
      accepted: candidates[0],
      candidates,
      headIds,
      policy,
      note: tie ? 'Equal modification times; chosen by stable content id tie-break.' : 'Latest original save modification time wins.',
    }
  }
  if (policy.policy === 'preferred-device' && policy.preferredDeviceId) {
    const preferred = candidates.filter((c) => c.deviceIds.includes(policy.preferredDeviceId!))
    if (preferred.length === 1) {
      return { state: 'auto-resolved', accepted: preferred[0], candidates, headIds, policy, note: 'Preferred device wins.' }
    }
  }
  return { state: 'conflict', candidates, headIds, policy }
}
