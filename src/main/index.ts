import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './engine/config'
import { Engine, type NewWorldInput } from './engine/engine'
import { systemProcessDetector } from './engine/process'
import { Syncthing } from './engine/syncthing'
import { createShutdown } from './lifecycle'
import { createLogger } from './logger'
import { Updater } from './updater'
import type { Policy } from '../core/types'

const APP_ID = 'com.kmasouri.saverelay'
const here = dirname(fileURLToPath(import.meta.url))

const logger = createLogger(join(app.getPath('userData'), 'logs'))
// Every exit goes through here; startup registers what to stop as it starts it.
// A clean quit ends with app.quit() so the updater still installs a downloaded update on the way out.
const shutdown = createShutdown((code) => (code ? app.exit(code) : app.quit()), logger.log)

/**
 * A hard failure: stop everything cleanly, say why, and exit. Never linger
 * invisibly, since a hidden copy holds the single-instance lock and blocks
 * every relaunch.
 */
function fatal(message: string, err: unknown): void {
  if (shutdown.started) return
  logger.log(`${message}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  void shutdown.run(1, () => {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'SaveRelay',
      message,
      detail: `${err instanceof Error ? err.message : String(err)}\n\nThe crash log has the details.`,
      buttons: ['Show crash log', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) shell.showItemInFolder(logger.file)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  process.on('uncaughtException', (err) => fatal('SaveRelay hit an error and has to close', err))
  // Rejections are logged, not fatal: background work already reports its own failures in the UI.
  process.on('unhandledRejection', (err) => logger.log(`Unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
  main().catch((err) => fatal('SaveRelay could not start', err))
}

async function main(): Promise<void> {
  app.setAppUserModelId(APP_ID)
  await app.whenReady()

  const dataDir = app.getPath('userData')
  const log = logger.log
  log(`SaveRelay ${app.getVersion()} starting on ${process.platform}-${process.arch}`)
  // A marker that only a clean exit removes. Still there from before the PC last
  // started means a shutdown, not a crash.
  const runningMarker = join(dataDir, 'running')
  const bootedAt = Date.now() - uptime() * 1000
  const crashedLastTime = (statSync(runningMarker, { throwIfNoEntry: false })?.mtimeMs ?? 0) > bootedAt
  if (crashedLastTime) log('The previous run did not exit cleanly')
  writeFileSync(runningMarker, String(process.pid))
  shutdown.add({ name: 'crash marker', run: () => rmSync(runningMarker, { force: true }), timeoutMs: 1_000 })

  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const appIcon = join(resources, 'app-icon.png')
  const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing'
  const syncthingBin = app.isPackaged ? join(resources, 'syncthing', exe) : join(resources, 'syncthing', `${process.platform}-${process.arch}`, exe)

  let syncthing: Syncthing | null = null

  const notify = (title: string, body: string): void => {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, icon: appIcon })
      n.on('click', () => showWindow())
      n.show()
    }
  }

  // The transport's API key is per-install, persisted in our config, and only used on 127.0.0.1.
  const { syncthingApiKey } = await loadConfig(join(dataDir, 'config.json'))
  if (existsSync(syncthingBin)) {
    // If the sync program dies on its own, bring it back, but not in a loop.
    const restarts: number[] = []
    const restart = (): void => {
      if (shutdown.started) return
      const now = Date.now()
      restarts.splice(0, restarts.length, ...restarts.filter((t) => now - t < 10 * 60_000), now)
      if (restarts.length > 3) return log('Sync program keeps stopping; not restarting it again')
      setTimeout(() => {
        if (shutdown.started || syncthing?.running) return
        syncthing?.start().then(
          () => log('Sync program restarted'),
          (err) => log(`Sync program restart failed: ${String(err)}`),
        )
      }, 5_000)
    }
    syncthing = new Syncthing({ binary: syncthingBin, home: join(dataDir, 'syncthing'), apiKey: syncthingApiKey, log, onUnexpectedExit: restart })
    const transport = syncthing
    shutdown.add({ name: 'sync program', run: () => transport.stop(), timeoutMs: 15_000 })
    try {
      await syncthing.start()
      log(`Syncthing started as ${syncthing.myId}`)
    } catch (err) {
      log(`Syncthing failed to start: ${String(err)}`)
    }
  } else {
    log(`Syncthing binary missing at ${syncthingBin}`)
  }
  const home = app.getPath('home')
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const places = {
    home,
    savedgames: join(home, 'Saved Games'),
    appdata: app.getPath('appData'),
    localappdata: localAppData,
    localappdatalow: join(dirname(localAppData), 'LocalLow'),
  }
  const engine = await Engine.create({ dataDir, documentsDir: app.getPath('documents'), places, syncthing, detector: systemProcessDetector, notify, log })
  shutdown.add({ name: 'engine', run: () => engine.stop(), timeoutMs: 10_000 })

  const updater = new Updater(log)
  const startHidden = process.argv.includes('--hidden')

  app.setLoginItemSettings({ openAtLogin: engine.config.startAtLogin, args: ['--hidden'] })

  // ---- window & tray -------------------------------------------------------

  let win: BrowserWindow | null = null
  let quitting = false

  function createWindow(): BrowserWindow {
    const w = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 820,
      minHeight: 560,
      show: false,
      title: 'SaveRelay',
      backgroundColor: '#17131a',
      // The page draws the title bar; Windows keeps its own buttons, drawn over the top-right corner.
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#130f15', symbolColor: '#a99ca6', height: 36 },
      icon: appIcon,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(here, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    w.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        w.hide()
      }
    })
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    w.webContents.on('will-navigate', (e) => e.preventDefault())
    w.webContents.on('render-process-gone', (_e, details) => {
      log(`Window stopped (${details.reason})`)
      if (details.reason !== 'clean-exit' && !w.isDestroyed()) w.reload()
    })
    if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void w.loadFile(join(here, '../renderer/index.html'))
    return w
  }

  function showWindow(): void {
    if (!win || win.isDestroyed()) win = createWindow()
    win.show()
    win.focus()
  }

  // `SaveRelay.exe --quit` asks the running copy to shut down cleanly.
  app.on('second-instance', (_e, argv) => (argv.includes('--quit') ? app.quit() : showWindow()))

  const trayImage = nativeImage.createFromPath(join(resources, 'tray.png'))
  const tray = new Tray(trayImage)
  tray.setToolTip('SaveRelay')
  const buildTrayMenu = (): void => {
    const snap = engine.snapshot()
    const worldItems = snap.worlds.map((w) => ({ label: `${w.name}: ${w.status.replace(/-/g, ' ')}`, enabled: false }))
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open SaveRelay', click: showWindow },
        { type: 'separator' },
        ...(worldItems.length ? worldItems : [{ label: 'No shared worlds yet', enabled: false }]),
        { type: 'separator' },
        updater.state.status === 'ready'
          ? { label: `Restart to update (${updater.state.version})`, click: () => updater.installNow() }
          : { label: 'Check for updates', enabled: app.isPackaged, click: () => void updater.check() },
        { label: 'Quit', click: () => app.quit() },
      ]),
    )
  }
  tray.on('click', showWindow)

  // ---- state push ------------------------------------------------------------

  let pushTimer: NodeJS.Timeout | null = null
  const fullState = () => ({ ...engine.snapshot(), app: { version: app.getVersion(), packaged: app.isPackaged, logFile: logger.file, crashedLastTime }, update: updater.state })
  const push = (): void => {
    if (pushTimer) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      buildTrayMenu()
      if (win && !win.isDestroyed()) win.webContents.send('sr:state', fullState())
    }, 150)
  }
  engine.on('change', push)
  updater.on('change', push)

  // ---- IPC (narrow, validated surface) --------------------------------------

  const str = (v: unknown, max = 4096): string => {
    if (typeof v !== 'string' || v.length > max) throw new Error('Invalid input')
    return v
  }
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    getState: () => fullState(),
    discover: () => engine.discover(),
    pickFolder: async () => {
      const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Choose the save folder for this world' })
      return res.canceled ? null : res.filePaths[0]
    },
    pickExe: async () => {
      const res = await dialog.showOpenDialog(win!, { properties: ['openFile'], title: 'Choose the game program', filters: [{ name: 'Programs', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] })
      return res.canceled ? null : basename(res.filePaths[0])
    },
    folderWarnings: (p) => engine.folderWarnings(str(p)),
    setDeviceName: (name) => engine.setDeviceName(str(name, 64)),
    setStartAtLogin: async (enabled) => {
      await engine.setStartAtLogin(enabled === true)
      app.setLoginItemSettings({ openAtLogin: enabled === true, args: ['--hidden'] })
    },
    addPeer: (code) => engine.addPeer(str(code, 2048)),
    removePeer: (id) => engine.removePeer(str(id, 64)),
    addWorld: (input) => engine.addWorld(input as NewWorldInput),
    joinWorld: (folderId, input) => engine.joinWorld(str(folderId, 128), input as NewWorldInput),
    updateWorld: (id, patch) => engine.updateWorld(str(id, 64), patch as Partial<NewWorldInput>),
    removeWorld: (id) => engine.removeWorld(str(id, 64)),
    acceptFriendRequest: (id) => engine.acceptFriendRequest(str(id, 80)),
    ignoreFriendRequest: (id) => engine.ignoreFriendRequest(str(id, 80)),
    setKeepVersions: (id, n) => engine.setKeepVersions(str(id, 64), Number(n)),
    setPolicy: (id, policy, preferred) => engine.setPolicy(str(id, 64), str(policy, 32) as Policy, preferred === undefined ? undefined : str(preferred, 64)),
    chooseCandidate: (id, contentId) => engine.chooseCandidate(str(id, 64), str(contentId, 64)),
    dismissOverruled: (id, decisionId) => engine.dismissOverruled(str(id, 64), str(decisionId, 64)),
    restore: (id, contentId) => engine.restore(str(id, 64), str(contentId, 64)),
    history: (id) => engine.history(str(id, 64)),
    openPath: async (p) => {
      const path = str(p)
      const allowed = path.startsWith(dataDir) || engine.config.worlds.some((w) => w.localPath === path)
      if (allowed) await shell.openPath(path)
    },
    showLog: () => shell.showItemInFolder(logger.file),
    exportDiagnostics: async () => {
      const res = await dialog.showSaveDialog(win!, { defaultPath: `saverelay-diagnostics-${Date.now()}.json` })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, JSON.stringify({ ...(await engine.diagnostics()), app: app.getVersion(), update: updater.state, log: logger.recent() }, null, 2))
      return res.filePath
    },
    checkForUpdates: () => updater.check(),
    installUpdate: () => updater.installNow(),
  }
  const trusted = (e: IpcMainInvokeEvent): boolean => {
    const url = e.senderFrame?.url ?? ''
    return url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
  }
  ipcMain.handle('sr:invoke', async (e, name: unknown, ...args: unknown[]) => {
    if (!trusted(e) || typeof name !== 'string' || !Object.hasOwn(handlers, name)) throw new Error('Not allowed')
    try {
      const result = await handlers[name](...args)
      push()
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- go --------------------------------------------------------------------

  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', (e) => {
    if (shutdown.finished) return
    e.preventDefault()
    void shutdown.run(0)
  })
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })

  buildTrayMenu()
  if (!startHidden) showWindow()
  await engine.start()
  updater.start()
}
