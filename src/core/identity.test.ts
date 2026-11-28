import { describe, expect, it } from 'vitest'
import { capture, files, W } from './core.test-fixtures'
import { decodeInvite, encodeInvite, newIdentity, signEvent, verifyEvent } from './identity'
import { parseEvent } from './validate'

describe('identity', () => {
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
  it('invite codes round-trip and reject forged keys', () => {
    const id = newIdentity()
    const inv = { v: 1 as const, name: 'Alice PC', deviceId: id.deviceId, publicKey: id.publicKey, syncthingId: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH' }
    expect(decodeInvite(encodeInvite(inv))).toEqual(inv)
    expect(decodeInvite(encodeInvite({ ...inv, publicKey: newIdentity().publicKey }))).toBeNull()
    expect(decodeInvite('garbage')).toBeNull()
  })
})
