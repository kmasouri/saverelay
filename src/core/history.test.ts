import { describe, expect, it } from 'vitest'
import { capture, files, policy, W } from './core.test-fixtures'
import { buildHistory } from './history'
import type { SyncEvent } from './types'

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
