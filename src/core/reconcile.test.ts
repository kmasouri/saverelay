import { describe, expect, it } from 'vitest'
import { capture, files, policy, W } from './core.test-fixtures'
import { buildHistory } from './history'
import { heads, resolve } from './reconcile'
import type { SyncEvent } from './types'

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
