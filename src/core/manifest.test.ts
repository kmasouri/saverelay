import { describe, expect, it } from 'vitest'
import { files, W } from './core.test-fixtures'
import { contentIdOf } from './manifest'

describe('content identity', () => {
  it('ignores order, timestamps and contributors', () => {
    const a = files({ 'x.sav': ['a', 1], 'y.sav': ['b', 2] })
    const b = files({ 'y.sav': ['b', 99], 'x.sav': ['a', 50] })
    expect(contentIdOf(W, a)).toBe(contentIdOf(W, b))
    expect(contentIdOf(W, a)).not.toBe(contentIdOf(W, files({ 'x.sav': ['c', 1], 'y.sav': ['b', 2] })))
  })
})
