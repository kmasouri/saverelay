// Windows shows a program's built-in description and icon in Task Manager and
// firewall prompts. Label the bundled Syncthing as part of SaveRelay so it isn't a
// mystery process. Syncthing's MPL-2.0 license allows this; its LICENSE.txt and
// copyright string ship unchanged. Run on Windows after fetch-syncthing.mjs.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rcedit } from 'rcedit'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exe = join(root, 'resources', 'syncthing', 'win32-x64', 'syncthing.exe')

// An .ico can hold a PNG as-is: a 6-byte header, one 16-byte entry, then the PNG.
const png = readFileSync(join(root, 'resources', 'icon.png'))
const header = Buffer.alloc(22)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // one image
header.writeUInt8(0, 6) // width 256
header.writeUInt8(0, 7) // height 256
header.writeUInt16LE(1, 10) // colour planes
header.writeUInt16LE(32, 12) // bits per pixel
header.writeUInt32LE(png.length, 14)
header.writeUInt32LE(22, 18) // image data offset
const icon = join(mkdtempSync(join(tmpdir(), 'saverelay-icon-')), 'icon.ico')
writeFileSync(icon, Buffer.concat([header, png]))

await rcedit(exe, {
  icon,
  'version-string': {
    FileDescription: 'SaveRelay Sync',
    ProductName: 'SaveRelay Sync',
    Comments: 'Syncthing, bundled with SaveRelay to move saves between friends',
  },
})
console.log(`Branded ${exe} as SaveRelay Sync`)
