import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './engine/config'
import { Engine, type NewWorldInput } from './engine/engine'
import { systemProcessDetector } from './engine/process'
import { Syncthing } from './engine/syncthing'
import { createLogger } from './logger'
import { Updater } from './updater'
import type { Policy } from '../core/types'

const APP_ID = 'com.kmasouri.calmember'
const here = dirname(fileURLToPath(import.meta.url))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  app.setAppUserModelId(APP_ID)
  await app.whenReady()

  const dataDir = app.getPath('userData')
  const logger = createLogger(join(dataDir, 'logs'))
  const log = logger.log
  log(`Calm Ember ${app.getVersion()} starting on ${process.platform}-${process.arch}`)

  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing'
  const syncthingBin = app.isPackaged ? join(resources, 'syncthing', exe) : join(resources, 'syncthing', `${process.platform}-${process.arch}`, exe)

  let syncthing: Syncthing | null = null
  const engineRef: { current: Engine | null } = { current: null }

  const notify = (title: string, body: string): void => {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, icon: join(resources, 'icon.png') })
      n.on('click', () => showWindow())
      n.show()
    }
  }

  // The transport's API key is per-install, persisted in our config, and only used on 127.0.0.1.
  const { syncthingApiKey } = await loadConfig(join(dataDir, 'config.json'))
  if (existsSync(syncthingBin)) {
    syncthing = new Syncthing({ binary: syncthingBin, home: join(dataDir, 'syncthing'), apiKey: syncthingApiKey, log })
    try {
      await syncthing.start()
      log(`Syncthing started as ${syncthing.myId}`)
    } catch (err) {
      log(`Syncthing failed to start: ${String(err)}`)
    }
  } else {
    log(`Syncthing binary missing at ${syncthingBin}`)
  }
  const engine = await Engine.create({ dataDir, documentsDir: app.getPath('documents'), syncthing, detector: systemProcessDetector, notify, log })
  engineRef.current = engine

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
      title: 'Calm Ember',
      backgroundColor: '#17131a',
      icon: join(resources, 'icon.png'),
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
    if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void w.loadFile(join(here, '../renderer/index.html'))
    return w
  }

  function showWindow(): void {
    if (!win || win.isDestroyed()) win = createWindow()
    win.show()
    win.focus()
  }

  app.on('second-instance', () => showWindow())

  const trayImage = nativeImage.createFromPath(join(resources, 'tray.png'))
  const tray = new Tray(trayImage)
  tray.setToolTip('Calm Ember')
  const buildTrayMenu = (): void => {
    const snap = engine.snapshot()
    const worldItems = snap.worlds.map((w) => ({ label: `${w.name}: ${w.status.replace(/-/g, ' ')}`, enabled: false }))
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Calm Ember', click: showWindow },
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
  const fullState = () => ({ ...engine.snapshot(), app: { version: app.getVersion(), packaged: app.isPackaged, logFile: logger.file }, update: updater.state })
  const push = (): void => {
    if (pushTimer) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      buildTrayMenu()
      if (win && !win.isDestroyed()) win.webContents.send('ce:state', fullState())
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
    setPolicy: (id, policy, preferred) => engine.setPolicy(str(id, 64), str(policy, 32) as Policy, preferred === undefined ? undefined : str(preferred, 64)),
    chooseCandidate: (id, contentId) => engine.chooseCandidate(str(id, 64), str(contentId, 64)),
    restore: (id, contentId) => engine.restore(str(id, 64), str(contentId, 64)),
    history: (id) => engine.history(str(id, 64)),
    backupNow: (id) => engine.backupNow(str(id, 64)),
    openPath: async (p) => {
      const path = str(p)
      const allowed = path.startsWith(dataDir) || engine.config.worlds.some((w) => w.localPath === path)
      if (allowed) await shell.openPath(path)
    },
    exportDiagnostics: async () => {
      const res = await dialog.showSaveDialog(win!, { defaultPath: `calm-ember-diagnostics-${Date.now()}.json` })
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
  ipcMain.handle('ce:invoke', async (e, name: unknown, ...args: unknown[]) => {
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
    if (!syncthing?.running && !engineRef.current) return
    e.preventDefault()
    const shutdown = async (): Promise<void> => {
      await engineRef.current?.stop()
      engineRef.current = null
      await syncthing?.stop()
      syncthing = null
      app.quit()
    }
    void shutdown()
  })
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })

  buildTrayMenu()
  if (!startHidden) showWindow()
  await engine.start()
  updater.start()
}
