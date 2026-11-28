import { contentIdOf } from './manifest'
import type { CaptureEvent, FileEntry, Policy, SyncEvent } from './types'

export const W = 'world-1'
export const h = (c: string): string => c.repeat(64).slice(0, 64)
let seq = 0

export function files(spec: Record<string, [string, number]>): FileEntry[] {
  return Object.entries(spec).map(([path, [hashChar, mtimeMs]]) => ({ path, size: 10, sha256: h(hashChar), mtimeMs }))
}
export function capture(device: string, fs: FileEntry[], parents: string[] = [], id = `e${++seq}`): CaptureEvent {
  return { schema: 1, id, worldId: W, deviceId: device, deviceName: device.toUpperCase(), at: ++seq, kind: 'capture', contentId: contentIdOf(W, fs), files: fs, parents, reason: 'local' }
}
export function policy(p: Policy, extra: Partial<SyncEvent> = {}): SyncEvent {
  return { schema: 1, id: `p${++seq}`, worldId: W, deviceId: 'a', deviceName: 'A', at: ++seq, kind: 'policy', policy: p, ...extra } as SyncEvent
}
