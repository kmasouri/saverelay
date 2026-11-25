// Shared history: what versions exist and who reported them. Independent of sync
// policy — nothing here decides which version is active.

import { compareEvents, isVersion, type FileEntry, type SyncEvent, type VersionEvent } from './types'

export interface Contribution {
  eventId: string
  deviceId: string
  deviceName: string
  at: number
  kind: 'capture' | 'restore'
  reason: 'local' | 'import' | 'restore'
  restoredFrom?: string
}

/** Exact-content group: identical bytes, possibly captured independently by several devices. */
export interface ContentGroup {
  contentId: string
  files: FileEntry[]
  /** Newest original save modification time among this content's files. */
  modifiedAt: number
  contributions: Contribution[]
  /** Devices known to hold this content (captured, restored or applied it). */
  availableOn: { deviceId: string; deviceName: string }[]
  firstSeenAt: number
  lastSeenAt: number
  grouping: 'exact-content'
}

export function snapshotModifiedAt(files: FileEntry[]): number {
  return files.reduce((m, f) => Math.max(m, f.mtimeMs), 0)
}

export function buildHistory(events: SyncEvent[]): ContentGroup[] {
  const groups = new Map<string, ContentGroup>()
  const sorted = [...events].sort(compareEvents)

  const ensure = (v: VersionEvent): ContentGroup => {
    let g = groups.get(v.contentId)
    if (!g) {
      g = {
        contentId: v.contentId,
        files: v.files,
        modifiedAt: snapshotModifiedAt(v.files),
        contributions: [],
        availableOn: [],
        firstSeenAt: v.at,
        lastSeenAt: v.at,
        grouping: 'exact-content',
      }
      groups.set(v.contentId, g)
    }
    return g
  }
  const markAvailable = (g: ContentGroup, deviceId: string, deviceName: string): void => {
    const existing = g.availableOn.find((d) => d.deviceId === deviceId)
    if (existing) existing.deviceName = deviceName
    else g.availableOn.push({ deviceId, deviceName })
  }

  for (const e of sorted) {
    if (isVersion(e)) {
      const g = ensure(e)
      g.lastSeenAt = Math.max(g.lastSeenAt, e.at)
      g.contributions.push({
        eventId: e.id,
        deviceId: e.deviceId,
        deviceName: e.deviceName,
        at: e.at,
        kind: e.kind,
        reason: e.kind === 'capture' ? e.reason : 'restore',
        restoredFrom: e.kind === 'restore' ? e.restoredFrom : undefined,
      })
      markAvailable(g, e.deviceId, e.deviceName)
    } else if (e.kind === 'applied') {
      const g = groups.get(e.contentId)
      if (g) markAvailable(g, e.deviceId, e.deviceName)
    }
  }
  return [...groups.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}
