<script lang="ts">
  import { call, when, type AppState } from '../lib/api'

  type Act = <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>
  let { ui, act }: { ui: AppState; act: Act } = $props()

  async function exportDiagnostics(): Promise<void> {
    const file = await act(() => call<string | null>('exportDiagnostics'))
    if (file) act(async () => undefined, `Saved to ${file}`)
  }

  const u = $derived(ui.update)
</script>

<header class="stack tight">
  <h1>Settings</h1>
</header>

<section class="card stack">
  <h2>This PC</h2>
  <label class="check">
    <input type="checkbox" checked={ui.device.startAtLogin} onchange={(e) => act(() => call('setStartAtLogin', e.currentTarget.checked))} />
    Start SaveRelay in the tray when I sign in (recommended, so saves sync without you opening it)
  </label>
</section>

<section class="card stack">
  <h2>Updates</h2>
  <div class="row spread">
    <div class="stack tight">
      <span>SaveRelay {ui.app.version}</span>
      <span class="small muted">
        {#if u.status === 'disabled'}Updates are off in development builds.
        {:else if u.status === 'checking'}Checking for updates…
        {:else if u.status === 'downloading'}Downloading {u.version} in the background… {u.progress ?? 0}%
        {:else if u.status === 'ready'}Version {u.version} is ready. It installs when SaveRelay restarts.
        {:else if u.status === 'up-to-date'}You're up to date (checked {when(u.checkedAt ?? 0)}).
        {:else if u.status === 'error'}Update check failed: {u.error}
        {:else}Updates download automatically in the background.{/if}
      </span>
    </div>
    {#if u.status === 'ready'}
      <button class="primary" onclick={() => act(() => call('installUpdate'))}>Restart now</button>
    {:else}
      <button disabled={u.status === 'disabled' || u.status === 'checking' || u.status === 'downloading'} onclick={() => act(() => call('checkForUpdates'))}>Check now</button>
    {/if}
  </div>
</section>

<section class="card stack">
  <h2>Troubleshooting</h2>
  <div class="row wrap">
    <button onclick={exportDiagnostics}>Export diagnostics…</button>
    <button onclick={() => act(() => call('showLog'))}>Show log</button>
  </div>
  <p class="faint small">Diagnostics include your config and sync state, but never your private key.</p>
  <div class="small faint mono">Device {ui.device.deviceId}<br />Transport {ui.device.syncthingId || 'not running'}</div>
</section>
