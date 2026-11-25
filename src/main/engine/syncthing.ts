// Transport adapter: runs a private Syncthing instance (authenticated, encrypted,
// NAT traversal and relays) and drives it over its localhost REST API. Only
// staging-store folders are ever shared; live game folders are never handed to it.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'

export interface SyncthingOptions {
  binary: string
  home: string
  apiKey: string
  /** Extra settings applied on start; tests use these to stay on localhost. */
  options?: Record<string, unknown>
  log: (msg: string) => void
}

export interface PendingFolder {
  folderId: string
  label: string
  offeredBy: string[]
}

export const FOLDER_PREFIX = 'calm-ember-'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}

export class Syncthing {
  private child: ChildProcess | null = null
  private base = ''
  private stopping = false
  myId = ''

  constructor(private readonly opts: SyncthingOptions) {}

  async start(): Promise<void> {
    await mkdir(this.opts.home, { recursive: true })
    const port = await freePort()
    this.base = `http://127.0.0.1:${port}`
    this.stopping = false
    const child = spawn(
      this.opts.binary,
      ['serve', `--home=${this.opts.home}`, '--no-browser', `--gui-address=127.0.0.1:${port}`, `--gui-apikey=${this.opts.apiKey}`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STNOUPGRADE: '1', STNORESTART: '1' } },
    )
    this.child = child
    const forward = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) this.opts.log(`[syncthing] ${line}`)
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('exit', (code) => {
      this.child = null
      if (!this.stopping) this.opts.log(`[syncthing] exited unexpectedly with code ${code}`)
    })

    const deadline = Date.now() + 60_000
    for (;;) {
      if (!this.child) throw new Error('Syncthing exited during startup')
      try {
        const status = await this.get<{ myID: string }>('/rest/system/status')
        this.myId = status.myID
        break
      } catch {
        if (Date.now() > deadline) throw new Error('Syncthing did not start within 60s')
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    await this.patch('/rest/config/options', {
      urAccepted: -1,
      autoUpgradeIntervalH: 0,
      startBrowser: false,
      crashReportingEnabled: false,
      ...this.opts.options,
    })
    // New folders must never be auto-accepted; joining a world is an explicit user action.
    await this.patch('/rest/config/defaults/device', { autoAcceptFolders: false })
  }

  get running(): boolean {
    return this.child !== null
  }

  async stop(): Promise<void> {
    if (!this.child) return
    this.stopping = true
    const child = this.child
    try {
      await this.request('POST', '/rest/system/shutdown')
    } catch {
      child.kill()
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 10_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'X-API-Key': this.opts.apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Syncthing ${method} ${path} -> ${res.status} ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }
  private patch(path: string, body: unknown): Promise<void> {
    return this.request('PATCH', path, body)
  }

  async ensureDevice(deviceId: string, name: string, addresses: string[] = ['dynamic']): Promise<void> {
    await this.request('PUT', `/rest/config/devices/${encodeURIComponent(deviceId)}`, {
      deviceID: deviceId,
      name,
      addresses,
      autoAcceptFolders: false,
      introducer: false,
    })
  }

  async removeDevice(deviceId: string): Promise<void> {
    await this.request('DELETE', `/rest/config/devices/${encodeURIComponent(deviceId)}`).catch(() => undefined)
  }

  async ensureFolder(worldId: string, label: string, path: string, deviceIds: string[]): Promise<void> {
    const id = FOLDER_PREFIX + worldId
    await this.request('PUT', `/rest/config/folders/${encodeURIComponent(id)}`, {
      id,
      label: `Calm Ember: ${label}`,
      path,
      type: 'sendreceive',
      devices: [this.myId, ...deviceIds].map((d) => ({ deviceID: d })),
      fsWatcherEnabled: true,
      fsWatcherDelayS: 2,
      rescanIntervalS: 300,
      ignorePerms: true,
      // History lives in our store; the transport never deletes shared content on its own.
      ignoreDelete: true,
    })
  }

  async removeFolder(worldId: string): Promise<void> {
    await this.request('DELETE', `/rest/config/folders/${encodeURIComponent(FOLDER_PREFIX + worldId)}`).catch(() => undefined)
  }

  async pendingFolders(): Promise<PendingFolder[]> {
    const raw = await this.get<Record<string, { offeredBy: Record<string, { label?: string }> }>>('/rest/cluster/pending/folders')
    return Object.entries(raw ?? {})
      .filter(([id]) => id.startsWith(FOLDER_PREFIX))
      .map(([folderId, v]) => ({
        folderId,
        offeredBy: Object.keys(v.offeredBy ?? {}),
        label: Object.values(v.offeredBy ?? {})[0]?.label?.replace(/^Calm Ember: /, '') ?? 'Shared world',
      }))
  }

  async pendingDevices(): Promise<{ deviceId: string; name: string; address: string }[]> {
    const raw = await this.get<Record<string, { name?: string; address?: string }>>('/rest/cluster/pending/devices')
    return Object.entries(raw ?? {}).map(([deviceId, v]) => ({ deviceId, name: v.name ?? '', address: v.address ?? '' }))
  }

  async connections(): Promise<Record<string, boolean>> {
    const raw = await this.get<{ connections: Record<string, { connected: boolean }> }>('/rest/system/connections')
    return Object.fromEntries(Object.entries(raw.connections ?? {}).map(([id, c]) => [id, c.connected]))
  }
}
