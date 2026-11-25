// Downloads a pinned Syncthing release into resources/syncthing/<platform>-<arch>/,
// verifying the archive against the release's published SHA-256 list.
// Usage: node scripts/fetch-syncthing.mjs [platform] [arch]   (defaults to the host)
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, copyFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 'v2.1.7'
const platform = process.argv[2] ?? process.platform
const arch = process.argv[3] ?? process.arch

const osName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform]
const archName = { x64: 'amd64', arm64: 'arm64' }[arch]
if (!osName || !archName) throw new Error(`Unsupported target ${platform}-${arch}`)

const ext = osName === 'linux' ? 'tar.gz' : 'zip'
const base = `syncthing-${osName}-${archName}-${VERSION}`
const url = `https://github.com/syncthing/syncthing/releases/download/${VERSION}/${base}.${ext}`
const sumsUrl = `https://github.com/syncthing/syncthing/releases/download/${VERSION}/sha256sum.txt.asc`

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'syncthing', `${platform}-${arch}`)
const exe = platform === 'win32' ? 'syncthing.exe' : 'syncthing'
if (existsSync(join(outDir, exe))) {
  console.log(`Syncthing already present at ${outDir}`)
  process.exit(0)
}

async function get(u) {
  const res = await fetch(u)
  if (!res.ok) throw new Error(`GET ${u} -> ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const [archive, sums] = await Promise.all([get(url), get(sumsUrl)])
const expected = sums
  .toString('utf8')
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .find((parts) => parts[1] === `${base}.${ext}`)?.[0]
const actual = createHash('sha256').update(archive).digest('hex')
if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${base}.${ext}`)

const work = mkdtempSync(join(tmpdir(), 'syncthing-'))
const archivePath = join(work, `${base}.${ext}`)
writeFileSync(archivePath, archive)
// Windows 10+ ships bsdtar, which also reads zip files.
if (ext === 'zip' && process.platform !== 'win32') execFileSync('unzip', ['-q', archivePath, '-d', work])
else if (ext === 'zip') execFileSync('tar', ['-xf', archivePath, '-C', work])
else execFileSync('tar', ['-xzf', archivePath, '-C', work])

const extracted = join(work, readdirSync(work).find((n) => n === base) ?? base)
mkdirSync(outDir, { recursive: true })
copyFileSync(join(extracted, exe), join(outDir, exe))
if (platform !== 'win32') chmodSync(join(outDir, exe), 0o755)
if (existsSync(join(extracted, 'LICENSE.txt'))) copyFileSync(join(extracted, 'LICENSE.txt'), join(outDir, 'LICENSE.txt'))
rmSync(work, { recursive: true, force: true })
console.log(`Syncthing ${VERSION} -> ${outDir}`)
