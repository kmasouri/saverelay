// How far this PC's clock is from real time, read from the Date header of an HTTPS
// reply from GitHub (already contacted for updates, and TLS keeps the answer honest).

const TIME_URL = 'https://github.com'

/**
 * Milliseconds to add to this PC's clock to get real time, or null when the check
 * fails (offline, blocked, no Date header).
 */
export async function measureClockOffset(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<number | null> {
  try {
    const sent = now()
    const res = await fetchImpl(TIME_URL, { method: 'HEAD', signal: AbortSignal.timeout(5_000) })
    const received = now()
    const server = Date.parse(res.headers.get('date') ?? '')
    if (!Number.isFinite(server)) return null
    // The header is truncated to the second; the reply was sent about halfway through the round trip.
    return Math.round(server + 500 - (sent + received) / 2)
  } catch {
    return null
  }
}
