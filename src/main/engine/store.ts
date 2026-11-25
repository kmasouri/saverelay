// The staging store for one shared world. Synced verbatim by the transport and
// never pointed at the live game folder.
//
//   <root>/world.json                       written once by the creator
//   <root>/objects/<aa>/<sha256>            content-addressed file blobs
//   <root>/events/<deviceId>/<eventId>.json signed events; each device writes only its own dir

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { verifyEvent } from '../../core/identity'
import type { SignedEvent, SyncEvent } from '../../core/types'
import { parseEvent } from '../../core/validate'
import { TMP_SUFFIX, hashFile } from './scanner'

export interface WorldMeta {
  worldId: string
  name: string
  gameId: string
  createdBy: string
  createdAt: number
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, path)
}

export class WorldStore {
  private cache = new Map<string, { mtimeMs: number; event: SignedEvent | null }>()

  constructor(
    readonly root: string,
    readonly worldId: string,
  ) {}

  async init(meta?: WorldMeta): Promise<void> {
    await mkdir(join(this.root, 'objects'), { recursive: true })
    await mkdir(join(this.root, 'events'), { recursive: true })
    // Transport must never sync our temp files.
    await writeFile(join(this.root, '.stignore'), `(?d)*${TMP_SUFFIX}\n`)
    if (meta) await writeJsonAtomic(join(this.root, 'world.json'), meta)
  }

  async readMeta(): Promise<WorldMeta | null> {
    try {
      const m = JSON.parse(await readFile(join(this.root, 'world.json'), 'utf8'))
      return m?.worldId === this.worldId && typeof m.name === 'string' ? m : null
    } catch {
      return null
    }
  }

  objectPath(sha256: string): string {
    return join(this.root, 'objects', sha256.slice(0, 2), sha256)
  }

  async hasObject(sha256: string, size: number): Promise<boolean> {
    try {
      return (await stat(this.objectPath(sha256))).size === size
    } catch {
      return false
    }
  }

  /** Copies a live file into the store, hashing while copying. Returns what was actually stored. */
  async putFile(source: string): Promise<{ sha256: string; size: number }> {
    const tmp = join(this.root, 'objects', `${randomUUID()}${TMP_SUFFIX}`)
    const hash = createHash('sha256')
    let size = 0
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk)
        size += chunk.length
        cb(null, chunk)
      },
    })
    try {
      await pipeline(createReadStream(source), tap, createWriteStream(tmp))
      const sha256 = hash.digest('hex')
      const dest = this.objectPath(sha256)
      if (await this.hasObject(sha256, size)) {
        await rm(tmp, { force: true })
      } else {
        await mkdir(dirname(dest), { recursive: true })
        await rename(tmp, dest)
      }
      return { sha256, size }
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  /** Re-hashes a stored object; transport delivery is never trusted on its own. */
  async verifyObject(sha256: string, size: number): Promise<boolean> {
    try {
      const actual = await hashFile(this.objectPath(sha256))
      return actual.sha256 === sha256 && actual.size === size
    } catch {
      return false
    }
  }

  async writeEvent(event: SignedEvent): Promise<void> {
    await writeJsonAtomic(join(this.root, 'events', event.deviceId, `${event.id}.json`), event)
  }

  /**
   * Loads every structurally valid event signed by a known device key.
   * Unknown authors and bad signatures are reported, never applied.
   */
  async loadEvents(keys: Map<string, string>): Promise<{ events: SyncEvent[]; rejected: string[] }> {
    const events: SyncEvent[] = []
    const rejected: string[] = []
    const eventsDir = join(this.root, 'events')
    let authors: string[] = []
    try {
      authors = await readdir(eventsDir)
    } catch {
      return { events, rejected }
    }
    for (const author of authors) {
      const publicKey = keys.get(author)
      let names: string[]
      try {
        names = (await readdir(join(eventsDir, author))).filter((n) => n.endsWith('.json'))
      } catch {
        continue
      }
      if (!publicKey) {
        if (names.length) rejected.push(`${names.length} event(s) from untrusted device ${author}`)
        continue
      }
      for (const name of names) {
        const file = join(eventsDir, author, name)
        let mtimeMs: number
        try {
          mtimeMs = (await stat(file)).mtimeMs
        } catch {
          continue
        }
        let cached = this.cache.get(file)
        if (!cached || cached.mtimeMs !== mtimeMs) {
          let event: SignedEvent | null = null
          try {
            const parsed = parseEvent(JSON.parse(await readFile(file, 'utf8')), this.worldId, author)
            if (parsed && `${parsed.id}.json` === name && verifyEvent(parsed, publicKey)) event = parsed
          } catch {
            event = null
          }
          cached = { mtimeMs, event }
          this.cache.set(file, cached)
        }
        if (cached.event) events.push(cached.event)
        else rejected.push(`invalid event ${author}/${name}`)
      }
    }
    return { events, rejected }
  }
}
