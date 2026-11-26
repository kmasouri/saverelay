// End-to-end transport test with two real Syncthing instances on localhost.
// Runs only when SYNCTHING_BIN points at a Syncthing binary (CI fetches one).

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Engine } from '../src/main/engine/engine'
import { Syncthing } from '../src/main/engine/syncthing'

const BIN = process.env.SYNCTHING_BIN

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0))
    })
  })
}

const logs: string[] = []
let dump: () => Promise<string> = async () => ''

async function listTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    out.push(prefix + e.name)
    if (e.isDirectory()) out.push(...(await listTree(join(dir, e.name), prefix + e.name + '/')))
  }
  return out
}

async function until(what: string, fn: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log(await dump())
  console.log(logs.slice(-150).join('\n'))
  throw new Error(`Timed out waiting for ${what}`)
}

describe.skipIf(!BIN)('real Syncthing transport', () => {
  const cleanup: (() => Promise<void>)[] = []
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined)
  })

  it('pairs two devices, offers a world, and hands off a save', { timeout: 300_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'saverelay-st-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))

    const make = async (name: string) => {
      const port = await freePort()
      const st = new Syncthing({
        binary: BIN!,
        home: join(root, name, 'st'),
        apiKey: `key-${name}-0123456789`,
        log: (m) => logs.push(`${name} ${m}`),
        options: { listenAddresses: [`tcp://127.0.0.1:${port}`], globalAnnounceEnabled: false, localAnnounceEnabled: false, relaysEnabled: false, natEnabled: false },
      })
      await st.start()
      cleanup.push(() => st.stop())
      const saves = join(root, name, 'saves')
      await mkdir(saves, { recursive: true })
      const engine = await Engine.create({
        dataDir: join(root, name, 'data'),
        documentsDir: root,
        syncthing: st,
        detector: { running: async () => new Set<string>() },
        notify: (t, m) => logs.push(`${name} NOTIFY ${t}: ${m}`),
        log: (m) => logs.push(`${name} ENGINE ${m}`),
        settleMs: 0,
        stableMs: 500,
      })
      await engine.setDeviceName(name)
      cleanup.push(() => engine.stop())
      return { st, port, saves, engine }
    }

    const a = await make('Alice')
    const b = await make('Bob')
    dump = async () =>
      JSON.stringify({ a: a.engine.snapshot().worlds, b: b.engine.snapshot().worlds, aTree: await listTree(join(root, 'Alice', 'data', 'staging')), bTree: await listTree(join(root, 'Bob', 'data', 'staging')), bSaves: await listTree(b.saves) }, null, 1)
    await a.engine.addPeer(b.engine.invite())
    await b.engine.addPeer(a.engine.invite())
    await a.st.ensureDevice(b.st.myId, 'Bob', [`tcp://127.0.0.1:${b.port}`])
    await b.st.ensureDevice(a.st.myId, 'Alice', [`tcp://127.0.0.1:${a.port}`])
    await a.engine.start(1000)
    await b.engine.start(1000)
    await until('devices to connect', async () => a.engine.snapshot().peers[0]?.connected === true)

    await writeFile(join(a.saves, 'world.sav'), 'alice-progress-1')
    const bobId = a.engine.config.peers[0].deviceId
    await a.engine.addWorld({ name: 'Test World', gameId: 'custom', localPath: a.saves, processNames: [], include: ['*.sav'], exclude: [], sharedWith: [bobId] })

    await until('Bob to see the invitation', async () => b.engine.snapshot().invitations.length === 1)
    const inv = b.engine.snapshot().invitations[0]
    expect(inv.label).toBe('Test World')
    await b.engine.joinWorld(inv.folderId, { name: inv.label, gameId: 'custom', localPath: b.saves, processNames: [], include: ['*.sav'], exclude: [], sharedWith: [], mode: 'receive' })

    await until('Bob to receive the save', async () => (await readFile(join(b.saves, 'world.sav'), 'utf8')) === 'alice-progress-1')

    // Bob plays on; Alice gets it back.
    await writeFile(join(b.saves, 'world.sav'), 'bob-progress-2')
    await until('Alice to receive Bob’s continuation', async () => (await readFile(join(a.saves, 'world.sav'), 'utf8')) === 'bob-progress-2')

    const { groups } = await a.engine.history(a.engine.snapshot().worlds[0].id)
    expect(groups.map((g) => g.contributions[0].deviceName)).toEqual(['Bob', 'Alice'])
  })
})
