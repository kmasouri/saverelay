// Background auto-update (Discord-style): checks quietly, downloads the
// differential update in the background, and swaps it in on the next restart.

import { app, Notification } from 'electron'
import electronUpdater from 'electron-updater'
import { EventEmitter } from 'node:events'

const { autoUpdater } = electronUpdater

export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error'
  version?: string
  progress?: number
  error?: string
  checkedAt?: number
}

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export class Updater extends EventEmitter {
  state: UpdateState = { status: app.isPackaged ? 'idle' : 'disabled' }

  constructor(log: (msg: string) => void) {
    super()
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = { info: (m: unknown) => log(`[updater] ${String(m)}`), warn: (m: unknown) => log(`[updater] ${String(m)}`), error: (m: unknown) => log(`[updater] ${String(m)}`), debug: () => {} }
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, progress: 0 }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'up-to-date', checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (p) => this.set({ ...this.state, status: 'downloading', progress: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version, checkedAt: Date.now() })
      new Notification({ title: 'Calm Ember update ready', body: `Version ${info.version} installs the next time Calm Ember restarts.` }).show()
    })
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: err?.message ?? String(err), checkedAt: Date.now() }))
  }

  private set(state: UpdateState): void {
    this.state = state
    this.emit('change')
  }

  start(): void {
    if (!app.isPackaged) return
    setTimeout(() => void this.check(), 15_000)
    setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  async check(): Promise<void> {
    if (!app.isPackaged || this.state.status === 'downloading' || this.state.status === 'ready') return
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() })
    }
  }

  /** Restarts into the downloaded version without showing the installer UI. */
  installNow(): void {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall(true, true)
  }
}
