import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Arch } from 'electron-builder'
import metadata from '../package.json' with { type: 'json' }

const readText = (path) => readFileSync(path, 'utf8')
const readJson = (path) => JSON.parse(readText(path))
const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escapeHtml = (value) => value.replace(/[&<>"]/g, (char) => escapes[char])

function section(title, text) {
  if (!text?.trim()) throw new Error(`Missing license text for ${title}`)
  return `<details><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(text)}</pre></details>`
}

function installedPackageLicense(directory, entry) {
  const files = readdirSync(directory)
    .filter((file) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file))
    .sort()
  if (files.length) return files.map((file) => readText(join(directory, file))).join('\n\n')

  // The published lazy-val 1.0.5 package declares MIT and provides an author in its metadata.
  // It omits the license file. Include the MIT permission text with that attribution.
  if (entry.name === 'lazy-val' && entry.version === '1.0.5' && entry.license === 'MIT') {
    return `Author: ${entry.author}

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
  }
  throw new Error(`Missing license files for ${entry.name}@${entry.version}`)
}

function npmLicenses(root) {
  const licenses = new Map()
  for (const target of ['main', 'preload', 'renderer']) {
    const entries = readJson(join(root, 'out', target, 'license-report.json'))
    for (const { name, version, identifier, text } of entries) {
      licenses.set(`${name}@${version}`, { identifier, text })
    }
  }

  // Electron Builder ships the production dependency tree alongside the compiled bundles.
  const { packages } = readJson(join(root, 'package-lock.json'))
  for (const [path, dependency] of Object.entries(packages)) {
    if (!path || dependency.dev) continue
    const directory = join(root, path)
    if (dependency.optional && !existsSync(directory)) continue
    const entry = readJson(join(directory, 'package.json'))
    licenses.set(`${entry.name}@${entry.version}`, {
      identifier: entry.license,
      text: installedPackageLicense(directory, entry),
    })
  }
  return [...licenses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, { identifier, text }]) =>
    section(identifier ? `${name} (${identifier})` : name, text),
  ).join('\n')
}

export default function packageLicenses({ appOutDir, arch, electronPlatformName, packager }) {
  if (electronPlatformName !== 'win32') return

  const root = packager.projectDir
  const electron = join(appOutDir, 'LICENSE.electron.txt')
  const chromium = join(appOutDir, 'LICENSES.chromium.html')
  const syncthing = join(appOutDir, 'resources', 'syncthing', 'LICENSE.txt')
  const version = metadata.config.syncthingVersion
  const targetArch = Arch[arch]
  const versionFile = join(root, 'resources', 'syncthing', `win32-${targetArch}.version`)
  if (!existsSync(versionFile) || readText(versionFile) !== version) {
    throw new Error(`Fetch Syncthing ${version} with node scripts/fetch-syncthing.mjs win32 ${targetArch} before packaging`)
  }
  const chromiumCredits = readText(chromium)
  // Retain the generated credits body and all of its attribution and license text.
  const creditsBody = chromiumCredits.match(/<body>[\s\S]*$/i)?.[0]
  if (!creditsBody) throw new Error('Chromium credits are missing the expected HTML body')
  const credits = creditsBody.replace(/^<body>/i, '').replace(/(?:<\/(?:body|html)>\s*)+$/i, '')

  writeFileSync(join(appOutDir, 'LICENSES.html'), `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>SaveRelay software licenses</title>
<style>
  body { max-width: 72rem; margin: 2rem auto; padding: 0 1rem; font: 1rem/1.5 system-ui, sans-serif; }
  details { margin-block: .5rem; }
  summary { cursor: pointer; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .product { border-block-start: 1px solid; padding-block: 1rem; }
  .product .title { font-weight: bold; }
  .page-title, label.show { display: none; }
</style>
<body>
<h1>SaveRelay software licenses</h1>
${section('SaveRelay (The Unlicense)', readText(join(root, 'LICENSE')))}
<h2>Bundled software</h2>
<p>Syncthing ${escapeHtml(version)} ships with a Windows icon and file description set by SaveRelay.
<a href="https://github.com/syncthing/syncthing/tree/${encodeURIComponent(version)}">Syncthing source code</a> ·
<a href="https://github.com/kmasouri/saverelay/blob/v${encodeURIComponent(metadata.version)}/.github/workflows/release.yml">Windows resource changes</a></p>
${section(`Syncthing ${version} (MPL 2.0)`, readText(syncthing))}
${section('Electron (MIT)', readText(electron))}
<details><summary>Chromium credits and licenses</summary>
${credits}
</details>
<h2>npm packages</h2>
${npmLicenses(root)}
</body>
</html>
`)

  // Only remove standalone copies after the consolidated document has been written.
  for (const path of [electron, chromium, syncthing]) unlinkSync(path)
}
