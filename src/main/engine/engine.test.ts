// Three simulated devices with an in-memory transport that copies staging stores
// between peers who share a folder, standing in for Syncthing.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeInvite, newIdentity } from '../../core/identity'
import { Engine } from './engine'
import { FOLDER_PREFIX, type Syncthing } from './syncthing'

interface FakeFolder {
  path: string
  devices: string[]
  label: string
}

class FakeNet {
  folders = new Map<string, Map<string, FakeFolder>>()
  offline = new Set<string>()
  /** Connection attempts each device's transport reports, keyed by that device's id. */
  pending = new Map<string, { deviceId: string; name: string; address: string }[]>()

  syncthingFor(myId: string): Syncthing {
    const net = this
    this.folders.set(myId, new Map())
    const fake = {
      myId,
      running: true,
      async ensureDevice() {},
      async removeDevice() {},
      async scan() {},
      async ensureFolder(worldId: string, label: string, path: string, devices: string[]) {
        net.folders.get(myId)!.set(FOLDER_PREFIX + worldId, { path, devices, label })
      },
      async removeFolder(worldId: string) {
        net.folders.get(myId)!.delete(FOLDER_PREFIX + worldId)
      },
      async pendingFolders() {
        const offers = new Map<string, { folderId: string; label: string; offeredBy: string[] }>()
        for (const [other, folders] of net.folders) {
          if (other === myId) continue
          for (const [folderId, f] of folders) {
            if (!f.devices.includes(myId) || net.folders.get(myId)!.has(folderId)) continue
            const o = offers.get(folderId) ?? { folderId, label: f.label, offeredBy: [] }
            o.offeredBy.push(other)
            offers.set(folderId, o)
          }
        }
        return [...offers.values()]
      },
      async pendingDevices() {
        return net.pending.get(myId) ?? []
      },
      async setOwnName() {},
      async dismissPendingDevice() {},
      async connections() {
        return Object.fromEntries([...net.folders.keys()].map((id) => [id, !net.offline.has(id)]))
      },
      async lastSeen() {
        return {}
      },
    }
    return fake as unknown as Syncthing
  }

  /** Copies every file one side has and the other lacks, for mutually shared folders. */
  async exchange(): Promise<void> {
    for (const [a, fa] of this.folders) {
      for (const [b, fb] of this.folders) {
        if (a === b || this.offline.has(a) || this.offline.has(b)) continue
        for (const [folderId, src] of fa) {
          const dst = fb.get(folderId)
          if (!dst || !src.devices.includes(b) || !dst.devices.includes(a)) continue
          await copyMissing(src.path, dst.path)
        }
      }
    }
  }
}

async function copyMissing(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.endsWith('.sr-tmp') || entry.name === '.stignore') continue
    const s = join(from, entry.name)
    const d = join(to, entry.name)
    if (entry.isDirectory()) {
      await mkdir(d, { recursive: true })
      await copyMissing(s, d)
    } else if (!existsSync(d)) {
      await cp(s, d)
    }
  }
}

const stId = (c: string): string => Array.from({ length: 8 }, () => c.repeat(7)).join('-')

interface Device {
  name: string
  engine: Engine
  saves: string
  running: Set<string>
  dataDir: string
}

let root: string
let net: FakeNet
let clock: number
let devices: Record<'a' | 'b' | 'c', Device>
/** How far each device's clock is behind real time; null = can't check. */
const clockOffsets: Record<string, number | null> = {}
const notes: string[] = []

async function makeDevice(name: string, letter: string): Promise<Device> {
  const dataDir = join(root, name, 'data')
  const saves = join(root, name, 'saves')
  await mkdir(saves, { recursive: true })
  const running = new Set<string>()
  const engine = await Engine.create({
    dataDir,
    documentsDir: join(root, name, 'docs'),
    syncthing: net.syncthingFor(stId(letter)),
    detector: { running: async () => running },
    notify: (t, b) => notes.push(`${name}: ${t}: ${b}`),
    log: () => {},
    now: () => clock,
    clockOffset: async () => clockOffsets[letter.toLowerCase()] ?? 0,
    settleMs: 1000,
    stableMs: 1000,
  })
  await engine.setDeviceName(name)
  return { name, engine, saves, running, dataDir }
}

async function writeSave(d: Device, file: string, content: string, mtime: number): Promise<void> {
  const p = join(d.saves, file)
  await writeFile(p, content)
  await utimes(p, new Date(mtime), new Date(mtime))
}
const readSave = (d: Device, file = 'world.a7s'): Promise<string> => readFile(join(d.saves, file), 'utf8')

async function rounds(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    clock += 2000
    for (const d of Object.values(devices)) await d.engine.tick()
    await net.exchange()
  }
}

const world = (d: Device) => d.engine.snapshot().worlds[0]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'saverelay-'))
  net = new FakeNet()
  clock = 1_700_000_000_000
  notes.length = 0
  for (const k of Object.keys(clockOffsets)) delete clockOffsets[k]
  devices = { a: await makeDevice('Alice', 'A'), b: await makeDevice('Bob', 'B'), c: await makeDevice('Cara', 'C') }
  // Explicit pairwise trust: everyone pastes everyone else's invite.
  for (const x of Object.values(devices)) for (const y of Object.values(devices)) if (x !== y) await x.engine.addPeer(y.engine.invite())

  await writeSave(devices.a, 'world.a7s', 'v0', 1_000)
  await writeSave(devices.b, 'world.a7s', 'bob-old-unrelated', 500)
  const peers = devices.a.engine.config.peers.map((p) => p.deviceId)
  await devices.a.engine.addWorld({ name: 'The Betrayers', gameId: 'anno-1800', localPath: devices.a.saves, processNames: ['Anno1800.exe'], include: ['*.a7s'], exclude: ['accountdata.a7s'], sharedWith: peers })
  await rounds(2)
  for (const d of [devices.b, devices.c]) {
    const inv = d.engine.snapshot().invitations
    expect(inv).toHaveLength(1)
    await d.engine.joinWorld(inv[0].folderId, { name: inv[0].label, gameId: 'anno-1800', localPath: d.saves, processNames: ['Anno1800.exe'], include: ['*.a7s'], exclude: ['accountdata.a7s'], sharedWith: [], mode: 'receive' })
  }
  await rounds()
})

afterEach(async () => {
  for (const d of Object.values(devices)) await d.engine.stop()
  await rm(root, { recursive: true, force: true })
})

describe('three friends sharing one world', () => {
  it('clears files of versions past the group limit, keeping the latest and recent ones', async () => {
    await devices.a.engine.setKeepVersions(world(devices.a).id, 5)
    for (let i = 1; i <= 8; i++) {
      await writeSave(devices.a, 'world.a7s', `session-${i}`, 10_000 + i)
      await rounds()
    }
    clock += 11 * 60_000
    await rounds(2)
    const { graph, groups } = await devices.a.engine.history(world(devices.a).id)
    expect(graph.nodes.filter((n) => !n.cleared)).toHaveLength(5)
    expect(graph.nodes.some((n) => n.cleared)).toBe(true)
    for (const d of Object.values(devices)) {
      for (const n of graph.nodes) {
        const sha = groups.find((g) => g.contentId === n.contentId)!.files[0].sha256
        const kept = await stat(join(d.dataDir, 'staging', world(d).id, 'objects', sha.slice(0, 2), sha)).then(
          () => true,
          () => false,
        )
        expect(kept, `${d.name} row ${n.row}`).toBe(!n.cleared)
      }
      expect(world(d).policy.keepVersions).toBe(5)
      expect(world(d).storageBytes).toBeGreaterThan(0)
    }
    expect(await readSave(devices.c)).toBe('session-8')
  })

  it('joining devices receive the shared world; their old local saves are backed up', async () => {
    expect(await readSave(devices.b)).toBe('v0')
    expect(await readSave(devices.c)).toBe('v0')
    for (const d of Object.values(devices)) expect(world(d).status).toBe('up-to-date')
    const backups = await readdir(join(devices.b.dataDir, 'backups', world(devices.b).id))
    expect(backups.length).toBeGreaterThan(0)
    const backed = await readFile(join(devices.b.dataDir, 'backups', world(devices.b).id, backups[0], 'world.a7s'), 'utf8')
    expect(backed).toBe('bob-old-unrelated')
  })

  it('handoff: one player continues, the others receive it automatically', async () => {
    await writeSave(devices.b, 'world.a7s', 'v1-bob', 2_000)
    await rounds()
    expect(await readSave(devices.a)).toBe('v1-bob')
    expect(await readSave(devices.c)).toBe('v1-bob')
    // Applying remote content never re-publishes it.
    const { groups } = await devices.a.engine.history(world(devices.a).id)
    expect(groups).toHaveLength(2)
    expect(groups[0].contributions.map((c) => c.deviceName)).toEqual(['Bob'])
    expect(groups[0].availableOn.map((d) => d.deviceName).sort()).toEqual(['Alice', 'Bob', 'Cara'])
  })

  it('identical saves from all three deduplicate into one version with three contributors', async () => {
    for (const d of Object.values(devices)) await writeSave(d, 'world.a7s', 'session-end', 3_000)
    await rounds()
    const { groups } = await devices.a.engine.history(world(devices.a).id)
    expect(groups[0].contributions.map((c) => c.deviceName).sort()).toEqual(['Alice', 'Bob', 'Cara'])
    for (const d of Object.values(devices)) expect(world(d).status).toBe('up-to-date')
  })

  it('no live writes while the game runs; the update applies after exit', async () => {
    devices.c.running.add('anno1800.exe')
    await rounds(2)
    await writeSave(devices.a, 'world.a7s', 'v1-alice', 2_000)
    await rounds()
    expect(world(devices.c).status).toBe('playing')
    expect(world(devices.c).pendingUpdate).toBe(true)
    expect(await readSave(devices.c)).toBe('v0')
    devices.c.running.clear()
    await rounds()
    expect(await readSave(devices.c)).toBe('v1-alice')
  })

  it('a session that ends locally while an update was queued becomes a conflict, not a silent overwrite', async () => {
    devices.c.running.add('anno1800.exe')
    await rounds(2)
    await writeSave(devices.a, 'world.a7s', 'v1-alice', 2_000)
    await rounds()
    await writeSave(devices.c, 'world.a7s', 'v1-cara', 2_500)
    devices.c.running.clear()
    await rounds()
    expect(await readSave(devices.c)).toBe('v1-cara')
    for (const d of Object.values(devices)) expect(world(d).status).toBe('conflict')
  })

  it('independent continuations: ask policy preserves both, a choice converges everyone', async () => {
    net.offline.add(stId('C'))
    await writeSave(devices.b, 'world.a7s', 'bob-branch', 5_000)
    await rounds()
    net.offline.delete(stId('C'))
    net.offline.add(stId('B'))
    await writeSave(devices.c, 'world.a7s', 'cara-branch', 4_000)
    await rounds()
    net.offline.clear()
    await rounds()
    for (const d of Object.values(devices)) expect(world(d).status).toBe('conflict')
    expect(notes.some((n) => n.includes('choose a version'))).toBe(true)

    const cara = world(devices.a).conflict!.find((c) => c.deviceNames.includes('Cara'))!
    await devices.a.engine.chooseCandidate(world(devices.a).id, cara.contentId)
    await rounds()
    for (const d of Object.values(devices)) {
      expect(await readSave(d)).toBe('cara-branch')
      expect(world(d).status).toBe('up-to-date')
    }
    // Bob's branch survives in history and in his backups.
    const { groups } = await devices.b.engine.history(world(devices.b).id)
    expect(groups.some((g) => g.contributions.some((c) => c.deviceName === 'Bob'))).toBe(true)
  })

  it('latest-modified policy converges every peer on the newest original save time', async () => {
    await devices.b.engine.setPolicy(world(devices.b).id, 'latest-modified')
    await rounds()
    net.offline.add(stId('B'))
    await writeSave(devices.c, 'world.a7s', 'cara-newer', 9_000)
    await rounds()
    net.offline.clear()
    net.offline.add(stId('C'))
    await writeSave(devices.b, 'world.a7s', 'bob-older', 8_000)
    await rounds()
    net.offline.clear()
    await rounds()
    for (const d of Object.values(devices)) expect(await readSave(d)).toBe('cara-newer')
    // Switching back to "ask" later must not resurrect the resolved conflict.
    await devices.a.engine.setPolicy(world(devices.a).id, 'ask')
    await rounds()
    for (const d of Object.values(devices)) expect(world(d).status).toBe('up-to-date')
  })

  it('latest-modified sees through a clock set ahead, and warns its owner', async () => {
    await devices.b.engine.setPolicy(world(devices.b).id, 'latest-modified')
    await rounds()
    net.offline.add(stId('B'))
    await writeSave(devices.c, 'world.a7s', 'cara-real-newest', 9_000)
    await rounds()
    net.offline.clear()
    net.offline.add(stId('C'))
    // Bob's clock is an hour ahead, so his older save carries a later time.
    clockOffsets.b = -3_600_000
    await writeSave(devices.b, 'world.a7s', 'bob-clock-ahead', 3_600_000 + 8_000)
    await rounds()
    clockOffsets.b = 0
    net.offline.clear()
    await rounds()
    for (const d of Object.values(devices)) expect(await readSave(d)).toBe('cara-real-newest')
    expect(notes.some((n) => n.startsWith('Bob:') && n.includes('60 minutes ahead'))).toBe(true)
  })

  it('a stale device coming back does not roll back shared progress', async () => {
    net.offline.add(stId('C'))
    await writeSave(devices.a, 'world.a7s', 'v1', 2_000)
    await rounds()
    await writeSave(devices.b, 'world.a7s', 'v2', 3_000)
    await rounds()
    net.offline.clear()
    await rounds()
    for (const d of Object.values(devices)) expect(await readSave(d)).toBe('v2')
  })

  it('restore re-activates an earlier version as a new attributed event', async () => {
    const first = (await devices.a.engine.history(world(devices.a).id)).groups[0]
    await writeSave(devices.a, 'world.a7s', 'v1', 2_000)
    await rounds()
    await devices.b.engine.restore(world(devices.b).id, first.contentId)
    await rounds()
    for (const d of Object.values(devices)) expect(await readSave(d)).toBe('v0')
    const { groups } = await devices.c.engine.history(world(devices.c).id)
    const restored = groups.find((g) => g.contentId === first.contentId)!
    expect(restored.contributions.map((c) => `${c.deviceName}:${c.reason}`)).toEqual(['Alice:import', 'Bob:restore'])
  })

  it('ignores events from untrusted devices', async () => {
    const w = world(devices.a)
    const dir = join(devices.a.dataDir, 'staging', w.id, 'events', 'deadbeefdeadbeefdeadbeef')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'x.json'), '{}')
    await rounds(1)
    expect(world(devices.a).warnings.join()).toContain('untrusted device')
    expect(await readSave(devices.a)).toBe('v0')
  })
})

describe('friend requests', () => {
  const stranger = (name: string, syncthingId = stId('Z')): string => {
    const id = newIdentity()
    return encodeInvite({ v: 1, name, deviceId: id.deviceId, publicKey: id.publicKey, syncthingId })
  }
  const attempt = (to: Device, deviceId: string, name: string): void => void net.pending.set(stId(to === devices.a ? 'A' : 'B'), [{ deviceId, name, address: '' }])

  it('turns a connection that carries a matching invite into a request, and accepting adds the friend', async () => {
    attempt(devices.a, stId('Z'), stranger('DefectiveWombat'))
    await rounds(1)
    expect(devices.a.engine.snapshot().friendRequests.map((r) => r.name)).toEqual(['DefectiveWombat'])
    expect(await devices.a.engine.acceptFriendRequest(stId('Z'))).toBe('DefectiveWombat')
    expect(devices.a.engine.snapshot().peers.map((p) => p.name)).toContain('DefectiveWombat')
    await rounds(1)
    expect(devices.a.engine.snapshot().friendRequests).toEqual([])
  })

  it("doesn't trust an invite that belongs to a different PC than the one connecting", async () => {
    attempt(devices.a, stId('Y'), stranger('Impostor', stId('Z')))
    await rounds(1)
    expect(devices.a.engine.snapshot().friendRequests).toEqual([])
    expect(devices.a.engine.snapshot().pendingDevices.map((d) => d.deviceId)).toEqual([stId('Y')])
  })

  it('keeps ignored and unfriended people quiet until you add them again', async () => {
    const code = stranger('Pest')
    attempt(devices.a, stId('Z'), code)
    await rounds(1)
    await devices.a.engine.ignoreFriendRequest(stId('Z'))
    await rounds(1)
    expect(devices.a.engine.snapshot().friendRequests).toEqual([])
    await devices.a.engine.addPeer(code)
    expect(devices.a.engine.snapshot().peers.map((p) => p.name)).toContain('Pest')

    const bob = devices.a.engine.config.peers.find((p) => p.name === 'Bob')!
    await devices.a.engine.removePeer(bob.deviceId)
    attempt(devices.a, bob.syncthingId, devices.b.engine.invite())
    await rounds(1)
    expect(devices.a.engine.snapshot().friendRequests).toEqual([])
    expect(devices.a.engine.snapshot().pendingDevices).toEqual([])
  })
})
