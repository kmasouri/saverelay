import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { newIdentity, type Identity } from '../../core/identity'
import { writeJsonAtomic } from './store'

export interface Peer {
  deviceId: string
  name: string
  publicKey: string
  syncthingId: string
  addedAt: number
  /** Removed peers keep their key so history they contributed stays verifiable. */
  removed?: boolean
}

export interface WorldConfig {
  id: string
  name: string
  gameId: string
  localPath: string
  processNames: string[]
  include: string[]
  exclude: string[]
  /** Peer deviceIds this device sends/receives this world with. */
  sharedWith: string[]
  /** contribute: publish existing local saves; receive: back them up and take the shared version. */
  mode: 'contribute' | 'receive'
  addedAt: number
}

export interface AppConfig {
  version: 1
  deviceName: string
  identity: Identity
  syncthingApiKey: string
  peers: Peer[]
  worlds: WorldConfig[]
  startAtLogin: boolean
}

export async function loadConfig(path: string): Promise<AppConfig> {
  try {
    const cfg = JSON.parse(await readFile(path, 'utf8')) as AppConfig
    if (cfg.version === 1 && cfg.identity?.privateKey) return cfg
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const cfg: AppConfig = {
    version: 1,
    deviceName: hostname().slice(0, 64) || 'My PC',
    identity: newIdentity(),
    syncthingApiKey: randomBytes(24).toString('base64url'),
    peers: [],
    worlds: [],
    startAtLogin: true,
  }
  await saveConfig(path, cfg)
  return cfg
}

export function saveConfig(path: string, cfg: AppConfig): Promise<void> {
  return writeJsonAtomic(path, cfg)
}
