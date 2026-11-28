// Sync policy layer: from shared history, decide which content is the accepted
// continuation. Deterministic so every peer converges on the same answer.

import { snapshotModifiedAt } from './history'
import { compareEvents, isVersion, type DecisionEvent, type FileEntry, type Policy, type PolicyEvent, type SyncEvent, type VersionEvent } from './types'

export interface Candidate {
  contentId: string
  versionIds: string[]
  files: FileEntry[]
  /** Newest file save time, corrected to real time when the saving PC's clock was checked. */
  modifiedAt: number
  /** The saving PC's clock was checked, so modifiedAt can be compared with other PCs'. */
  timeVerified: boolean
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
  | { state: 'conflict'; candidates: Candidate[]; headIds: string[]; policy: PolicySetting; note?: string }

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

/**
 * The decisions each one came after. A decision lists the ones its device had seen;
 * older events don't, so those keep the clock order they always had among themselves.
 */
function decisionPredecessors(decisions: DecisionEvent[]): Map<string, string[]> {
  const ids = new Set(decisions.map((d) => d.id))
  const legacy = decisions.filter((d) => !d.seen)
  return new Map(
    decisions.map((d) => [d.id, d.seen ? d.seen.filter((id) => ids.has(id) && id !== d.id) : legacy.filter((l) => compareEvents(l, d) < 0).map((l) => l.id)]),
  )
}

/**
 * Decisions in the order they take effect: after every decision they had seen.
 * Decisions made without knowing of each other are ordered by id, never by clock,
 * so a PC with a wrong clock can't win.
 */
export function orderDecisions(events: SyncEvent[]): DecisionEvent[] {
  const decisions = events.filter((e): e is DecisionEvent => e.kind === 'decision')
  const preds = decisionPredecessors(decisions)
  const byId = new Map(decisions.map((d) => [d.id, d]))
  const done = new Set<string>()
  const ordered: DecisionEvent[] = []
  const byIdAsc = (a: DecisionEvent, b: DecisionEvent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  while (ordered.length < decisions.length) {
    const left = [...byId.values()].filter((d) => !done.has(d.id)).sort(byIdAsc)
    // A forged cycle can't stall ordering: fall back to the lowest id.
    const next = left.find((d) => preds.get(d.id)!.every((p) => done.has(p))) ?? left[0]
    done.add(next.id)
    ordered.push(next)
  }
  return ordered
}

/** The newest decisions known: none of the others came after them. What a new decision records as seen. */
export function latestDecisions(events: SyncEvent[]): string[] {
  const decisions = events.filter((e): e is DecisionEvent => e.kind === 'decision')
  const before = new Set([...decisionPredecessors(decisions).values()].flat())
  return decisions.filter((d) => !before.has(d.id)).map((d) => d.id).sort()
}

/**
 * Version ids rejected by decisions, plus the decisions that lost. A decision only
 * loses to one it hadn't seen, made at about the same time: someone who had seen a
 * choice no longer had those saves to pick from.
 */
function applyDecisions(events: SyncEvent[], versions: Map<string, VersionEvent>): { superseded: Map<string, DecisionEvent>; overruled: Overruled[] } {
  /** Rejected version id -> the decision that rejected it. */
  const superseded = new Map<string, DecisionEvent>()
  const overruled: Overruled[] = []
  for (const d of orderDecisions(events)) {
    const selected = versions.get(d.selected)
    if (!selected) continue
    const by = superseded.get(d.selected)
    if (by) {
      overruled.push({ decision: d, by })
      continue
    }
    for (const id of d.candidates) {
      const v = versions.get(id)
      if (v && v.contentId !== selected.contentId && !superseded.has(id)) superseded.set(id, d)
    }
  }
  return { superseded, overruled }
}

function versionMap(events: SyncEvent[]): Map<string, VersionEvent> {
  const versions = new Map<string, VersionEvent>()
  for (const e of events) if (isVersion(e)) versions.set(e.id, e)
  return versions
}

export interface Overruled {
  decision: DecisionEvent
  /** The decision it lost to. */
  by: DecisionEvent
}

/** Decisions that lost to another made without knowing of it. */
export function overruledDecisions(events: SyncEvent[]): Overruled[] {
  return applyDecisions(events, versionMap(events)).overruled
}

export function heads(events: SyncEvent[]): VersionEvent[] {
  const versions = versionMap(events)

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
  const { superseded } = applyDecisions(events, versions)
  return [...versions.values()].filter((v) => !ancestors.has(v.id) && !superseded.has(v.id))
}

function groupCandidates(headEvents: VersionEvent[]): Candidate[] {
  const byContent = new Map<string, Candidate>()
  for (const v of [...headEvents].sort(compareEvents)) {
    let c = byContent.get(v.contentId)
    if (!c) {
      c = { contentId: v.contentId, versionIds: [], files: v.files, modifiedAt: snapshotModifiedAt(v.files), timeVerified: false, deviceIds: [], deviceNames: [] }
      byContent.set(v.contentId, c)
    }
    // Same content saved on several PCs: take the times from the first whose clock was checked.
    if (!c.timeVerified && v.clockOffsetMs !== undefined) {
      c.files = v.files
      c.modifiedAt = snapshotModifiedAt(v.files) + v.clockOffsetMs
      c.timeVerified = true
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
    // A PC whose clock wasn't checked could claim any time, so it never wins automatically.
    if (candidates.some((c) => !c.timeVerified)) {
      return { state: 'conflict', candidates, headIds, policy, note: 'Newest save wins only picks when every PC’s clock was checked. One of these was saved offline or by an older SaveRelay.' }
    }
    // Candidates are already ordered by corrected modification time, contentId as a stable tie-break.
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
