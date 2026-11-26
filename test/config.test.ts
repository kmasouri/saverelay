import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/main/engine/config'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function withConfig(deviceName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'saverelay-cfg-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  const fresh = await loadConfig(path)
  await writeFile(path, JSON.stringify({ ...fresh, deviceName, nameChosen: undefined }))
  return path
}

describe('screen name', () => {
  it('asks a new install for a name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'saverelay-cfg-'))
    dirs.push(dir)
    expect((await loadConfig(join(dir, 'config.json'))).nameChosen).toBe(false)
  })
  it('asks an existing install still on the PC name', async () => {
    expect((await loadConfig(await withConfig(hostname().slice(0, 64)))).nameChosen).toBe(false)
  })
  it("doesn't ask someone who already picked a name", async () => {
    const path = await withConfig('DefectiveWombat')
    expect((await loadConfig(path)).nameChosen).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).deviceName).toBe('DefectiveWombat')
  })
})

describe('staging store', () => {
  it("doesn't rewrite its ignore file on every start", async () => {
    const { WorldStore } = await import('../src/main/engine/store')
    const { chmod, stat } = await import('node:fs/promises')
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
