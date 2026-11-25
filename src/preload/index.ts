import { contextBridge, ipcRenderer } from 'electron'

// The renderer gets exactly two capabilities: call a named, main-validated action,
// and subscribe to state snapshots. No filesystem or network access.
contextBridge.exposeInMainWorld('ce', {
  invoke: async (name: string, ...args: unknown[]) => {
    const res = (await ipcRenderer.invoke('ce:invoke', name, ...args)) as { ok: boolean; result?: unknown; error?: string }
    if (!res.ok) throw new Error(res.error ?? 'Something went wrong')
    return res.result
  },
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown): void => cb(state)
    ipcRenderer.on('ce:state', listener)
    return () => ipcRenderer.removeListener('ce:state', listener)
  },
})
