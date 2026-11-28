import { describe, expect, it } from 'vitest'
import { measureClockOffset } from './clock'

const reply = (date: string | null): typeof fetch => (async () => new Response(null, { headers: date ? { date } : {} })) as typeof fetch

describe('measureClockOffset', () => {
  it('reads how far behind real time this clock is from the Date header', async () => {
    let t = Date.parse('2026-11-28T10:00:00Z') - 7 * 60_000
    const offset = await measureClockOffset(reply('Sat, 28 Nov 2026 10:00:00 GMT'), () => (t += 100))
    // Seven minutes, less half the 100 ms round trip, plus half a second for the truncated header.
    expect(offset).toBe(7 * 60_000 - 150 + 500)
  })
  it('gives up without a usable answer', async () => {
    expect(await measureClockOffset(reply(null))).toBeNull()
    expect(await measureClockOffset((async () => { throw new Error('offline') }) as typeof fetch)).toBeNull()
  })
})
