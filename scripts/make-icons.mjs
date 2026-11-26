// Renders the app icon (the Relay Loop mark on a dark rounded tile) to PNG without
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

// Relay Loop: two arrows chasing each other round a circle, in a 100x100 box.
// Each arc is drawn clockwise (screen angles, y down) and ends in an arrowhead.
const ARCS = [
  { from: 160, span: 140, color: [255, 122, 61], head: [[69.8, 33.7], [66.5, 21.4], [57.5, 37]] },
  { from: 340, span: 140, color: [255, 179, 71], head: [[30.2, 66.3], [33.5, 78.6], [42.5, 63]] },
]
const R = 24, HALF = 4.5

function inTriangle([px, py], [a, b, c]) {
  const side = (p, q) => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0])
  const d1 = side(a, b), d2 = side(b, c), d3 = side(c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

function onArc(x, y, { from, span }) {
  const end = (a) => [50 + R * Math.cos((a * Math.PI) / 180), 50 + R * Math.sin((a * Math.PI) / 180)]
  const rel = (((Math.atan2(y - 50, x - 50) * 180) / Math.PI - from) % 360 + 360) % 360
  if (rel <= span && Math.abs(Math.hypot(x - 50, y - 50) - R) <= HALF) return true
  return [end(from), end(from + span)].some(([ex, ey]) => Math.hypot(x - ex, y - ey) <= HALF)
}

// Colour of the mark at (x, y) in the 100x100 box, or null outside it.
function mark(x, y) {
  for (const arc of ARCS) if (onArc(x, y, arc) || inTriangle([x, y], arc.head)) return arc.color
  return null
}

function appIcon(u, v) {
  const m = 0.06, rad = 0.2
  const dx = Math.max(m + rad - u, 0, u - (1 - m - rad))
  const dy = Math.max(m + rad - v, 0, v - (1 - m - rad))
  if (Math.hypot(dx, dy) > rad) return [0, 0, 0, 0]
  return [...(mark(u * 100, v * 100) ?? mix([46, 37, 52], [36, 29, 41], v)), 1]
}

// The tray drops the tile and crops to the mark so it fills the 16px slot.
function trayIcon(u, v) {
  const col = mark(16 + u * 68, 16 + v * 68)
  return col ? [...col, 1] : [0, 0, 0, 0]
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
