import { contentIdOf } from './manifest'
import { normalizeRelPath } from './paths'
import { SCHEMA, type FileEntry, type Policy, type SignedEvent } from './types'

export const MAX_FILES_PER_SNAPSHOT = 10_000
export const MAX_FILE_SIZE = 8 * 1024 ** 3

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9-]{1,64}$/
const POLICIES: Policy[] = ['ask', 'latest-modified', 'preferred-device']

const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 1000 && v.every((x) => isStr(x) && ID.test(x))

function validFiles(worldId: string, files: unknown, contentId: unknown): files is FileEntry[] {
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_SNAPSHOT || !isStr(contentId)) return false
  const seen = new Set<string>()
  for (const f of files) {
    if (!f || typeof f !== 'object') return false
    const { path, size, sha256, mtimeMs } = f as Record<string, unknown>
    if (!isStr(path, 400) || normalizeRelPath(path) !== path) return false
    if (!isNum(size) || size > MAX_FILE_SIZE || !isNum(mtimeMs)) return false
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return false
    const key = path.toLowerCase() // Windows folders are case-insensitive
    if (seen.has(key)) return false
    seen.add(key)
  }
  return contentIdOf(worldId, files as FileEntry[]) === contentId
}

/**
 * Structural validation of an untrusted event read from the shared store.
 * Signature verification happens separately, against the author's trusted key.
 */
export function parseEvent(raw: unknown, worldId: string, authorDir: string): SignedEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (e.schema !== SCHEMA || e.worldId !== worldId || e.deviceId !== authorDir) return null
  if (!isStr(e.id) || !ID.test(e.id) || !isStr(e.deviceName, 64) || !isNum(e.at) || !isStr(e.sig, 200)) return null
  switch (e.kind) {
    case 'capture':
      if (!isIds(e.parents) || (e.reason !== 'local' && e.reason !== 'import')) return null
      return validFiles(worldId, e.files, e.contentId) ? (e as unknown as SignedEvent) : null
    case 'restore':
      if (!isIds(e.parents) || !isStr(e.restoredFrom) || !ID.test(e.restoredFrom)) return null
      return validFiles(worldId, e.files, e.contentId) ? (e as unknown as SignedEvent) : null
    case 'applied':
      return isStr(e.contentId) && HEX64.test(e.contentId) && isIds(e.versionIds) ? (e as unknown as SignedEvent) : null
    case 'decision':
      if (!isIds(e.candidates) || !isStr(e.selected) || !e.candidates.includes(e.selected)) return null
      if (e.seen !== undefined && !isIds(e.seen)) return null
      return e.basis === 'user' || POLICIES.includes(e.basis as Policy) ? (e as unknown as SignedEvent) : null
    case 'policy':
      if (!POLICIES.includes(e.policy as Policy)) return null
      if (e.preferredDeviceId !== undefined && !isStr(e.preferredDeviceId)) return null
      if (e.keepVersions !== undefined && !(Number.isInteger(e.keepVersions) && isNum(e.keepVersions) && (e.keepVersions as number) <= 10_000)) return null
      return e as unknown as SignedEvent
    default:
      return null
  }
}
