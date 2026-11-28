import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recoverJournal } from './applier'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'saverelay-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('crash recovery', () => {
  it('rolls back an interrupted apply', async () => {
    const live = join(root, 'live')
    const backup = join(root, 'backup')
    await mkdir(live, { recursive: true })
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'a.a7s'), 'original')
    await writeFile(join(live, 'a.a7s'), 'half-written')
    await writeFile(join(live, 'b.a7s'), 'new-file')
    const journal = join(root, 'journal.json')
    await writeFile(journal, JSON.stringify({ root: live, backupDir: backup, previous: ['a.a7s'] }))
    expect(await recoverJournal(journal, ['*.a7s'], [])).toBe(true)
    expect(await readFile(join(live, 'a.a7s'), 'utf8')).toBe('original')
    expect(existsSync(join(live, 'b.a7s'))).toBe(false)
    expect(existsSync(journal)).toBe(false)
  })
})
