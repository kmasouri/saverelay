// Background sync engine. Electron-free so it can be driven headless in tests.
//
// Per world, every tick:
//   game running  -> freeze; incoming content stays staged, never touches the live folder
//   game exited   -> wait for writes to settle, capture changed saves as a signed snapshot
//   idle          -> resolve shared history with the group policy and apply the accepted
//                    continuation (backed up + journaled) when its content is fully staged

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { GAMES, gameById, type Placeholder } from '../../core/games'
import { buildGraph, filesToClear, type Graph } from '../../core/graph'
import { buildHistory, type ContentGroup } from '../../core/history'
import { decodeInvite, encodeInvite, signEvent } from '../../core/identity'
import { contentIdOf } from '../../core/manifest'
import { globToRegExp } from '../../core/paths'
import { DEFAULT_KEEP_VERSIONS, currentPolicy, latestDecisions, overruledDecisions, resolve, type Candidate, type Overruled, type Resolution } from '../../core/reconcile'
import { SCHEMA, compareEvents, isVersion, type FileEntry, type Policy, type SyncEvent } from '../../core/types'
import { applySnapshot, recoverJournal } from './applier'
import { findSaves, type FoundSave } from './discovery'
import { loadConfig, saveConfig, type AppConfig, type WorldConfig } from './config'
import { isGameRunning, type ProcessDetector } from './process'
import { scanFolder, type Scan } from './scanner'
import { WorldStore, writeJsonAtomic } from './store'
import { FOLDER_PREFIX, type Syncthing } from './syncthing'

export type WorldStatus = 'setting-up' | 'up-to-date' | 'playing' | 'waiting-for-peer' | 'pending-update' | 'conflict' | 'error'

interface WorldState {
  /** Version ids the live folder currently corresponds to (the next capture's parents). */
  basis: string[]
  /** Version ids live when the current/last game session started. */
  sessionBasis: string[]
  liveSig: string | null
  liveContentId: string | null
  initialized: boolean
  playing: boolean
  exitedAt: number
  pendingSig: string | null
  pendingSince: number
  decided: string[]
  /** This PC's overruled decisions the user has acknowledged. */
  dismissedOverrules: string[]
  lastAppliedAt: number
  lastCaptureAt: number
}

/** A clock further off than this gets a warning. */
const CLOCK_WARN_MS = 2 * 60_000

/** "7 minutes ahead", "3 hours behind" for a clock offset (positive = behind). */
export function describeClockOffset(offsetMs: number): string {
  const mins = Math.round(Math.abs(offsetMs) / 60_000)
  const amount = mins < 120 ? `${mins} minute${mins === 1 ? '' : 's'}` : mins < 2 * 1440 ? `${Math.round(mins / 60)} hours` : `${Math.round(mins / 1440)} days`
  return `${amount} ${offsetMs > 0 ? 'behind' : 'ahead'}`
}

/** How often each save's old versions and backups are cleared and its size recounted. */
const HOUSEKEEPING_MS = 10 * 60_000
/** Backups taken before a friend's save replaces yours, kept per save on this PC. */
const BACKUPS_KEPT = 3
/** The most versions a group can ask to keep; 0 means keep every version. */
export const MAX_KEEP_VERSIONS = 1000

async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? await dirSize(p) : ((await stat(p).catch(() => null))?.size ?? 0)
  }
  return total
}

/** An incoming save that hasn't fully arrived yet. */
export interface Download {
  haveBytes: number
  totalBytes: number
  /** Who made the save being downloaded (never this PC). */
  fromDeviceIds: string[]
  /** When that save was written. */
  savedAt: number
  /** Nobody who could send it is online. */
  paused: boolean
  /** Rough time left at the recent speed; null until there's a speed to go on. */
  etaSeconds: number | null
}

interface Runtime {
  status: WorldStatus
  download?: Download | null
  /** Last progress reading, for the speed estimate. */
  downloadSample?: { contentId: string; at: number; haveBytes: number; rate: number }
  detail: string
  warnings: string[]
  resolution: Resolution | null
  pendingUpdate: boolean
  /** This PC's newest choice that lost to a friend's made at about the same time. */
  overruled: Overruled | null
  notified: Set<string>
}

export interface EngineDeps {
  dataDir: string
  documentsDir: string
  /** Where each games/ placeholder points on this PC; {documents} defaults to documentsDir. */
  places?: Partial<Record<Placeholder, string>>
  syncthing: Syncthing | null
  detector: ProcessDetector
  notify: (title: string, body: string) => void
  log: (msg: string) => void
  now?: () => number
  /** Milliseconds this PC's clock is behind real time, or null when it can't be checked. */
  clockOffset?: () => Promise<number | null>
  settleMs?: number
  stableMs?: number
}

export interface NewWorldInput {
  name: string
  gameId: string
  localPath: string
  processNames: string[]
  include: string[]
  exclude: string[]
  sharedWith: string[]
  mode?: 'contribute' | 'receive'
}

export class Engine extends EventEmitter {
  private states = new Map<string, WorldState>()
  private runtimes = new Map<string, Runtime>()
  private stores = new Map<string, WorldStore>()
  private timer: NodeJS.Timeout | null = null
  private ticking: Promise<void> | null = null
  private transportError: string | null = null
  private pendingDevices: { deviceId: string; name: string; address: string }[] = []
  /** Connection attempts that carry a valid invite: someone added us and waits for us to accept. */
  private friendRequests: { syncthingId: string; deviceId: string; name: string; code: string }[] = []
  private pendingFolders: { folderId: string; label: string; offeredBy: string[] }[] = []
  private connections: Record<string, boolean> = {}
  private lastSeen: Record<string, number> = {}
  private housekeptAt = new Map<string, number>()
  private storage = new Map<string, number>()
  /** The last check of this PC's clock against real time. */
  private clock: { offsetMs: number; checkedAt: number } | null = null
  /** Worlds whose staging store changed locally since the transport last scanned it. */
  private dirty = new Set<string>()
  private readonly now: () => number
  private readonly settleMs: number
  private readonly stableMs: number

  private constructor(
    private cfg: AppConfig,
    private readonly deps: EngineDeps,
  ) {
    super()
    this.now = deps.now ?? Date.now
    this.settleMs = deps.settleMs ?? 15_000
    this.stableMs = deps.stableMs ?? 5_000
  }

  static async create(deps: EngineDeps): Promise<Engine> {
    const engine = new Engine(await loadConfig(join(deps.dataDir, 'config.json')), deps)
    for (const w of engine.cfg.worlds) await engine.openWorld(w)
    return engine
  }

  get config(): Readonly<AppConfig> {
    return this.cfg
  }

  // ---- paths & persistence -------------------------------------------------

  private stagingDir(worldId: string): string {
    return join(this.deps.dataDir, 'staging', worldId)
  }
  private journalPath(worldId: string): string {
    return join(this.deps.dataDir, 'journal', `${worldId}.json`)
  }
  private backupDir(worldId: string, reason: string): string {
    return join(this.deps.dataDir, 'backups', worldId, `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${reason}`)
  }

  private async persistConfig(): Promise<void> {
    await saveConfig(join(this.deps.dataDir, 'config.json'), this.cfg)
    this.emit('change')
  }

  private async openWorld(w: WorldConfig): Promise<void> {
    const store = new WorldStore(this.stagingDir(w.id), w.id)
    await store.init()
    this.stores.set(w.id, store)
    let st: WorldState | null = null
    try {
      st = JSON.parse(await readFile(join(this.deps.dataDir, 'state', `${w.id}.json`), 'utf8'))
    } catch {
      st = null
    }
    this.states.set(w.id, {
      basis: [],
      sessionBasis: [],
      liveSig: null,
      liveContentId: null,
      initialized: false,
      playing: false,
      exitedAt: 0,
      pendingSig: null,
      pendingSince: 0,
      decided: [],
      dismissedOverrules: [],
      lastAppliedAt: 0,
      lastCaptureAt: 0,
      ...st,
    })
    this.runtimes.set(w.id, { status: 'setting-up', detail: '', warnings: [], resolution: null, pendingUpdate: false, overruled: null, notified: new Set() })
  }

  private async persistState(worldId: string): Promise<void> {
    const st = this.states.get(worldId)
    if (st) await writeJsonAtomic(join(this.deps.dataDir, 'state', `${worldId}.json`), st)
  }

  private keyMap(): Map<string, string> {
    const keys = new Map<string, string>([[this.cfg.identity.deviceId, this.cfg.identity.publicKey]])
    for (const p of this.cfg.peers) keys.set(p.deviceId, p.publicKey)
    return keys
  }

  private async emitEvent(store: WorldStore, body: Record<string, unknown>): Promise<SyncEvent> {
    const event = signEvent(
      {
        schema: SCHEMA,
        id: randomUUID(),
        worldId: store.worldId,
        deviceId: this.cfg.identity.deviceId,
        deviceName: this.cfg.deviceName,
        at: this.now(),
        ...body,
      } as unknown as SyncEvent,
      this.cfg.identity,
    )
    await store.writeEvent(event)
    this.dirty.add(store.worldId)
    return event
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(intervalMs = 3000): Promise<void> {
    await this.syncTransportConfig()
    void this.checkClock()
    const loop = async (): Promise<void> => {
      await this.tick()
      this.timer = setTimeout(loop, intervalMs)
    }
    await loop()
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.ticking
  }

  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null
      })
    }
    return this.ticking
  }

  private async runTick(): Promise<void> {
    await this.pollTransport()
    let running = new Set<string>()
    try {
      running = await this.deps.detector.running()
    } catch (err) {
      this.deps.log(`process detection failed: ${String(err)}`)
    }
    for (const w of this.cfg.worlds) {
      const before = JSON.stringify(this.states.get(w.id))
      await this.tickWorld(w, running)
      if (JSON.stringify(this.states.get(w.id)) !== before) await this.persistState(w.id)
    }
    await this.flushToTransport()
    await this.housekeeping()
    this.emit('change')
  }

  // ---- housekeeping --------------------------------------------------------

  private async housekeeping(): Promise<void> {
    for (const w of this.cfg.worlds) {
      const now = this.now()
      if (now - (this.housekeptAt.get(w.id) ?? 0) < HOUSEKEEPING_MS) continue
      // Never while the game might be writing, or while a save is being applied.
      if (this.states.get(w.id)?.playing || this.runtimes.get(w.id)?.status === 'pending-update') continue
      this.housekeptAt.set(w.id, now)
      try {
        const freed = (await this.clearOldVersions(w)) + (await this.trimBackups(w))
        if (freed) this.deps.log(`world ${w.name}: cleared ${(freed / 1024 ** 2).toFixed(1)} MB of old versions and backups`)
        this.storage.set(w.id, (await dirSize(this.stagingDir(w.id))) + (await dirSize(join(this.deps.dataDir, 'backups', w.id))))
      } catch (err) {
        this.deps.log(`world ${w.name}: clean-up failed: ${String(err)}`)
      }
    }
  }

  /**
   * Deletes the files only versions past the group's limit use. The store is
   * shared, so the deletions reach every friend; every PC computes the same set.
   */
  private async clearOldVersions(w: WorldConfig): Promise<number> {
    const store = this.stores.get(w.id)!
    const { events, rejected } = await store.loadEvents(this.keyMap())
    // A record we can't verify might name files we'd otherwise think unused.
    if (rejected.length) return 0
    let freed = 0
    for (const sha of filesToClear(events)) {
      const path = store.objectPath(sha)
      const size = (await stat(path).catch(() => null))?.size
      if (size === undefined) continue
      await rm(path, { force: true })
      freed += size
    }
    if (freed) this.dirty.add(w.id)
    return freed
  }

  private async trimBackups(w: WorldConfig): Promise<number> {
    const dir = join(this.deps.dataDir, 'backups', w.id)
    const old = (await readdir(dir).catch(() => [] as string[])).sort().slice(0, -BACKUPS_KEPT)
    let freed = 0
    for (const name of old) {
      freed += await dirSize(join(dir, name))
      await rm(join(dir, name), { recursive: true, force: true })
    }
    return freed
  }

  // ---- transport -----------------------------------------------------------

  private async syncTransportConfig(): Promise<void> {
    const st = this.deps.syncthing
    if (!st?.running) return
    try {
      await st.setOwnName(this.invite())
      for (const p of this.cfg.peers) {
        if (p.removed) await st.removeDevice(p.syncthingId)
        else await st.ensureDevice(p.syncthingId, p.name)
      }
      for (const w of this.cfg.worlds) await this.syncWorldFolder(w)
      this.transportError = null
    } catch (err) {
      this.transportError = String(err)
      this.deps.log(`transport config failed: ${String(err)}`)
    }
  }

  private async syncWorldFolder(w: WorldConfig): Promise<void> {
    const st = this.deps.syncthing
    if (!st?.running) return
    const devices = this.cfg.peers.filter((p) => !p.removed && w.sharedWith.includes(p.deviceId)).map((p) => p.syncthingId)
    await st.ensureFolder(w.id, w.name, this.stagingDir(w.id), devices)
  }

  private async flushToTransport(): Promise<void> {
    const st = this.deps.syncthing
    if (!st?.running) return
    for (const worldId of [...this.dirty]) {
      if (!this.cfg.worlds.some((w) => w.id === worldId)) {
        this.dirty.delete(worldId)
        continue
      }
      try {
        // Events first and waited on: they're small and tell friends what's new. Hashing
        // new save blobs can take longer than a request may wait, so that scan runs on its own.
        await st.scan(worldId, 'events')
        this.dirty.delete(worldId)
        void st.scan(worldId).catch((err) => this.deps.log(`transport rescan failed: ${String(err)}`))
      } catch (err) {
        this.deps.log(`transport rescan failed: ${String(err)}`)
      }
    }
  }

  private async pollTransport(): Promise<void> {
    const st = this.deps.syncthing
    if (!st) {
      this.transportError = 'Sync transport is not available in this build.'
      return
    }
    if (!st.running) {
      this.transportError = 'Sync transport is not running.'
      return
    }
    try {
      this.connections = await st.connections()
      this.lastSeen = await st.lastSeen()
      this.sortConnectionAttempts(await st.pendingDevices())
      const offers = await st.pendingFolders()
      this.pendingFolders = []
      for (const offer of offers) {
        const worldId = offer.folderId.slice(FOLDER_PREFIX.length)
        const trustedOfferers = this.cfg.peers.filter((p) => !p.removed && offer.offeredBy.includes(p.syncthingId))
        if (trustedOfferers.length === 0) continue
        const existing = this.cfg.worlds.find((w) => w.id === worldId)
        if (existing) {
          // A trusted friend shares a world we already sync: complete the mesh.
          const add = trustedOfferers.map((p) => p.deviceId).filter((id) => !existing.sharedWith.includes(id))
          if (add.length) {
            existing.sharedWith.push(...add)
            await this.syncWorldFolder(existing)
            await this.persistConfig()
            this.deps.log(`world ${existing.name}: now also syncing with ${add.join(', ')}`)
          }
        } else {
          this.pendingFolders.push({ ...offer, offeredBy: trustedOfferers.map((p) => p.deviceId) })
        }
      }
      this.transportError = null
    } catch (err) {
      this.transportError = String(err)
    }
  }

  // ---- per-world tick ------------------------------------------------------

  /** Seconds left at a smoothed recent speed, or null when there's nothing to go on. */
  private estimate(rt: Runtime, contentId: string, haveBytes: number, totalBytes: number, moving: boolean): number | null {
    const now = this.now()
    const prev = rt.downloadSample
    let rate = 0
    if (prev && prev.contentId === contentId && now > prev.at) {
      const instant = Math.max(0, haveBytes - prev.haveBytes) / ((now - prev.at) / 1000)
      rate = prev.rate ? prev.rate * 0.7 + instant * 0.3 : instant
    }
    rt.downloadSample = { contentId, at: now, haveBytes, rate }
    return moving && rate > 0 ? Math.ceil((totalBytes - haveBytes) / rate) : null
  }

  private setStatus(worldId: string, status: WorldStatus, detail = ''): void {
    const rt = this.runtimes.get(worldId)!
    rt.status = status
    rt.detail = detail
    if (status !== 'waiting-for-peer') rt.download = null
  }

  private notifyOnce(worldId: string, key: string, title: string, body: string): void {
    const rt = this.runtimes.get(worldId)!
    if (rt.notified.has(key)) return
    rt.notified.add(key)
    this.deps.notify(title, body)
  }

  private async tickWorld(w: WorldConfig, running: Set<string>): Promise<void> {
    const st = this.states.get(w.id)!
    const rt = this.runtimes.get(w.id)!
    const store = this.stores.get(w.id)!
    const now = this.now()
    try {
      if (await recoverJournal(this.journalPath(w.id), w.include, w.exclude)) {
        st.liveSig = null
        st.liveContentId = null
        this.deps.log(`world ${w.name}: rolled back an interrupted update`)
        this.deps.notify(w.name, 'An interrupted update was rolled back. Your previous saves are intact.')
      }
      try {
        if (!(await stat(w.localPath)).isDirectory()) throw new Error()
      } catch {
        this.setStatus(w.id, 'error', `Save folder not found: ${w.localPath}`)
        return
      }

      const keys = this.keyMap()
      let { events, rejected } = await store.loadEvents(keys)
      await this.learnPeerNames(events)
      rt.warnings = rejected.slice(0, 5)
      let res = resolve(events)
      rt.resolution = res
      rt.pendingUpdate = 'accepted' in res && res.accepted.contentId !== st.liveContentId
      this.noteOverruled(w, st, rt, events)

      if (isGameRunning(running, w.processNames)) {
        if (!st.playing) {
          st.playing = true
          st.sessionBasis = [...st.basis]
          if (rt.pendingUpdate) {
            this.notifyOnce(w.id, `launch-race-${now}`, w.name, 'The game started before the latest shared save was applied. Quit to the desktop to receive it.')
          }
        }
        this.setStatus(w.id, 'playing', rt.pendingUpdate ? 'An update is queued for when you quit.' : '')
        return
      }
      if (st.playing) {
        st.playing = false
        st.exitedAt = now
      }
      if (now - st.exitedAt < this.settleMs) {
        this.setStatus(w.id, 'playing', 'Waiting for the game to finish writing saves.')
        return
      }

      // 1. Capture local changes once the folder has been stable for a while.
      const scan = await scanFolder(w.localPath, w.include, w.exclude)
      if (scan.sig !== st.liveSig) {
        if (st.pendingSig !== scan.sig) {
          st.pendingSig = scan.sig
          st.pendingSince = now
          this.setStatus(w.id, 'pending-update', 'Waiting for save files to settle.')
          return
        }
        if (now - st.pendingSince < this.stableMs) return
        if (!(await this.capture(w, st, store, scan))) return
        ;({ events, rejected } = await store.loadEvents(keys))
        res = resolve(events)
        rt.resolution = res
      }

      // 2. Reconcile with the group's accepted continuation.
      await this.reconcile(w, st, rt, store, res, events)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.log(`world ${w.name}: ${msg}`)
      this.setStatus(w.id, 'error', msg)
      this.notifyOnce(w.id, `error-${msg}`, `${w.name}: sync problem`, msg)
    }
  }

  /** Measures this PC's clock against real time; null when it can't be checked right now. */
  private async checkClock(): Promise<number | null> {
    const offsetMs = (await this.deps.clockOffset?.().catch(() => null)) ?? null
    if (offsetMs !== null) {
      this.clock = { offsetMs, checkedAt: this.now() }
      this.emit('change')
    }
    return offsetMs
  }

  private async capture(w: WorldConfig, st: WorldState, store: WorldStore, scan: Scan): Promise<boolean> {
    const files: FileEntry[] = []
    for (const f of scan.files) {
      const stored = await store.putFile(join(w.localPath, ...f.path.split('/')))
      if (stored.size !== f.size) return this.unstable(st)
      files.push({ path: f.path, size: stored.size, sha256: stored.sha256, mtimeMs: f.mtimeMs })
    }
    // A save that changed while we copied it would be a torn snapshot; try again later.
    const after = await scanFolder(w.localPath, w.include, w.exclude)
    if (after.sig !== scan.sig) return this.unstable(st)

    const contentId = contentIdOf(w.id, files)
    if (contentId !== st.liveContentId) {
      const publish = files.length > 0 && (st.initialized || w.mode === 'contribute')
      if (publish) {
        // Checked now, not earlier: what counts is the clock the saves were just written with.
        const clockOffsetMs = await this.checkClock()
        if (clockOffsetMs !== null && Math.abs(clockOffsetMs) > CLOCK_WARN_MS) {
          this.deps.notify(w.name, `Your PC's clock is ${describeClockOffset(clockOffsetMs)}. This save's time was corrected, but fix the clock in Windows: Settings › Time & language › Date & time › Sync now.`)
        }
        const ev = await this.emitEvent(store, {
          kind: 'capture',
          contentId,
          files,
          parents: st.basis,
          reason: st.initialized ? 'local' : 'import',
          ...(clockOffsetMs !== null ? { clockOffsetMs } : {}),
        })
        st.basis = [ev.id]
        st.initialized = true
        st.lastCaptureAt = this.now()
        this.deps.log(`world ${w.name}: published ${files.length} file(s) as ${contentId.slice(0, 12)}`)
      }
      st.liveContentId = contentId
    }
    st.liveSig = scan.sig
    st.pendingSig = null
    return true
  }

  /** Friends can rename their PC; follow the newest name their signed events carry. */
  private async learnPeerNames(events: SyncEvent[]): Promise<void> {
    const latest = new Map<string, string>()
    for (const e of [...events].sort(compareEvents)) latest.set(e.deviceId, e.deviceName)
    let changed = false
    for (const p of this.cfg.peers) {
      const name = latest.get(p.deviceId)
      if (name && name !== p.name) {
        p.name = name
        changed = true
      }
    }
    if (changed) await this.persistConfig()
  }

  /** Tells this PC's user when their choice lost to a friend's made without knowing of it. */
  private noteOverruled(w: WorldConfig, st: WorldState, rt: Runtime, events: SyncEvent[]): void {
    const mine = overruledDecisions(events).filter((o) => o.decision.deviceId === this.cfg.identity.deviceId && o.decision.basis === 'user')
    rt.overruled = mine.filter((o) => !st.dismissedOverrules.includes(o.decision.id)).at(-1) ?? null
    if (rt.overruled) {
      this.notifyOnce(w.id, `overruled-${rt.overruled.decision.id}`, w.name, `${rt.overruled.by.deviceName} picked a different save at about the same time as you. Everyone continues from theirs; yours stays in history.`)
    }
  }

  async dismissOverruled(worldId: string, decisionId: string): Promise<void> {
    this.world(worldId)
    const st = this.states.get(worldId)!
    st.dismissedOverrules = [...st.dismissedOverrules.slice(-50), decisionId]
    const rt = this.runtimes.get(worldId)!
    if (rt.overruled?.decision.id === decisionId) rt.overruled = null
    await this.persistState(worldId)
    this.emit('change')
  }

  private unstable(st: WorldState): false {
    st.pendingSig = null
    return false
  }

  private async reconcile(w: WorldConfig, st: WorldState, rt: Runtime, store: WorldStore, res: Resolution, events: SyncEvent[]): Promise<void> {
    if (res.state === 'empty') {
      this.setStatus(w.id, 'up-to-date', w.mode === 'receive' && !st.initialized ? 'Waiting for a shared save from a friend.' : 'No shared saves yet.')
      return
    }
    if (res.state === 'conflict') {
      rt.pendingUpdate = false
      this.setStatus(w.id, 'conflict', `${res.candidates.length} competing versions need a choice.`)
      this.notifyOnce(w.id, `conflict-${res.headIds.join(',')}`, `${w.name}: choose a version`, 'Friends continued this save separately. Open SaveRelay to pick which continuation to keep. Both are preserved.')
      return
    }

    const accepted = res.accepted
    if (res.state === 'auto-resolved') {
      const key = res.headIds.join(',')
      const alreadyDecided = events.some((e) => e.kind === 'decision' && e.deviceId === this.cfg.identity.deviceId && [...e.candidates].sort().join(',') === key)
      if (!alreadyDecided && !st.decided.includes(key)) {
        await this.emitEvent(store, { kind: 'decision', candidates: res.headIds, selected: accepted.versionIds[0], basis: res.policy.policy, seen: latestDecisions(events) })
        st.decided = [...st.decided.slice(-50), key]
      }
    }

    if (accepted.contentId === st.liveContentId) {
      st.basis = accepted.versionIds
      st.initialized = true
      rt.pendingUpdate = false
      this.setStatus(w.id, 'up-to-date')
      return
    }

    rt.pendingUpdate = true
    const missing: FileEntry[] = []
    for (const f of accepted.files) if (!(await store.hasObject(f.sha256, f.size))) missing.push(f)
    if (missing.length) {
      const friendOnline = this.cfg.peers.some((p) => !p.removed && w.sharedWith.includes(p.deviceId) && this.connections[p.syncthingId])
      const totalBytes = accepted.files.reduce((n, f) => n + f.size, 0)
      const haveBytes = totalBytes - missing.reduce((n, f) => n + f.size, 0)
      this.setStatus(w.id, 'waiting-for-peer', friendOnline ? 'Downloading the latest save.' : 'Paused until a friend is online.')
      rt.download = {
        haveBytes,
        totalBytes,
        fromDeviceIds: accepted.deviceIds.filter((id) => id !== this.cfg.identity.deviceId),
        savedAt: accepted.modifiedAt,
        paused: !friendOnline,
        etaSeconds: this.estimate(rt, accepted.contentId, haveBytes, totalBytes, friendOnline),
      }
      return
    }

    this.setStatus(w.id, 'pending-update', 'Applying the latest shared save.')
    await applySnapshot({
      root: w.localPath,
      files: accepted.files,
      store,
      include: w.include,
      exclude: w.exclude,
      backupDir: this.backupDir(w.id, 'before-update'),
      journalPath: this.journalPath(w.id),
    })
    const scan = await scanFolder(w.localPath, w.include, w.exclude)
    st.liveSig = scan.sig
    st.liveContentId = accepted.contentId
    st.basis = accepted.versionIds
    st.initialized = true
    st.lastAppliedAt = this.now()
    rt.pendingUpdate = false
    await this.emitEvent(store, { kind: 'applied', contentId: accepted.contentId, versionIds: accepted.versionIds })
    this.deps.log(`world ${w.name}: applied ${accepted.contentId.slice(0, 12)} from ${accepted.deviceNames.join(', ')}`)
    this.setStatus(w.id, 'up-to-date')
  }

  // ---- user actions --------------------------------------------------------

  invite(): string {
    return encodeInvite({
      v: 1,
      name: this.cfg.deviceName,
      deviceId: this.cfg.identity.deviceId,
      publicKey: this.cfg.identity.publicKey,
      syncthingId: this.deps.syncthing?.myId ?? '',
    })
  }

  async setDeviceName(name: string): Promise<void> {
    const trimmed = name.trim().slice(0, 64)
    if (!trimmed) throw new Error('Device name cannot be empty')
    this.cfg.deviceName = trimmed
    this.cfg.nameChosen = true
    await this.persistConfig()
    if (this.deps.syncthing?.running) await this.deps.syncthing.setOwnName(this.invite()).catch(() => undefined)
  }

  /**
   * Splits unknown connection attempts into friend requests (they carry a
   * matching invite) and others (older SaveRelay versions). Unfriended and
   * ignored people stay quiet until this person adds them again.
   */
  private sortConnectionAttempts(pending: { deviceId: string; name: string; address: string }[]): void {
    this.friendRequests = []
    this.pendingDevices = []
    for (const d of pending) {
      const peer = this.cfg.peers.find((p) => p.syncthingId === d.deviceId)
      if (peer || this.cfg.ignoredRequests?.includes(d.deviceId)) continue
      const invite = decodeInvite(d.name)
      // The invite must belong to the PC that's actually connecting, or anyone could pose as anyone.
      if (invite && invite.syncthingId === d.deviceId && invite.deviceId !== this.cfg.identity.deviceId) {
        this.friendRequests.push({ syncthingId: d.deviceId, deviceId: invite.deviceId, name: invite.name, code: d.name })
      } else this.pendingDevices.push(d)
    }
  }

  async acceptFriendRequest(syncthingId: string): Promise<string> {
    const request = this.friendRequests.find((r) => r.syncthingId === syncthingId)
    if (!request) throw new Error('That friend request is no longer pending.')
    const name = await this.addPeer(request.code)
    this.friendRequests = this.friendRequests.filter((r) => r.syncthingId !== syncthingId)
    return name
  }

  async ignoreFriendRequest(syncthingId: string): Promise<void> {
    this.cfg.ignoredRequests = [...new Set([...(this.cfg.ignoredRequests ?? []), syncthingId])]
    this.friendRequests = this.friendRequests.filter((r) => r.syncthingId !== syncthingId)
    await this.deps.syncthing?.dismissPendingDevice(syncthingId)
    await this.persistConfig()
  }

  async setStartAtLogin(enabled: boolean): Promise<void> {
    this.cfg.startAtLogin = enabled
    await this.persistConfig()
  }

  async addPeer(code: string): Promise<string> {
    const invite = decodeInvite(code)
    if (!invite) throw new Error('That invite code is not valid.')
    if (invite.deviceId === this.cfg.identity.deviceId) throw new Error('That is this device’s own invite code.')
    // Adding someone yourself always overrides an earlier ignore.
    this.cfg.ignoredRequests = this.cfg.ignoredRequests?.filter((id) => id !== invite.syncthingId)
    const existing = this.cfg.peers.find((p) => p.deviceId === invite.deviceId)
    if (existing) {
      Object.assign(existing, { name: invite.name, syncthingId: invite.syncthingId, removed: false })
    } else {
      this.cfg.peers.push({ deviceId: invite.deviceId, name: invite.name, publicKey: invite.publicKey, syncthingId: invite.syncthingId, addedAt: this.now() })
    }
    await this.deps.syncthing?.ensureDevice(invite.syncthingId, invite.name)
    await this.persistConfig()
    return invite.name
  }

  /** Stops all future sharing with a peer. Files they already received cannot be recalled. */
  async removePeer(deviceId: string): Promise<void> {
    const peer = this.cfg.peers.find((p) => p.deviceId === deviceId)
    if (!peer) return
    peer.removed = true
    for (const w of this.cfg.worlds) {
      w.sharedWith = w.sharedWith.filter((id) => id !== deviceId)
      await this.syncWorldFolder(w)
    }
    await this.deps.syncthing?.removeDevice(peer.syncthingId)
    await this.persistConfig()
  }

  private async validateLocalFolder(localPath: string, ignoreWorldId?: string): Promise<string> {
    const abs = resolvePath(localPath)
    const st = await stat(abs).catch(() => null)
    if (!st?.isDirectory()) throw new Error('Choose an existing folder.')
    const real = await realpath(abs)
    for (const w of this.cfg.worlds) {
      if (w.id === ignoreWorldId) continue
      const other = await realpath(w.localPath).catch(() => w.localPath)
      if (other === real || real.startsWith(other + '/') || real.startsWith(other + '\\') || other.startsWith(real + '/') || other.startsWith(real + '\\')) {
        throw new Error(`That folder overlaps the shared save “${w.name}”.`)
      }
    }
    if (real.startsWith(resolvePath(this.deps.dataDir))) throw new Error('Choose your game’s save folder, not SaveRelay’s own data folder.')
    return abs
  }

  /** Warnings about other writers (links, junctions, cloud-sync folders). Never acts on them. */
  async folderWarnings(localPath: string): Promise<string[]> {
    const warnings: string[] = []
    try {
      const abs = resolvePath(localPath)
      const real = await realpath(abs)
      if ((await lstat(abs)).isSymbolicLink() || real.toLowerCase() !== abs.toLowerCase()) {
        warnings.push(`This folder is a link or junction to ${real}. Other tools writing there can conflict with sharing.`)
      }
      if (/[\\/](dropbox|onedrive[^\\/]*|google drive|icloud ?drive)[\\/]/i.test(real + '/')) {
        warnings.push('This folder is inside a cloud-sync folder. Another sync tool may also write these saves.')
      }
    } catch {
      /* missing folders are reported elsewhere */
    }
    return warnings
  }

  private cleanWorldInput(input: NewWorldInput): Omit<NewWorldInput, 'localPath' | 'mode'> & { mode: WorldConfig['mode'] } {
    const list = (v: unknown, max: number): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean).slice(0, max) : []
    const name = String(input.name ?? '').trim().slice(0, 80)
    if (!name) throw new Error('Give the save a name.')
    const include = list(input.include, 20)
    for (const g of [...include, ...list(input.exclude, 20)]) globToRegExp(g)
    return {
      name,
      gameId: gameById(input.gameId) ? input.gameId : 'custom',
      processNames: list(input.processNames, 10),
      include: include.length ? include : ['**/*'],
      exclude: list(input.exclude, 20),
      sharedWith: list(input.sharedWith, 50).filter((id) => this.cfg.peers.some((p) => p.deviceId === id && !p.removed)),
      mode: input.mode === 'receive' ? 'receive' : 'contribute',
    }
  }

  async addWorld(input: NewWorldInput): Promise<WorldConfig> {
    const clean = this.cleanWorldInput(input)
    const localPath = await this.validateLocalFolder(input.localPath)
    const w: WorldConfig = { id: randomUUID(), ...clean, mode: 'contribute', localPath, addedAt: this.now() }
    const store = new WorldStore(this.stagingDir(w.id), w.id)
    await store.init({ worldId: w.id, name: w.name, gameId: w.gameId, createdBy: this.cfg.deviceName, createdAt: this.now() })
    this.cfg.worlds.push(w)
    await this.openWorld(w)
    await this.persistConfig()
    await this.syncWorldFolder(w)
    void this.tick()
    return w
  }

  async joinWorld(folderId: string, input: NewWorldInput): Promise<WorldConfig> {
    const offer = this.pendingFolders.find((f) => f.folderId === folderId)
    if (!offer) throw new Error('That invitation is no longer pending.')
    const clean = this.cleanWorldInput(input)
    const localPath = await this.validateLocalFolder(input.localPath)
    const id = folderId.slice(FOLDER_PREFIX.length)
    const sharedWith = [...new Set([...offer.offeredBy, ...clean.sharedWith])]
    const w: WorldConfig = { id, ...clean, sharedWith, localPath, addedAt: this.now() }
    this.cfg.worlds.push(w)
    await this.openWorld(w)
    await this.persistConfig()
    await this.syncWorldFolder(w)
    this.pendingFolders = this.pendingFolders.filter((f) => f.folderId !== folderId)
    void this.tick()
    return w
  }

  async updateWorld(worldId: string, patch: Partial<Pick<NewWorldInput, 'name' | 'processNames' | 'include' | 'exclude' | 'sharedWith'>>): Promise<void> {
    const w = this.world(worldId)
    const clean = this.cleanWorldInput({ ...w, ...patch })
    Object.assign(w, { name: clean.name, processNames: clean.processNames, include: clean.include, exclude: clean.exclude, sharedWith: clean.sharedWith })
    await this.persistConfig()
    await this.syncWorldFolder(w)
  }

  /** Stops sharing this world from this device. Live saves, backups and history stay on disk. */
  async removeWorld(worldId: string): Promise<void> {
    this.world(worldId)
    await this.deps.syncthing?.removeFolder(worldId)
    this.cfg.worlds = this.cfg.worlds.filter((w) => w.id !== worldId)
    this.states.delete(worldId)
    this.runtimes.delete(worldId)
    this.stores.delete(worldId)
    await this.persistConfig()
  }

  private world(worldId: string): WorldConfig {
    const w = this.cfg.worlds.find((x) => x.id === worldId)
    if (!w) throw new Error('Unknown world')
    return w
  }

  async setPolicy(worldId: string, policy: Policy, preferredDeviceId?: string): Promise<void> {
    if (!['ask', 'latest-modified', 'preferred-device'].includes(policy)) throw new Error('Unknown policy')
    if (policy === 'preferred-device' && !preferredDeviceId) throw new Error('Pick the preferred device.')
    this.world(worldId)
    const keepVersions = await this.currentKeep(worldId)
    await this.emitEvent(this.stores.get(worldId)!, { kind: 'policy', policy, preferredDeviceId: policy === 'preferred-device' ? preferredDeviceId : undefined, keepVersions })
    void this.tick()
  }

  /** Sets how many versions keep their files, for everyone sharing this save. 0 keeps all. */
  async setKeepVersions(worldId: string, keepVersions: number): Promise<void> {
    if (!Number.isInteger(keepVersions) || keepVersions < 0 || keepVersions > MAX_KEEP_VERSIONS) throw new Error(`Keep between 1 and ${MAX_KEEP_VERSIONS} versions, or every version.`)
    this.world(worldId)
    const store = this.stores.get(worldId)!
    const current = currentPolicy((await store.loadEvents(this.keyMap())).events)
    await this.emitEvent(store, { kind: 'policy', policy: current.policy, preferredDeviceId: current.preferredDeviceId, keepVersions })
    this.housekeptAt.delete(worldId)
    void this.tick()
  }

  private async currentKeep(worldId: string): Promise<number> {
    return currentPolicy((await this.stores.get(worldId)!.loadEvents(this.keyMap())).events).keepVersions
  }

  /** Resolves a conflict by recording which candidate becomes the shared continuation. */
  async chooseCandidate(worldId: string, contentId: string): Promise<void> {
    const rt = this.runtimes.get(worldId)
    const res = rt?.resolution
    if (!res || res.state !== 'conflict') throw new Error('There is no conflict to resolve.')
    const chosen = res.candidates.find((c) => c.contentId === contentId)
    if (!chosen) throw new Error('Unknown candidate')
    const store = this.stores.get(worldId)!
    const { events } = await store.loadEvents(this.keyMap())
    await this.emitEvent(store, { kind: 'decision', candidates: res.headIds, selected: chosen.versionIds[0], basis: 'user', seen: latestDecisions(events) })
    void this.tick()
  }

  /** Re-activates historical content as a new, attributed restore event. */
  async restore(worldId: string, contentId: string): Promise<void> {
    this.world(worldId)
    const store = this.stores.get(worldId)!
    const { events } = await store.loadEvents(this.keyMap())
    const source = events.filter(isVersion).filter((e) => e.contentId === contentId).at(-1)
    if (!source) throw new Error('Unknown version')
    const res = resolve(events)
    const parents = res.state === 'conflict' ? res.headIds : 'accepted' in res ? res.accepted.versionIds : []
    await this.emitEvent(store, { kind: 'restore', contentId, files: source.files, parents, restoredFrom: source.id, clockOffsetMs: source.clockOffsetMs })
    void this.tick()
  }

  // ---- read models ---------------------------------------------------------

  async history(worldId: string): Promise<{ groups: (ContentGroup & { accepted: boolean; live: boolean })[]; decisions: unknown[]; graph: Graph }> {
    this.world(worldId)
    const st = this.states.get(worldId)!
    const { events } = await this.stores.get(worldId)!.loadEvents(this.keyMap())
    const res = resolve(events)
    const acceptedId = 'accepted' in res ? res.accepted.contentId : null
    const groups = buildHistory(events).map((g) => ({ ...g, accepted: g.contentId === acceptedId, live: g.contentId === st.liveContentId }))
    const decisions = events
      .filter((e) => e.kind === 'decision' || e.kind === 'policy')
      .sort((a, b) => b.at - a.at)
      .slice(0, 50)
      .map((e) => ({ ...e, sig: undefined }))
    return { groups, decisions, graph: buildGraph(events) }
  }

  async discover(): Promise<(FoundSave & { added: boolean })[]> {
    const found = await findSaves(GAMES, { documents: this.deps.documentsDir, ...this.deps.places })
    return found
      .map((f) => ({ ...f, added: this.cfg.worlds.some((w) => resolvePath(w.localPath).toLowerCase() === resolvePath(f.path).toLowerCase()) }))
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
  }

  snapshot() {
    return {
      device: {
        name: this.cfg.deviceName,
        nameChosen: !!this.cfg.nameChosen,
        deviceId: this.cfg.identity.deviceId,
        syncthingId: this.deps.syncthing?.myId ?? '',
        invite: this.deps.syncthing?.myId ? this.invite() : '',
        startAtLogin: this.cfg.startAtLogin,
      },
      transport: { ok: !this.transportError, error: this.transportError },
      /** Set when this PC's clock is far enough off to warn about. */
      clockWarning: this.clock && Math.abs(this.clock.offsetMs) > CLOCK_WARN_MS ? describeClockOffset(this.clock.offsetMs) : null,
      peers: this.cfg.peers
        .filter((p) => !p.removed)
        .map((p) => {
          const connected = !!this.connections[p.syncthingId]
          return { deviceId: p.deviceId, name: p.name, connected, lastSeenAt: connected ? this.now() : (this.lastSeen[p.syncthingId] ?? 0), addedAt: p.addedAt }
        }),
      pendingDevices: this.pendingDevices,
      friendRequests: this.friendRequests.map(({ syncthingId, deviceId, name }) => ({ syncthingId, deviceId, name })),
      invitations: this.pendingFolders.map((f) => ({
        folderId: f.folderId,
        label: f.label,
        offeredBy: f.offeredBy.map((id) => this.cfg.peers.find((p) => p.deviceId === id)?.name ?? id),
      })),
      games: GAMES.map((g) => ({ id: g.id, name: g.name, processNames: g.processNames, include: g.include, exclude: g.exclude, notes: g.notes })),
      worlds: this.cfg.worlds.map((w) => {
        const rt = this.runtimes.get(w.id)
        const st = this.states.get(w.id)
        const res = rt?.resolution
        const candidates: Candidate[] = res && res.state !== 'empty' ? res.candidates : []
        return {
          ...w,
          status: rt?.status ?? 'setting-up',
          detail: rt?.detail ?? '',
          warnings: rt?.warnings ?? [],
          pendingUpdate: rt?.pendingUpdate ?? false,
          policy: res?.policy ?? { policy: 'ask' as Policy, keepVersions: DEFAULT_KEEP_VERSIONS },
          storageBytes: this.storage.get(w.id) ?? null,
          download: rt?.download
            ? {
                ...rt.download,
                fromNames: rt.download.fromDeviceIds.map((id) => this.cfg.peers.find((p) => p.deviceId === id)?.name ?? 'a friend'),
                fromLastSeenAt: Math.max(0, ...rt.download.fromDeviceIds.map((id) => this.lastSeen[this.cfg.peers.find((p) => p.deviceId === id)?.syncthingId ?? ''] ?? 0)),
              }
            : null,
          conflict: res?.state === 'conflict' ? candidates : null,
          autoNote: res?.state === 'auto-resolved' || res?.state === 'conflict' ? (res.note ?? null) : null,
          overruled: rt?.overruled ? { decisionId: rt.overruled.decision.id, at: rt.overruled.decision.at, byName: rt.overruled.by.deviceName } : null,
          acceptedContentId: res && 'accepted' in res ? res.accepted.contentId : null,
          liveContentId: st?.liveContentId ?? null,
          lastAppliedAt: st?.lastAppliedAt ?? 0,
          lastCaptureAt: st?.lastCaptureAt ?? 0,
        }
      }),
    }
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const { identity, syncthingApiKey: _key, ...safe } = this.cfg
    const worlds: Record<string, unknown> = {}
    for (const w of this.cfg.worlds) {
      const { events, rejected } = await this.stores.get(w.id)!.loadEvents(this.keyMap())
      worlds[w.id] = { state: this.states.get(w.id), runtime: { ...this.runtimes.get(w.id), notified: undefined }, events: events.length, rejected, resolution: resolve(events) }
    }
    return { generatedAt: new Date(this.now()).toISOString(), platform: process.platform, deviceId: identity.deviceId, config: safe, transportError: this.transportError, worlds }
  }

  /** Backs up the live folder on demand (used before risky user actions). */}

export type EngineSnapshot = ReturnType<Engine['snapshot']>
