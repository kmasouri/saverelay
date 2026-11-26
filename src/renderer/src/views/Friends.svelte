<script lang="ts">
  import { call, when, type AppState } from '../lib/api'

  type Act = <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>
  let { ui, act }: { ui: AppState; act: Act } = $props()

  const initialName = (): string => ui.device.name
  let name = $state(initialName())
  let code = $state('')
  let copied = $state(false)

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(ui.device.invite)
    copied = true
    setTimeout(() => (copied = false), 2000)
  }

  async function add(): Promise<void> {
    const name = await act(() => call<string>('addPeer', code))
    if (name) {
      act(async () => undefined, `${name} added. They need your code too.`)
      code = ''
    }
  }

  async function remove(id: string, name: string): Promise<void> {
    if (confirm(`Remove ${name}?\n\nThey stop receiving updates from you. Files they already have can't be recalled.`)) {
      await act(() => call('removePeer', id), `${name} removed`)
    }
  }
</script>

<header class="stack tight">
  <h1>Friends</h1>
  <p class="muted">Friends trust each other by swapping invite codes. Saves only travel between friends who added each other, and only for saves you share with them.</p>
</header>

<section class="card stack">
  <h2>Your name</h2>
  <div class="row">
    <input class="grow" bind:value={name} maxlength="64" aria-label="Your name" />
    <button disabled={!name.trim() || name.trim() === ui.device.name} onclick={() => act(() => call('setDeviceName', name), 'Name saved')}>Save</button>
  </div>
  <p class="faint small">Your friends see this name. If you change it, they’ll see the new one after you next play.</p>
</section>

<section class="two">
  <div class="card stack">
    <h2>Your invite code</h2>
    {#if ui.device.invite}
      <textarea class="mono" readonly rows="4" value={ui.device.invite}></textarea>
      <div class="row">
        <button class="primary" onclick={copy}>{copied ? 'Copied' : 'Copy code'}</button>
        <span class="faint small">Send it to a friend over Discord or similar.</span>
      </div>
    {:else}
      <p class="muted small">Your code appears once the sync transport is running.</p>
    {/if}
  </div>

  <div class="card stack">
    <h2>Add a friend</h2>
    <textarea class="mono" rows="4" placeholder="Paste your friend's code (starts with sr1:)" bind:value={code}></textarea>
    <div class="row">
      <button class="primary" disabled={!code.trim()} onclick={add}>Add friend</button>
    </div>
  </div>
</section>

{#if ui.pendingDevices.length}
  <section class="card alert stack">
    <h2>Someone is trying to connect</h2>
    <p class="muted small">These devices know your PC's address but haven't been added. If you recognize them, ask for their invite code and paste it above. Otherwise ignore this.</p>
    {#each ui.pendingDevices as d (d.deviceId)}
      <div class="small"><strong>{d.name || 'Unnamed device'}</strong> <span class="mono faint">{d.deviceId.slice(0, 15)}… {d.address}</span></div>
    {/each}
  </section>
{/if}

<section class="stack">
  <h2>Your friends</h2>
  {#if ui.peers.length === 0}
    <div class="card muted">No friends yet.</div>
  {/if}
  {#each ui.peers as p (p.deviceId)}
    <div class="card row spread">
      <div class="row">
        <span class="badge {p.connected ? 'ok' : ''}">{p.connected ? 'online' : 'offline'}</span>
        <strong>{p.name}</strong>
        <span class="faint small">added {when(p.addedAt)}</span>
      </div>
      <button class="ghost danger" onclick={() => remove(p.deviceId, p.name)}>Remove</button>
    </div>
  {/each}
</section>

<style>
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  textarea { word-break: break-all; }
  @media (max-width: 1000px) { .two { grid-template-columns: 1fr; } }
</style>
