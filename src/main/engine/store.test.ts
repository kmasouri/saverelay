import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldStore } from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('staging store', () => {
  it("doesn't rewrite its ignore file on every start", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'saverelay-store-'))
    dirs.push(dir)
    await new WorldStore(dir, 'w1').init()
    const ignore = join(dir, '.stignore')
    const before = await readFile(ignore, 'utf8')
    // Stand-in for Windows refusing to replace a hidden file: make it read-only.
    await chmod(ignore, 0o444)
    await new WorldStore(dir, 'w1').init()
    expect(await readFile(ignore, 'utf8')).toBe(before)
    expect((await stat(ignore)).mode & 0o777).toBe(0o444)
  })
})
