import { describe, expect, it } from 'vitest'
import { buildGraph, filesToClear } from '../src/core/graph'
import { contentIdOf } from '../src/core/manifest'
import type { CaptureEvent, SyncEvent } from '../src/core/types'

const W = 'world-1'
let seq = 0

function v(device: string, parents: string[] = [], id = `v${++seq}`, at = ++seq): CaptureEvent {
  const files = [{ path: 'w.a7s', size: 10, sha256: id.padEnd(64, '0'), mtimeMs: at }]
  return { schema: 1, id, worldId: W, deviceId: device, deviceName: `Friend ${device.toUpperCase()}`, at, kind: 'capture', contentId: contentIdOf(W, files), files, parents, reason: parents.length ? 'local' : 'import' }
}
function decision(candidates: string[], selected: string): SyncEvent {
  return { schema: 1, id: `d${++seq}`, worldId: W, deviceId: 'a', deviceName: 'Friend A', at: ++seq, kind: 'decision', candidates, selected, basis: 'user' }
}
function applied(device: string, of: CaptureEvent): SyncEvent {
  return { schema: 1, id: `ap${++seq}`, worldId: W, deviceId: device, deviceName: `Friend ${device.toUpperCase()}`, at: ++seq, kind: 'applied', contentId: of.contentId, versionIds: [of.id] }
}
const byId = (g: ReturnType<typeof buildGraph>) => Object.fromEntries(g.nodes.map((n) => [n.id, n]))

describe('history graph', () => {
  it('draws a straight line when nobody plays separately', () => {
    const a = v('a')
    const b = v('b', [a.id])
    const c = v('c', [b.id])
    const g = buildGraph([a, b, c])
    expect(g.nodes.map((n) => n.id)).toEqual([c.id, b.id, a.id])
    expect(g.nodes.every((n) => n.main && n.lane === 0)).toBe(true)
    expect(g.nodes[0].latest).toBe(true)
    expect(g.lanes).toBe(1)
  })

  it('puts the versions not continued on side lanes, the chosen one on the shared line', () => {
    const a = v('a')
    const b = v('b', [a.id])
    const c = v('c', [a.id])
    const d = v('d', [a.id])
    const pick = decision([b.id, c.id, d.id], c.id)
    const next = v('a', [c.id])
    const n = byId(buildGraph([a, b, c, d, pick, next]))
    expect([n[a.id].main, n[c.id].main, n[next.id].main]).toEqual([true, true, true])
    expect([n[b.id].main, n[d.id].main]).toEqual([false, false])
    expect(n[c.id].lane).toBe(0)
    expect(new Set([n[b.id].lane, n[d.id].lane]).size).toBe(2)
    expect(n[next.id].latest).toBe(true)
  })

  it('keeps every version above the one it continued from, even with a wrong clock', () => {
    const a = v('a', [], 'a', 100)
    const b = v('b', ['a'], 'b', 5) // b's clock is far behind
    const g = buildGraph([a, b])
    expect(g.nodes.map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('shows an unresolved fork with every competing version on its own side lane', () => {
    const a = v('a')
    const b = v('b', [a.id])
    const c = v('c', [a.id])
    const n = byId(buildGraph([a, b, c]))
    expect(n[a.id].main).toBe(true)
    expect([n[b.id].main, n[c.id].main]).toEqual([false, false])
    expect(n[b.id].lane).not.toBe(n[c.id].lane)
    expect(Object.values(n).some((x) => x.latest)).toBe(false)
  })

  it('links a restore to the version it brought back', () => {
    const a = v('a')
    const b = v('b', [a.id])
    const r: SyncEvent = { schema: 1, id: 'r', worldId: W, deviceId: 'a', deviceName: 'Friend A', at: ++seq, kind: 'restore', contentId: a.contentId, files: a.files, parents: [b.id], restoredFrom: a.id }
    const n = byId(buildGraph([a, b, r]))
    expect(n.r.restoredFrom).toBe(a.id)
    expect(n.r.latest).toBe(true)
    expect(n.r.main).toBe(true)
  })

  it('reports which version each device has and its newest name', () => {
    const a = v('a')
    const b = v('b', [a.id])
    const renamed: CaptureEvent = { ...v('c', [b.id]), deviceName: 'DefectiveWombat' }
    const g = buildGraph([a, b, applied('a', b), renamed])
    const n = byId(g)
    expect(n[b.id].here).toEqual(['a', 'b'])
    expect(n[renamed.id].here).toEqual(['c'])
    expect(g.names.c).toBe('DefectiveWombat')
  })

  it('reuses side lanes once a branch has ended', () => {
    const a = v('a')
    const s1 = v('b', [a.id])
    const b = v('a', [a.id])
    const pick1 = decision([s1.id, b.id], b.id)
    const c = v('a', [b.id])
    const s2 = v('c', [c.id])
    const d = v('a', [c.id])
    const pick2 = decision([s2.id, d.id], d.id)
    const n = byId(buildGraph([a, s1, b, pick1, c, s2, d, pick2]))
    expect(n[s1.id].lane).toBe(1)
    expect(n[s2.id].lane).toBe(1)
  })

  it('clears versions past the group limit, but never the latest or an open fork', () => {
    const keep: SyncEvent = { schema: 1, id: `p${++seq}`, worldId: W, deviceId: 'a', deviceName: 'Friend A', at: ++seq, kind: 'policy', policy: 'ask', keepVersions: 2 }
    const a = v('a')
    const b = v('b', [a.id])
    const c = v('c', [b.id])
    const d = v('d', [c.id])
    const e = v('e', [c.id]) // d and e compete: an unresolved fork
    const g = buildGraph([keep, a, b, c, d, e])
    const n = byId(g)
    expect(g.keepVersions).toBe(2)
    expect([n[d.id].cleared, n[e.id].cleared]).toEqual([false, false])
    expect([n[c.id].cleared, n[b.id].cleared, n[a.id].cleared]).toEqual([true, true, true])
    const drop = filesToClear([keep, a, b, c, d, e])
    expect([...drop].sort()).toEqual([a, b, c].map((x) => x.files[0].sha256).sort())
  })

  it('keeps a file that an old version shares with a kept one', () => {
    const keep: SyncEvent = { schema: 1, id: `p${++seq}`, worldId: W, deviceId: 'a', deviceName: 'Friend A', at: ++seq, kind: 'policy', policy: 'ask', keepVersions: 1 }
    const a = v('a')
    const b: CaptureEvent = { ...v('b', [a.id]), files: [...a.files] }
    expect(filesToClear([keep, a, b]).has(a.files[0].sha256)).toBe(false)
  })

  it('keeps everything when the limit is off or was never set', () => {
    const a = v('a')
    const b = v('b', [a.id])
    expect(buildGraph([a, b]).nodes.some((x) => x.cleared)).toBe(false)
    const all: SyncEvent = { schema: 1, id: `p${++seq}`, worldId: W, deviceId: 'a', deviceName: 'Friend A', at: ++seq, kind: 'policy', policy: 'ask', keepVersions: 0 }
    expect(buildGraph([all, a, b]).nodes.some((x) => x.cleared)).toBe(false)
  })
})
