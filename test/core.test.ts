import { describe, expect, it } from 'vitest'
import { buildHistory } from '../src/core/history'
import { decodeInvite, encodeInvite, newIdentity, signEvent, verifyEvent } from '../src/core/identity'
import { contentIdOf } from '../src/core/manifest'
import { isIncluded, normalizeRelPath } from '../src/core/paths'
import { heads, resolve } from '../src/core/reconcile'
import type { CaptureEvent, FileEntry, Policy, SyncEvent } from '../src/core/types'
import { parseEvent } from '../src/core/validate'

const W = 'world-1'
const h = (c: string): string => c.repeat(64).slice(0, 64)
let seq = 0

function files(spec: Record<string, [string, number]>): FileEntry[] {
  return Object.entries(spec).map(([path, [hashChar, mtimeMs]]) => ({ path, size: 10, sha256: h(hashChar), mtimeMs }))
}
function capture(device: string, fs: FileEntry[], parents: string[] = [], id = `e${++seq}`): CaptureEvent {
  return { schema: 1, id, worldId: W, deviceId: device, deviceName: device.toUpperCase(), at: ++seq, kind: 'capture', contentId: contentIdOf(W, fs), files: fs, parents, reason: 'local' }
}
function policy(p: Policy, extra: Partial<SyncEvent> = {}): SyncEvent {
  return { schema: 1, id: `p${++seq}`, worldId: W, deviceId: 'a', deviceName: 'A', at: ++seq, kind: 'policy', policy: p, ...extra } as SyncEvent
}

describe('content identity', () => {
  it('ignores order, timestamps and contributors', () => {
    const a = files({ 'x.sav': ['a', 1], 'y.sav': ['b', 2] })
    const b = files({ 'y.sav': ['b', 99], 'x.sav': ['a', 50] })
    expect(contentIdOf(W, a)).toBe(contentIdOf(W, b))
    expect(contentIdOf(W, a)).not.toBe(contentIdOf(W, files({ 'x.sav': ['c', 1], 'y.sav': ['b', 2] })))
  })
})

describe('paths', () => {
  it('rejects traversal and absolute paths', () => {
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:\\x', 'a//b', 'con.txt', 'a\0b', '']) expect(normalizeRelPath(bad)).toBeNull()
    expect(normalizeRelPath('sub\\file.a7s')).toBe('sub/file.a7s')
  })
  it('matches globs', () => {
    expect(isIncluded('game.a7s', ['*.a7s'], ['accountdata.a7s'])).toBe(true)
    expect(isIncluded('AccountData.a7s', ['*.a7s'], ['accountdata.a7s'])).toBe(false)
    expect(isIncluded('sub/x.a7s', ['*.a7s'], [])).toBe(false)
    expect(isIncluded('sub/x.a7s', ['**/*.a7s'], [])).toBe(true)
  })
})

describe('history', () => {
  it('groups identical bytes from three devices with three capture events', () => {
    const fs = files({ 'w.a7s': ['a', 1] })
    const groups = buildHistory([capture('a', fs), capture('b', fs), capture('c', fs)])
    expect(groups).toHaveLength(1)
    expect(groups[0].contributions.map((c) => c.deviceId)).toEqual(['a', 'b', 'c'])
  })
  it('download/apply changes availability, not contribution', () => {
    const fs = files({ 'w.a7s': ['a', 1] })
    const cap = capture('a', fs)
    const applied: SyncEvent = { schema: 1, id: 'ap', worldId: W, deviceId: 'd', deviceName: 'D', at: 99, kind: 'applied', contentId: cap.contentId, versionIds: [cap.id] }
    const [g] = buildHistory([cap, applied])
    expect(g.contributions).toHaveLength(1)
    expect(g.availableOn.map((d) => d.deviceId)).toEqual(['a', 'd'])
  })
  it('different bytes stay separate (no equivalence claimed)', () => {
    expect(buildHistory([capture('a', files({ 'w.a7s': ['a', 1] })), capture('b', files({ 'w.a7s': ['b', 1] }))])).toHaveLength(2)
  })
  it('policy changes leave history untouched', () => {
    const evs = [capture('a', files({ 'w.a7s': ['a', 1] })), capture('b', files({ 'w.a7s': ['b', 2] }))]
    const before = JSON.stringify(buildHistory(evs))
    expect(JSON.stringify(buildHistory([...evs, policy('latest-modified')]))).toBe(before)
  })
})

describe('reconcile', () => {
  it('accepts a descendant automatically and ignores an older ancestor', () => {
    const base = capture('a', files({ 'w.a7s': ['a', 1] }))
    const next = capture('b', files({ 'w.a7s': ['b', 2] }), [base.id])
    const res = resolve([next, base])
    expect(res.state).toBe('ok')
    expect('accepted' in res && res.accepted.versionIds).toEqual([next.id])
  })
  it('deduplicates identical continuations into one candidate', () => {
    const base = capture('a', files({ 'w.a7s': ['a', 1] }))
    const same = files({ 'w.a7s': ['b', 2] })
    const res = resolve([base, capture('a', same, [base.id]), capture('b', same, [base.id]), capture('c', same, [base.id])])
    expect(res.state).toBe('ok')
    expect('accepted' in res && res.accepted.versionIds).toHaveLength(3)
  })
  it('detects competing continuations and asks by default', () => {
    const base = capture('a', files({ 'w.a7s': ['a', 1] }))
    const res = resolve([base, capture('b', files({ 'w.a7s': ['b', 5] }), [base.id]), capture('c', files({ 'w.a7s': ['c', 3] }), [base.id])])
    expect(res.state).toBe('conflict')
  })
  it('latest-modified uses original mtime and a stable tie-break', () => {
    const base = capture('a', files({ 'w.a7s': ['a', 1] }))
    const b = capture('b', files({ 'w.a7s': ['b', 5] }), [base.id])
    const c = capture('c', files({ 'w.a7s': ['c', 3] }), [base.id])
    const res = resolve([base, c, b, policy('latest-modified')])
    expect(res.state === 'auto-resolved' && res.accepted.contentId).toBe(b.contentId)

    const t1 = capture('b', files({ 'w.a7s': ['d', 7] }), [base.id])
    const t2 = capture('c', files({ 'w.a7s': ['e', 7] }), [base.id])
    const r1 = resolve([base, t1, t2, policy('latest-modified')])
    const r2 = resolve([policy('latest-modified'), t2, base, t1])
    expect(r1.state === 'auto-resolved' && r1.accepted.contentId).toBe(r2.state === 'auto-resolved' && r2.accepted.contentId)
  })
  it('a decision stops the rejected branch from reappearing, and the earliest decision wins', () => {
    const base = capture('a', files({ 'w.a7s': ['a', 1] }))
    const b = capture('b', files({ 'w.a7s': ['b', 5] }), [base.id])
    const c = capture('c', files({ 'w.a7s': ['c', 3] }), [base.id])
    const d1: SyncEvent = { schema: 1, id: 'd1', worldId: W, deviceId: 'a', deviceName: 'A', at: 1000, kind: 'decision', candidates: [b.id, c.id], selected: c.id, basis: 'user' }
    const d2: SyncEvent = { ...d1, id: 'd2', at: 1001, selected: b.id, deviceId: 'b' }
    const res = resolve([base, b, c, d2, d1])
    expect(res.state === 'ok' && res.accepted.contentId).toBe(c.contentId)
    // Continuing from the winner keeps resolving cleanly; the loser stays in history.
    const next = capture('c', files({ 'w.a7s': ['f', 9] }), [c.id])
    expect(heads([base, b, c, d1, d2, next]).map((e) => e.id)).toEqual([next.id])
    expect(buildHistory([base, b, c, d1, next]).map((g) => g.contentId)).toContain(b.contentId)
  })
  it('preferred device wins genuine conflicts', () => {
    const base = capture('a', files({ 'w.a7s': ['a', 1] }))
    const b = capture('b', files({ 'w.a7s': ['b', 1] }), [base.id])
    const c = capture('c', files({ 'w.a7s': ['c', 9] }), [base.id])
    const res = resolve([base, b, c, policy('preferred-device', { preferredDeviceId: 'b' } as Partial<SyncEvent>)])
    expect(res.state === 'auto-resolved' && res.accepted.contentId).toBe(b.contentId)
  })
})

describe('signing and validation', () => {
  it('round-trips a signed event and rejects tampering', () => {
    const id = newIdentity()
    const fs = files({ 'w.a7s': ['a', 1] })
    const ev = signEvent({ ...capture(id.deviceId, fs), id: '0f0e-1' }, id)
    const parsed = parseEvent(JSON.parse(JSON.stringify(ev)), W, id.deviceId)!
    expect(parsed).not.toBeNull()
    expect(verifyEvent(parsed, id.publicKey)).toBe(true)
    expect(verifyEvent({ ...parsed, deviceName: 'Mallory' }, id.publicKey)).toBe(false)
    expect(verifyEvent(parsed, newIdentity().publicKey)).toBe(false)
  })
  it('rejects malformed manifests', () => {
    const id = newIdentity()
    const fs = files({ 'w.a7s': ['a', 1] })
    const ev = signEvent({ ...capture(id.deviceId, fs), id: 'x1' }, id)
    expect(parseEvent({ ...ev, files: [{ ...fs[0], path: '../evil' }] }, W, id.deviceId)).toBeNull()
    expect(parseEvent({ ...ev, contentId: h('f') }, W, id.deviceId)).toBeNull()
    expect(parseEvent(ev, W, 'someone-else')).toBeNull()
    expect(parseEvent(ev, 'other-world', id.deviceId)).toBeNull()
  })
  it('invite codes round-trip and reject forged keys', () => {
    const id = newIdentity()
    const inv = { v: 1 as const, name: 'Alice PC', deviceId: id.deviceId, publicKey: id.publicKey, syncthingId: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH' }
    expect(decodeInvite(encodeInvite(inv))).toEqual(inv)
    expect(decodeInvite(encodeInvite({ ...inv, publicKey: newIdentity().publicKey }))).toBeNull()
    expect(decodeInvite('garbage')).toBeNull()
  })
})
