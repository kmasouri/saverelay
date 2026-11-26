// Background sync engine. Electron-free so it can be driven headless in tests.
//
// Per world, every tick:
//   game running  -> freeze; incoming content stays staged, never touches the live folder
//   game exited   -> wait for writes to settle, capture changed saves as a signed snapshot
//   idle          -> resolve shared history with the group policy and apply the accepted
//                    continuation (backed up + journaled) when its content is fully staged

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve as resolvePath } from 'node:path'
import { GAMES, gameById } from '../../core/games'
import { buildHistory, type ContentGroup } from '../../core/history'
import { decodeInvite, encodeInvite, signEvent } from '../../core/identity'
import { contentIdOf } from '../../core/manifest'
import { globToRegExp } from '../../core/paths'
import { resolve, type Candidate, type Resolution } from '../../core/reconcile'
import { SCHEMA, isVersion, type FileEntry, type Policy, type SyncEvent } from '../../core/types'
import { applySnapshot, backupFolder, recoverJournal } from './applier'
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
  lastAppliedAt: number
  lastCaptureAt: number
}

interface Runtime {
  status: WorldStatus
  detail: string
  warnings: string[]
  resolution: Resolution | null
  pendingUpdate: boolean
  notified: Set<string>
}

export interface EngineDeps {
  dataDir: string
  documentsDir: string
  syncthing: Syncthing | null
  detector: ProcessDetector
  notify: (title: string, body: string) => void
  log: (msg: string) => void
  now?: () => number
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
  private pendingFolders: { folderId: string; label: string; offeredBy: string[] }[] = []
  private connections: Record<string, boolean> = {}
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
      lastAppliedAt: 0,
      lastCaptureAt: 0,
      ...st,
    })
    this.runtimes.set(w.id, { status: 'setting-up', detail: '', warnings: [], resolution: null, pendingUpdate: false, notified: new Set() })
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
    this.emit('change')
  }

  // ---- transport -----------------------------------------------------------

  private async syncTransportConfig(): Promise<void> {
    const st = this.deps.syncthing
    if (!st?.running) return
    try {
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
        await st.scan(worldId)
        this.dirty.delete(worldId)
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
      this.pendingDevices = (await st.pendingDevices()).filter((d) => !this.cfg.peers.some((p) => p.syncthingId === d.deviceId && !p.removed))
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

  private setStatus(worldId: string, status: WorldStatus, detail = ''): void {
    const rt = this.runtimes.get(worldId)!
    rt.status = status
    rt.detail = detail
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
      rt.warnings = rejected.slice(0, 5)
      let res = resolve(events)
      rt.resolution = res
      rt.pendingUpdate = 'accepted' in res && res.accepted.contentId !== st.liveContentId

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
        const ev = await this.emitEvent(store, {
          kind: 'capture',
          contentId,
          files,
          parents: st.basis,
          reason: st.initialized ? 'local' : 'import',
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
        await this.emitEvent(store, { kind: 'decision', candidates: res.headIds, selected: accepted.versionIds[0], basis: res.policy.policy })
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
      this.setStatus(w.id, 'waiting-for-peer', `Receiving ${missing.length} of ${accepted.files.length} file(s) from ${accepted.deviceNames.join(', ')}.`)
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
    await this.emitEvent(this.stores.get(worldId)!, { kind: 'policy', policy, preferredDeviceId: policy === 'preferred-device' ? preferredDeviceId : undefined })
    void this.tick()
  }

  /** Resolves a conflict by recording which candidate becomes the shared continuation. */
  async chooseCandidate(worldId: string, contentId: string): Promise<void> {
    const rt = this.runtimes.get(worldId)
    const res = rt?.resolution
    if (!res || res.state !== 'conflict') throw new Error('There is no conflict to resolve.')
    const chosen = res.candidates.find((c) => c.contentId === contentId)
    if (!chosen) throw new Error('Unknown candidate')
    await this.emitEvent(this.stores.get(worldId)!, { kind: 'decision', candidates: res.headIds, selected: chosen.versionIds[0], basis: 'user' })
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
    await this.emitEvent(store, { kind: 'restore', contentId, files: source.files, parents, restoredFrom: source.id })
    void this.tick()
  }

  // ---- read models ---------------------------------------------------------

  async history(worldId: string): Promise<{ groups: (ContentGroup & { accepted: boolean; live: boolean })[]; decisions: unknown[] }> {
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
    return { groups, decisions }
  }

  async discover(): Promise<{ gameId: string; gameName: string; name: string; path: string; added: boolean; lastPlayedAt: number }[]> {
    const out: { gameId: string; gameName: string; name: string; path: string; added: boolean; lastPlayedAt: number }[] = []
    for (const game of GAMES) {
      const d = game.discovery
      if (!d || d.platform !== process.platform) continue
      const base = d.base.replace('{documents}', this.deps.documentsDir)
      let level = [base]
      for (let i = 0; i < d.depth; i++) {
        const next: string[] = []
        for (const dir of level) {
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
          for (const e of entries) if (e.isDirectory()) next.push(join(dir, e.name))
        }
        level = next
      }
      const want = globToRegExp(d.mustContain)
      for (const dir of level) {
        const files = await readdir(dir).catch(() => [] as string[])
        const saves = files.filter((f) => want.test(f))
        if (!saves.length) continue
        const times = await Promise.all(saves.map((f) => stat(join(dir, f)).then((s) => s.mtimeMs, () => 0)))
        const added = this.cfg.worlds.some((w) => resolvePath(w.localPath).toLowerCase() === resolvePath(dir).toLowerCase())
        out.push({
          gameId: game.id,
          gameName: game.name,
          name: basename(dir).replace(/^MP-/, ''),
          path: dir,
          added,
          lastPlayedAt: Math.max(...times),
        })
      }
    }
    return out.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
  }

  snapshot() {
    return {
      device: {
        name: this.cfg.deviceName,
        deviceId: this.cfg.identity.deviceId,
        syncthingId: this.deps.syncthing?.myId ?? '',
        invite: this.deps.syncthing?.myId ? this.invite() : '',
        startAtLogin: this.cfg.startAtLogin,
      },
      transport: { ok: !this.transportError, error: this.transportError },
      peers: this.cfg.peers
        .filter((p) => !p.removed)
        .map((p) => ({ deviceId: p.deviceId, name: p.name, connected: !!this.connections[p.syncthingId], addedAt: p.addedAt })),
      pendingDevices: this.pendingDevices,
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
          policy: res?.policy ?? { policy: 'ask' as Policy },
          conflict: res?.state === 'conflict' ? candidates : null,
          autoNote: res?.state === 'auto-resolved' ? res.note : null,
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

  /** Backs up the live folder on demand (used before risky user actions). */
  async backupNow(worldId: string): Promise<string> {
    const w = this.world(worldId)
    const dir = this.backupDir(w.id, 'manual')
    await backupFolder(w.localPath, w.include, w.exclude, dir)
    return dir
  }
}

export type EngineSnapshot = ReturnType<Engine['snapshot']>
