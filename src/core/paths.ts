// Relative-path validation and glob matching. Manifests travel between machines,
// so every path is treated as hostile until it passes `normalizeRelPath`.

const MAX_PATH_LENGTH = 400
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/** Returns a normalized forward-slash relative path, or null if the path is unsafe. */
export function normalizeRelPath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_LENGTH) return null
  if (input.includes('\0')) return null
  const p = input.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null
  const parts = p.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null
    if (/[<>:"|?*\x00-\x1f]/.test(part)) return null
    if (WINDOWS_RESERVED.test(part) || part.endsWith('.') || part.endsWith(' ')) return null
  }
  return parts.join('/')
}

const globCache = new Map<string, RegExp>()

/** Minimal glob: `**` spans directories, `*` and `?` stay within one segment. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob)
  if (re) return re
  let src = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      src += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') src += '[^/]*'
    else if (c === '?') src += '[^/]'
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  re = new RegExp(`^${src}$`, 'i')
  globCache.set(glob, re)
  return re
}

export function isIncluded(relPath: string, include: string[], exclude: string[]): boolean {
  const inc = include.length === 0 || include.some((g) => globToRegExp(g).test(relPath))
  return inc && !exclude.some((g) => globToRegExp(g).test(relPath))
}
