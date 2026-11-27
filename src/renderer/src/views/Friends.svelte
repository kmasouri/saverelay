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
      act(async () => undefined, `${name} added. They’ll get a friend request next time you’re both online.`)
      code = ''
    }
  }

  async function remove(id: string, name: string): Promise<void> {
    if (confirm(`Unfriend ${name}?\n\nYou stop sharing every save with them, and they can’t send you a new request unless you add them again. Saves they already have stay on their PC.`)) {
      await act(() => call('removePeer', id), `${name} unfriended`)
    }
  }
</script>

<header class="stack tight">
  <h1>Friends</h1>
  <p class="muted">Paste a friend’s invite code to add them. They get a request to accept. Saves only go to friends, and only the saves you share with them.</p>
</header>

<section class="card stack">
  <h2>Your name</h2>
  <div class="row">
    <input class="grow" bind:value={name} maxlength="64" aria-label="Your name" />
    <button disabled={!name.trim() || name.trim() === ui.device.name} onclick={() => act(() => call('setDeviceName', name), 'Name saved')}>Save</button>
  </div>
  <p class="faint small">Your friends see this name. If you change it, they’ll see the new one when you play next.</p>
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

{#if ui.friendRequests.length}
  <section class="stack">
    <h2>Friend requests</h2>
    {#each ui.friendRequests as r (r.syncthingId)}
      <div class="card alert row spread">
        <span><strong>{r.name}</strong> wants to be friends</span>
        <div class="row">
          <button class="primary" onclick={() => act(() => call<string>('acceptFriendRequest', r.syncthingId), `${r.name} is now your friend`)}>Accept</button>
          <button class="ghost" onclick={() => act(() => call('ignoreFriendRequest', r.syncthingId))}>Ignore</button>
        </div>
      </div>
    {/each}
  </section>
{/if}

{#if ui.pendingDevices.length}
  <section class="card alert stack">
    <h2>Someone is trying to connect</h2>
    <p class="muted small">They’re on an older version of SaveRelay, so this can’t be a request yet. If you recognize them, ask for their invite code and paste it above. Otherwise ignore this.</p>
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
        {#if !p.connected}<span class="faint small">{p.lastSeenAt ? `last online ${when(p.lastSeenAt)}` : 'not connected yet'}</span>{/if}
      </div>
      <button class="ghost danger" onclick={() => remove(p.deviceId, p.name)}>Unfriend</button>
    </div>
  {/each}
</section>

<style>
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  textarea { word-break: break-all; }
  @media (max-width: 1000px) { .two { grid-template-columns: 1fr; } }
</style>
