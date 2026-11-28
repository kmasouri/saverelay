import { describe, expect, it } from 'vitest'
import { joinNames, uploadingLine } from './names'

describe('names', () => {
  it('lists two names, then counts the rest', () => {
    expect(joinNames(['Ann'])).toBe('Ann')
    expect(joinNames(['Ann', 'Bo'])).toBe('Ann and Bo')
    expect(joinNames(['Ann', 'Bo', 'Cy'])).toBe('Ann and 2 others')
  })
  it('shows a percentage only for one person', () => {
    expect(uploadingLine(['Ann'], 62)).toBe('Ann is still downloading your save (62%)')
    expect(uploadingLine(['Ann', 'Bo', 'Cy'], null)).toBe('Ann and 2 others are still downloading your save')
  })
})
