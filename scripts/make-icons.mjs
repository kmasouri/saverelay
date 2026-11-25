// Renders the app icon (a glowing ember on a dark rounded tile) to PNG without
// image dependencies. Outputs build/icon.png and resources/tray*.png.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const ss = 4 // supersampling
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size)
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa
        }
      const o = y * (size * 4 + 1) + 1 + x * 4
      const n = ss * ss
      raw[o] = a ? Math.round(r / a) : 0
      raw[o + 1] = a ? Math.round(g / a) : 0
      raw[o + 2] = a ? Math.round(b / a) : 0
      raw[o + 3] = Math.round((a / n) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.min(1, Math.max(0, t)))

// Flame silhouette: a teardrop pointing up, with a hot core.
function flame(u, v) {
  const x = (u - 0.5) / 0.30
  const y = (v - 0.60) / 0.30
  const r = y < 0 ? Math.hypot(x / (1 + y * 0.9), y) : Math.hypot(x, y)
  return r
}

function appIcon(u, v) {
  const m = 0.06, rad = 0.2
  const dx = Math.max(m + rad - u, 0, u - (1 - m - rad))
  const dy = Math.max(m + rad - v, 0, v - (1 - m - rad))
  if (Math.hypot(dx, dy) > rad) return [0, 0, 0, 0]
  const bg = mix([38, 28, 34], [20, 16, 22], v)
  const f = flame(u, v)
  const glow = Math.max(0, 1 - f / 1.6) ** 2
  let col = mix(bg, [255, 110, 40], glow * 0.55)
  if (f < 1) col = mix([255, 92, 38], [255, 214, 120], (1 - f) * 1.4)
  return [...col, 1]
}

function trayIcon(u, v) {
  const f = flame(u, v + 0.04)
  if (f > 1.15) return [0, 0, 0, 0]
  const col = mix([255, 92, 38], [255, 214, 120], (1 - f) * 1.4)
  return [...col, f < 1 ? 1 : (1.15 - f) / 0.15]
}

const out = [
  ['build/icon.png', 512, appIcon],
  ['resources/icon.png', 256, appIcon],
  ['resources/tray.png', 16, trayIcon],
  ['resources/tray@2x.png', 32, trayIcon],
]
for (const [rel, size, fn] of out) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, png(size, fn))
  console.log(`${rel} (${size}px)`)
}
