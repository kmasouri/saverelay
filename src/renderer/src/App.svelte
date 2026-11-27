<script lang="ts">
  import { onMount } from 'svelte'
  import { call, type AppState } from './lib/api'
  import Icon from './lib/Icon.svelte'
  import Logo from './lib/Logo.svelte'
  import Overview from './views/Overview.svelte'
  import WorldDetail from './views/WorldDetail.svelte'
  import AddWorld from './views/AddWorld.svelte'
  import Friends from './views/Friends.svelte'
  import Settings from './views/Settings.svelte'

  type Route = { kind: 'overview' } | { kind: 'world'; id: string } | { kind: 'add'; folderId?: string } | { kind: 'friends' } | { kind: 'settings' }

  let ui = $state<AppState | null>(null)
  let route = $state<Route>({ kind: 'overview' })
  let screenName = $state('')
  let crashSeen = $state(false)
  let toast = $state<{ text: string; tone: 'ok' | 'bad' } | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  function notify(text: string, tone: 'ok' | 'bad' = 'ok'): void {
    toast = { text, tone }
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast = null), tone === 'bad' ? 7000 : 3500)
  }

  /** Runs a user action, surfacing failures instead of swallowing them. */
  async function act<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    try {
      const result = await fn()
      if (success) notify(success)
      return result
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'bad')
      return undefined
    }
  }

  function go(r: Route): void {
    route = r
  }

  onMount(() => {
    void call<AppState>('getState').then((s) => (ui = s))
    return window.sr.onState((s) => (ui = s))
  })

  const selectedWorldId = $derived(route.kind === 'world' ? route.id : null)
  const currentWorld = $derived(selectedWorldId && ui ? ui.worlds.find((w) => w.id === selectedWorldId) : undefined)
  const attention = $derived(ui ? ui.invitations.length + ui.pendingDevices.length + ui.friendRequests.length : 0)
</script>

<div class="frame">
  <!-- Our own title bar: draggable, with Windows drawing the window buttons over its right end. -->
  <header class="titlebar">
    <Logo size={18} />
    <span class="title">SaveRelay</span>
    {#if ui?.device.nameChosen}<span class="faint small ellipsis">{ui.device.name}</span>{/if}
  </header>
  <div class="body">
    {#if !ui}
      <div class="loading"><Logo size={42} spin /></div>
    {:else if !ui.device.nameChosen}
      <form class="welcome card stack" onsubmit={(e) => { e.preventDefault(); void act(() => call('setDeviceName', screenName)) }}>
        <Logo size={42} />
        <h1>What should your friends call you?</h1>
        <p class="muted">They see this name next to your saves. You can change it later on the Friends page.</p>
        <input bind:value={screenName} maxlength="64" placeholder="Your name" aria-label="Your name" />
        <button class="primary" type="submit" disabled={!screenName.trim()}>Continue</button>
      </form>
    {:else}
      <div class="shell">
        <aside>
          <nav>
            <button class="nav" class:active={['overview', 'world', 'add'].includes(route.kind)} onclick={() => go({ kind: 'overview' })}>
              <Icon name="games" />
              Saves
              {#if ui.invitations.length}<span class="count">{ui.invitations.length}</span>{/if}
            </button>
            <button class="nav" class:active={route.kind === 'friends'} onclick={() => go({ kind: 'friends' })}>
              <Icon name="group" />
              Friends
              {#if ui.friendRequests.length + ui.pendingDevices.length}<span class="count">{ui.friendRequests.length + ui.pendingDevices.length}</span>{/if}
            </button>
            <button class="nav" class:active={route.kind === 'settings'} onclick={() => go({ kind: 'settings' })}>
              <Icon name="settings" />
              Settings
              {#if ui.update.status === 'ready'}<span class="count">1</span>{/if}
            </button>
          </nav>

          <div class="foot">
            {#if ui.update.status === 'ready'}
              <button class="primary" onclick={() => act(() => call('installUpdate'))}>Restart to update</button>
            {/if}
            <div class="row small">
              <span class="dot" class:on={ui.transport.ok}></span>
              <span class="muted">{ui.transport.ok ? `${ui.peers.filter((p) => p.connected).length}/${ui.peers.length} friends online` : 'Sync offline'}</span>
            </div>
            <div class="faint small">v{ui.app.version}</div>
          </div>
        </aside>

        <main>
          {#if ui.app.crashedLastTime && !crashSeen}
            <div class="card alert banner row spread">
              <span>SaveRelay closed unexpectedly last time.</span>
              <div class="row">
                <button onclick={() => act(() => call('showLog'))}>Show crash log</button>
                <button class="ghost" onclick={() => (crashSeen = true)}>Dismiss</button>
              </div>
            </div>
          {/if}
          {#if !ui.transport.ok}
            <div class="card danger banner">
              <strong>Sync transport problem.</strong>
              <span class="muted">{ui.transport.error}</span>
            </div>
          {/if}

          {#if route.kind === 'overview'}
            <Overview {ui} {act} {go} {attention} />
          {:else if route.kind === 'world'}
            {#if currentWorld}
              {#key currentWorld.id}
                <WorldDetail world={currentWorld} {ui} {act} {go} />
              {/key}
            {:else}
              <p class="muted">This save is no longer shared.</p>
            {/if}
          {:else if route.kind === 'add'}
            {#key route.folderId}
              <AddWorld {ui} {act} {go} folderId={route.folderId} />
            {/key}
          {:else if route.kind === 'friends'}
            <Friends {ui} {act} />
          {:else if route.kind === 'settings'}
            <Settings {ui} {act} />
          {/if}
        </main>
      </div>
    {/if}
  </div>
</div>

{#if toast}
  <div class="toast {toast.tone}" role="status">{toast.text}</div>
{/if}

<style>
  .frame { display: flex; flex-direction: column; height: 100%; }
  .titlebar { height: 37px; flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 0 150px 0 14px; background: #130f15; border-bottom: 1px solid var(--line); -webkit-app-region: drag; user-select: none; }
  .title { font-weight: 600; font-size: 13px; }
  .body { flex: 1; min-height: 0; }
  .shell { display: grid; grid-template-columns: 260px 1fr; height: 100%; }
  aside { background: #130f15; border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 16px 10px; gap: 18px; min-height: 0; }
  nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; flex: 1; }
  .nav { display: flex; align-items: center; gap: 10px; text-align: left; background: transparent; border: none; padding: 9px 10px; border-radius: 8px; font-weight: 500; }
  .nav:hover:not(:disabled) { background: var(--panel); }
  .nav.active { background: var(--panel-2); }
  .nav :global(.icon) { color: var(--muted); }
  .nav.active :global(.icon) { color: var(--ember); }
  .count { margin-left: auto; background: var(--ember); color: #1b0f08; border-radius: 999px; font-size: 11px; padding: 0 7px; font-weight: 700; }
  .foot { display: flex; flex-direction: column; gap: 8px; padding: 0 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
  .dot.on { background: var(--ok); }
  main { overflow-y: auto; padding: 28px 32px 48px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .banner { display: flex; gap: 8px; flex-wrap: wrap; }
  .welcome { width: min(440px, 90vw); margin: 15vh auto 0; padding: 28px; align-items: flex-start; }
  .welcome input { width: 100%; }
  .loading { height: 100%; display: grid; place-items: center; }
  .toast { position: fixed; bottom: 20px; right: 20px; max-width: 420px; padding: 12px 16px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); box-shadow: 0 10px 30px #0008; }
  .toast.ok { border-color: color-mix(in srgb, var(--ok) 60%, var(--line)); }
  .toast.bad { border-color: var(--bad); }
</style>
