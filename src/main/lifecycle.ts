// One way out: every exit — a normal quit, a failed startup, an unexpected
// crash — stops what was started, newest first, then leaves. A stuck step is
// cut off so it can't keep the app (and the sync program) alive.

export interface ShutdownStep {
  name: string
  run: () => Promise<void> | void
  timeoutMs: number
}

export interface Shutdown {
  /** Registers something to stop on exit. Steps run in reverse order of registration. */
  add(step: ShutdownStep): void
  /** Runs every step once, then `beforeExit` (e.g. an error dialog), then exits. Later calls return the same run. */
  run(code: number, beforeExit?: () => void): Promise<void>
  readonly started: boolean
  /** True once every step has run, just before `exit` is called. */
  readonly finished: boolean
}

export function createShutdown(exit: (code: number) => void, log: (msg: string) => void): Shutdown {
  const steps: ShutdownStep[] = []
  let running: Promise<void> | null = null
  let finished = false

  async function stop(step: ShutdownStep): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), step.timeoutMs)))
    try {
      const result = await Promise.race([Promise.resolve().then(step.run), timeout])
      if (result === 'timeout') log(`Shutdown: gave up waiting for ${step.name} after ${step.timeoutMs} ms`)
    } catch (err) {
      log(`Shutdown: ${step.name} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    add: (step) => void steps.push(step),
    run(code, beforeExit) {
      running ??= (async () => {
        log(`Shutting down${code ? ` after an error (code ${code})` : ''}`)
        for (const step of [...steps].reverse()) await stop(step)
        finished = true
        try {
          beforeExit?.()
        } catch (err) {
          log(`Shutdown: ${err instanceof Error ? err.message : String(err)}`)
        }
        exit(code)
      })()
      return running
    },
    get started() {
      return running !== null
    },
    get finished() {
      return finished
    },
  }
}
