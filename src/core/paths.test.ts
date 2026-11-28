import { describe, expect, it } from 'vitest'
import { isIncluded, normalizeRelPath } from './paths'

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
