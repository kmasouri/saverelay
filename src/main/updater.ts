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
/** How often a downloaded update looks for a quiet moment to install itself. */
const AUTO_INSTALL_EVERY_MS = 60_000

export interface AutoInstall {
  /** The person chose automatic updates. */
  enabled: () => boolean
  /** Restarting now interrupts nothing. */
  safe: () => boolean
  /** Called right before restarting into the update. */
  before: () => void
}

export class Updater extends EventEmitter {
  state: UpdateState = { status: app.isPackaged ? 'idle' : 'disabled' }

  constructor(
    log: (msg: string) => void,
    private readonly auto: AutoInstall,
  ) {
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
      const body = this.auto.enabled() ? `Version ${info.version} installs once you're not playing and nobody is downloading from you.` : `Version ${info.version} installs the next time SaveRelay restarts.`
      new Notification({ title: 'SaveRelay update ready', body }).show()
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
    setInterval(() => this.maybeAutoInstall(), AUTO_INSTALL_EVERY_MS)
  }

  /** With automatic updates on, a downloaded update installs at the first quiet moment. */
  private maybeAutoInstall(): void {
    if (this.state.status !== 'ready' || !this.auto.enabled() || !this.auto.safe()) return
    this.auto.before()
    this.installNow()
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
