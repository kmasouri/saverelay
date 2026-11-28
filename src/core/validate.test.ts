import { describe, expect, it } from 'vitest'
import { capture, files, h, W } from './core.test-fixtures'
import { newIdentity, signEvent } from './identity'
import { parseEvent } from './validate'

describe('event validation', () => {
  it('rejects malformed manifests', () => {
    const id = newIdentity()
    const fs = files({ 'w.a7s': ['a', 1] })
    const ev = signEvent({ ...capture(id.deviceId, fs), id: 'x1' }, id)
    expect(parseEvent({ ...ev, files: [{ ...fs[0], path: '../evil' }] }, W, id.deviceId)).toBeNull()
    expect(parseEvent({ ...ev, contentId: h('f') }, W, id.deviceId)).toBeNull()
    expect(parseEvent(ev, W, 'someone-else')).toBeNull()
    expect(parseEvent(ev, 'other-world', id.deviceId)).toBeNull()
  })
})
