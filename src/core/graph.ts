// History as a branch graph: one node per version, laid out in lanes. The shared
// line (everything the group's latest save descends from) is lane 0; versions
// people played separately get side lanes. Derived only from shared events, so
// every peer draws the same graph.

import { snapshotModifiedAt } from './history'
import { currentPolicy, heads, resolve } from './reconcile'
import { compareEvents, fileClockOffset, isVersion, realTime, type SyncEvent, type VersionEvent } from './types'

export interface GraphNode {
  id: string
  contentId: string
  kind: 'capture' | 'restore'
  reason: 'local' | 'import' | 'restore'
  deviceId: string
  /** When the event was recorded, on the recording device's clock. */
  at: number
  /** Newest save-file modification time in this version. */
  savedAt: number
  parentId: string | null
  /** For a restore: the version it brought back. */
  restoredFrom: string | null
  /** On the shared line rather than played separately. */
  main: boolean
  latest: boolean
  lane: number
  /** 0 is the newest row. */
  row: number
  /** Devices whose save folder held this version when they last reported. */
  here: string[]
  /** Past the group's "keep the last N versions" limit: its files are deleted to save space. */
  cleared: boolean
}

export interface Graph {
  nodes: GraphNode[]
  lanes: number
  /** The group's limit; 0 keeps every version. */
  keepVersions: number
  /** Most recently reported name for each device. */
  names: Record<string, string>
}

export function buildGraph(events: SyncEvent[]): Graph {
  const sorted = [...events].sort(compareEvents)
  const versions = new Map<string, VersionEvent>()
  const names: Record<string, string> = {}
  for (const e of sorted) {
    names[e.deviceId] = e.deviceName
    if (isVersion(e)) versions.set(e.id, e)
  }
  const keep = currentPolicy(events).keepVersions
  if (!versions.size) return { nodes: [], lanes: 1, keepVersions: keep, names }

  const ancestorsOf = (ids: string[]): Set<string> => {
    const seen = new Set<string>()
    const stack = ids.flatMap((id) => versions.get(id)?.parents ?? [])
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id) || !versions.has(id)) continue
      seen.add(id)
      stack.push(...versions.get(id)!.parents)
    }
    return seen
  }

  const res = resolve(events)
  const acceptedIds = 'accepted' in res ? res.accepted.versionIds.filter((id) => versions.has(id)) : []
  let main: Set<string>
  if (acceptedIds.length) {
    main = new Set([...acceptedIds, ...ancestorsOf(acceptedIds)])
  } else if (res.state === 'conflict') {
    // Unresolved: only what every competing version shares is on the shared line.
    const sets = res.headIds.map((id) => ancestorsOf([id]))
    main = new Set([...sets[0]].filter((id) => sets.every((s) => s.has(id))))
  } else {
    main = new Set()
  }
  const latestId = acceptedIds.map((id) => versions.get(id)!).sort(compareEvents).at(-1)?.id ?? null

  // One drawn parent per version, preferring the shared line.
  const parentOf = new Map<string, string | null>()
  for (const v of versions.values()) {
    const known = v.parents.filter((id) => versions.has(id))
    parentOf.set(v.id, known.find((id) => main.has(id)) ?? known[0] ?? null)
  }

  // Newest first, but a version always sits above the one it continued from.
  const pendingChildren = new Map<string, number>()
  for (const p of parentOf.values()) if (p) pendingChildren.set(p, (pendingChildren.get(p) ?? 0) + 1)
  const ready = [...versions.values()].filter((v) => !pendingChildren.get(v.id))
  const order: VersionEvent[] = []
  while (ready.length) {
    ready.sort(compareEvents)
    const v = ready.pop()!
    order.push(v)
    const p = parentOf.get(v.id)
    if (p) {
      const left = pendingChildren.get(p)! - 1
      pendingChildren.set(p, left)
      if (left === 0) ready.push(versions.get(p)!)
    }
  }
  const row = new Map(order.map((v, i) => [v.id, i]))

  // Side lanes: chain each separately played version onto its parent's lane when
  // it is that lane's newest so far; otherwise start a new branch.
  type Chain = { tip: string; ids: string[]; fork: string | null; lane: number }
  const chains: Chain[] = []
  const chainOf = new Map<string, Chain>()
  for (const v of [...order].reverse()) {
    if (main.has(v.id)) continue
    const p = parentOf.get(v.id) ?? null
    const parentChain = p ? chainOf.get(p) : undefined
    if (parentChain && parentChain.tip === p) {
      parentChain.ids.push(v.id)
      parentChain.tip = v.id
      chainOf.set(v.id, parentChain)
    } else {
      const c: Chain = { tip: v.id, ids: [v.id], fork: p, lane: 0 }
      chains.push(c)
      chainOf.set(v.id, c)
    }
  }
  const span = (c: Chain): [number, number] => [row.get(c.tip)!, row.get(c.fork ?? c.ids[0])!]
  const taken: [number, number][][] = []
  for (const c of [...chains].sort((a, b) => span(a)[0] - span(b)[0])) {
    const [top, bottom] = span(c)
    let lane = 1
    while ((taken[lane] ?? []).some(([t, b]) => !(bottom < t || b < top))) lane++
    ;(taken[lane] ??= []).push([top, bottom])
    c.lane = lane
  }

  // Where each device is: its newest version or applied event.
  const position = new Map<string, string>()
  for (const e of sorted) {
    if (isVersion(e)) position.set(e.deviceId, e.id)
    else if (e.kind === 'applied') {
      const id = e.versionIds.find((x) => versions.has(x))
      if (id) position.set(e.deviceId, id)
    }
  }
  const here = new Map<string, string[]>()
  for (const [device, id] of position) here.set(id, [...(here.get(id) ?? []), device])

  // The newest `keep` rows keep their files, and so do the latest save and any
  // version still competing in an unresolved fork, however old.
  const protectedIds = new Set([...acceptedIds, ...heads(events).map((h) => h.id)])
  const cleared = (v: VersionEvent): boolean => keep > 0 && row.get(v.id)! >= keep && !protectedIds.has(v.id)

  const nodes: GraphNode[] = order.map((v, i) => ({
    id: v.id,
    contentId: v.contentId,
    kind: v.kind,
    reason: v.kind === 'capture' ? v.reason : 'restore',
    deviceId: v.deviceId,
    at: realTime(v),
    savedAt: v.kind === 'capture' ? snapshotModifiedAt(v.files) + (fileClockOffset(v) ?? 0) : realTime(v),
    parentId: parentOf.get(v.id) ?? null,
    restoredFrom: v.kind === 'restore' && versions.has(v.restoredFrom) ? v.restoredFrom : null,
    main: main.has(v.id),
    latest: v.id === latestId,
    lane: main.has(v.id) ? 0 : chainOf.get(v.id)!.lane,
    row: i,
    here: here.get(v.id) ?? [],
    cleared: cleared(v),
  }))
  return { nodes, lanes: Math.max(1, ...nodes.map((n) => n.lane + 1)), keepVersions: keep, names }
}

/**
 * File hashes that only cleared versions use, so they can be deleted. Files no
 * known version mentions are never listed: they may belong to a friend's new
 * version whose record hasn't arrived yet.
 */
export function filesToClear(events: SyncEvent[]): Set<string> {
  const cleared = new Set(buildGraph(events).nodes.filter((n) => n.cleared).map((n) => n.id))
  const keep = new Set<string>()
  const drop = new Set<string>()
  for (const e of events) {
    if (!isVersion(e)) continue
    for (const f of e.files) (cleared.has(e.id) ? drop : keep).add(f.sha256)
  }
  for (const sha of keep) drop.delete(sha)
  return drop
}
