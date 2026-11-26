import { describe, expect, it } from 'vitest'
import { createShutdown } from '../src/main/lifecycle'

describe('shutdown', () => {
  it('stops everything newest first, then exits once', async () => {
    const calls: string[] = []
    const s = createShutdown((code) => calls.push(`exit ${code}`), () => undefined)
    s.add({ name: 'marker', run: () => void calls.push('marker'), timeoutMs: 100 })
    s.add({ name: 'sync', run: async () => void calls.push('sync'), timeoutMs: 100 })
    s.add({ name: 'engine', run: async () => void calls.push('engine'), timeoutMs: 100 })
    expect(s.finished).toBe(false)
    await Promise.all([s.run(0), s.run(1)])
    expect(calls).toEqual(['engine', 'sync', 'marker', 'exit 0'])
    expect(s.finished).toBe(true)
  })

  it('keeps going past a step that hangs or fails', async () => {
    const calls: string[] = []
    const logs: string[] = []
    const s = createShutdown((code) => calls.push(`exit ${code}`), (m) => logs.push(m))
    s.add({ name: 'sync', run: () => void calls.push('sync'), timeoutMs: 100 })
    s.add({ name: 'broken', run: () => Promise.reject(new Error('boom')), timeoutMs: 100 })
    s.add({ name: 'stuck', run: () => new Promise(() => undefined), timeoutMs: 20 })
    await s.run(1, () => calls.push('dialog'))
    expect(calls).toEqual(['sync', 'dialog', 'exit 1'])
    expect(logs.some((l) => l.includes('gave up waiting for stuck'))).toBe(true)
    expect(logs.some((l) => l.includes('broken failed: boom'))).toBe(true)
  })

  it('still exits if the error dialog itself throws', async () => {
    const calls: string[] = []
    const s = createShutdown((code) => calls.push(`exit ${code}`), () => undefined)
    await s.run(1, () => {
      throw new Error('no display')
    })
    expect(calls).toEqual(['exit 1'])
  })
})
