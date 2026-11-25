import { execFile } from 'node:child_process'
import { basename } from 'node:path'

export interface ProcessDetector {
  /** Lower-cased executable names of running processes. */
  running(): Promise<Set<string>>
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

export const systemProcessDetector: ProcessDetector = {
  async running() {
    const names = new Set<string>()
    if (process.platform === 'win32') {
      const out = await run('tasklist', ['/FO', 'CSV', '/NH'])
      for (const line of out.split(/\r?\n/)) {
        const m = /^"([^"]+)"/.exec(line)
        if (m) names.add(m[1].toLowerCase())
      }
    } else {
      const out = await run('ps', ['-A', '-o', 'comm='])
      for (const line of out.split('\n')) if (line.trim()) names.add(basename(line.trim()).toLowerCase())
    }
    return names
  },
}

export function isGameRunning(running: Set<string>, processNames: string[]): boolean {
  return processNames.some((n) => running.has(n.toLowerCase()))
}
