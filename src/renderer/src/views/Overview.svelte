<script lang="ts">
  import { when, type AppState } from '../lib/api'
  import StatusBadge from '../lib/StatusBadge.svelte'

  type Go = (r: { kind: 'world'; id: string } | { kind: 'add'; folderId?: string } | { kind: 'friends' }) => void
  let { ui, go, attention }: { ui: AppState; go: Go; attention: number } = $props()
</script>

<header class="row spread">
  <div class="stack tight">
    <h1>Shared saves</h1>
    <p class="muted">Play as usual through Steam or Ubisoft Connect. They hand off in the background.</p>
  </div>
  <button class="primary" onclick={() => go({ kind: 'add' })}>Share a save</button>
</header>

{#if ui.invitations.length}
  <section class="stack">
    <h2>Invitations</h2>
    {#each ui.invitations as inv (inv.folderId)}
      <div class="card alert row spread">
        <div class="stack tight">
          <strong>{inv.label}</strong>
          <span class="muted small">Shared with you by {inv.offeredBy.join(', ')}</span>
        </div>
        <button class="primary" onclick={() => go({ kind: 'add', folderId: inv.folderId })}>Join…</button>
      </div>
    {/each}
  </section>
{/if}

{#if ui.worlds.length === 0}
  <div class="card empty">
    <h2>No shared saves yet</h2>
    {#if ui.peers.length === 0}
      <p class="muted">Start by adding your friends, then pick a save folder to share with them.</p>
      <div class="row">
        <button class="primary" onclick={() => go({ kind: 'friends' })}>Add friends</button>
        <button onclick={() => go({ kind: 'add' })}>Share a save</button>
      </div>
    {:else}
      <p class="muted">Pick a save to share, or wait for a friend's invitation to appear here.</p>
    {/if}
  </div>
{:else}
  <section class="grid">
    {#each ui.worlds as w (w.id)}
      <button class="card world" onclick={() => go({ kind: 'world', id: w.id })}>
        <div class="row spread">
          <h2 class="ellipsis">{w.name}</h2>
          <StatusBadge status={w.status} />
        </div>
        {#if w.detail}<p class="muted small">{w.detail}</p>{/if}
        <div class="meta small faint">
          <span>{ui.games.find((g) => g.id === w.gameId)?.name ?? 'Custom game'}</span>
          <span>Shared with {w.sharedWith.length} friend{w.sharedWith.length === 1 ? '' : 's'}</span>
          <span>Last received {when(w.lastAppliedAt)}</span>
          <span>Last published {when(w.lastCaptureAt)}</span>
        </div>
      </button>
    {/each}
  </section>
{/if}

{#if attention === 0 && ui.peers.length > 0 && !ui.peers.some((p) => p.connected)}
  <p class="faint small">None of your friends are online right now. Updates are delivered when you and a friend holding them are online at the same time.</p>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .world { text-align: left; display: flex; flex-direction: column; gap: 10px; padding: 16px; }
  .world:hover { border-color: var(--ember); }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
</style>
