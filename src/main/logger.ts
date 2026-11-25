import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

export function createLogger(dir: string): { log: (msg: string) => void; file: string; recent: () => string[] } {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'main.log')
  const ring: string[] = []
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} ${msg}`
    ring.push(line)
    if (ring.length > 500) ring.shift()
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.1`)
      appendFileSync(file, line + '\n')
    } catch {
      /* logging must never take the app down */
    }
  }
  return { log, file, recent: () => [...ring] }
}
