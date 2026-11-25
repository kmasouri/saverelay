import { canonicalJson, sha256Hex } from './canonical'
import { SCHEMA } from './types'

/**
 * Content identity of a snapshot: schema, shared world id, and the sorted relative
 * paths, sizes and hashes. Contributors, timestamps, local paths and ancestry are
 * deliberately excluded so identical saves group across devices.
 */
export function contentIdOf(worldId: string, files: { path: string; size: number; sha256: string }[]): string {
  const entries = files
    .map((f) => [f.path, f.size, f.sha256] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return sha256Hex(canonicalJson({ schema: SCHEMA, worldId, files: entries }))
}
