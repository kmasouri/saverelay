<script lang="ts">
  import { call, exact, POLICY_LABEL, splitList, when, type AppState, type Graph, type GraphNode, type Policy, type World } from '../lib/api'
  import HistoryGraph from '../lib/HistoryGraph.svelte'
  import StatusBadge from '../lib/StatusBadge.svelte'

  type Act = <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>
  type Go = (r: { kind: 'overview' }) => void
  let { world, ui, act, go }: { world: World; ui: AppState; act: Act; go: Go } = $props()

  let graph = $state<Graph | null>(null)
  let showAll = $state(false)
  let editing = $state(false)
  let processes = $state('')
  let include = $state('')
  let exclude = $state('')

  // Refresh history whenever the world's shared state moves.
  $effect(() => {
    void [world.acceptedContentId, world.liveContentId, world.status]
    void act(() => call<{ graph: Graph }>('history', world.id)).then((h) => {
      if (h) graph = h.graph
    })
  })

  const gameName = $derived(ui.games.find((g) => g.id === world.gameId)?.name ?? 'Other game')
  const online = (id: string): boolean => !!ui.peers.find((p) => p.deviceId === id)?.connected

  async function setPolicy(policy: Policy, preferred?: string): Promise<void> {
    if (policy === 'preferred-device' && !preferred) preferred = world.policy.preferredDeviceId ?? ui.device.deviceId
    await act(() => call('setPolicy', world.id, policy, preferred), 'Rule updated for everyone')
  }

  async function restore(n: GraphNode): Promise<void> {
    const ok = confirm(`Bring back the save from ${exact(n.savedAt)}?\n\nIt becomes the latest save for everyone. Nothing is deleted: the current save stays in history.`)
    if (ok) await act(() => call('restore', world.id, n.contentId), 'Done. Friends get it once their game is closed.')
  }

  async function toggleShare(deviceId: string, on: boolean): Promise<void> {
    const sharedWith = on ? [...world.sharedWith, deviceId] : world.sharedWith.filter((id) => id !== deviceId)
    await act(() => call('updateWorld', world.id, { sharedWith }), on ? 'Sharing enabled' : 'Sharing stopped for that friend')
  }

  function startEdit(): void {
    processes = world.processNames.join(', ')
    include = world.include.join(', ')
    exclude = world.exclude.join(', ')
    editing = true
  }

  async function saveEdit(): Promise<void> {
    const r = await act(() => call('updateWorld', world.id, { processNames: splitList(processes), include: splitList(include), exclude: splitList(exclude) }), 'Saved')
    if (r !== undefined) editing = false
  }

  async function stopSharing(): Promise<void> {
    const ok = confirm(`Stop sharing “${world.name}” from this PC?\n\nYour save files and history stay on this PC. Friends keep what they already received.`)
    if (ok && (await act(() => call('removeWorld', world.id), 'Stopped sharing')) !== undefined) go({ kind: 'overview' })
  }
</script>

<button class="link back" onclick={() => go({ kind: 'overview' })}>‹ Saves</button>

<header class="row spread">
  <div class="stack tight grow">
    <div class="row">
      <h1 class="ellipsis">{world.name}</h1>
      <StatusBadge status={world.status} />
    </div>
    <p class="muted">{world.detail || `${gameName} · shared with ${world.sharedWith.length} friend${world.sharedWith.length === 1 ? '' : 's'}`}</p>
  </div>
  <button onclick={() => act(() => call('openPath', world.localPath))}>Open folder</button>
</header>

{#each world.warnings as w}
  <div class="card alert small">{w}</div>
{/each}

{#if world.conflict}
  <section class="card alert stack">
    <div class="stack tight">
      <h2>People played separately. Pick which save everyone continues from.</h2>
      <p class="muted">Nothing is deleted. The others stay in history and can be brought back later.</p>
    </div>
    <div class="cands">
      {#each world.conflict as c (c.contentId)}
        <div class="card inset stack tight">
          <strong>{c.deviceNames.join(' + ')}</strong>
          <span class="small muted">Saved {when(c.modifiedAt)}</span>
          <button class="primary" onclick={() => act(() => call('chooseCandidate', world.id, c.contentId), 'Choice shared with everyone')}>Continue from this one</button>
        </div>
      {/each}
    </div>
  </section>
{/if}

<section class="card stack">
  <div class="row spread">
    <h2>History</h2>
    <span class="faint small">Newest at the top</span>
  </div>
  {#if !graph}
    <p class="muted small">Loading…</p>
  {:else if graph.nodes.length === 0}
    <p class="muted small">No versions yet. The first one appears after the game saves and closes.</p>
  {:else}
    <HistoryGraph {graph} me={ui.device.deviceId} {online} limit={showAll ? graph.nodes.length : 10} onrestore={restore} />
    {#if graph.nodes.length > 10}
      <button class="ghost more" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show older (${graph.nodes.length - 10})`}</button>
    {/if}
  {/if}
</section>

<section class="two">
  <div class="card stack">
    <h2>When people play separately</h2>
    <select value={world.policy.policy} onchange={(e) => setPolicy(e.currentTarget.value as Policy)}>
      {#each Object.entries(POLICY_LABEL) as [value, label]}<option {value}>{label}</option>{/each}
    </select>
    {#if world.policy.policy === 'preferred-device'}
      <select aria-label="Whose save wins" value={world.policy.preferredDeviceId} onchange={(e) => setPolicy('preferred-device', e.currentTarget.value)}>
        <option value={ui.device.deviceId}>You</option>
        {#each ui.peers as p}<option value={p.deviceId}>{p.name}</option>{/each}
      </select>
    {/if}
    <p class="faint small">{world.policy.setBy ? `Applies to everyone. Set by ${world.policy.setBy}.` : 'Applies to everyone.'}</p>
  </div>

  <div class="card stack">
    <h2>Shared with</h2>
    {#if ui.peers.length === 0}
      <p class="muted small">Add friends on the Friends page to share this save.</p>
    {/if}
    {#each ui.peers as p (p.deviceId)}
      <label class="check">
        <input type="checkbox" checked={world.sharedWith.includes(p.deviceId)} onchange={(e) => toggleShare(p.deviceId, e.currentTarget.checked)} />
        <span class="grow">{p.name}</span>
        <span class="small muted row presence"><i class="dot" class:on={p.connected}></i>{p.connected ? 'online' : p.lastSeenAt ? `last online ${when(p.lastSeenAt)}` : 'offline'}</span>
      </label>
    {/each}
  </div>
</section>

<section class="card stack">
  <div class="row spread">
    <h2>Save folder</h2>
    {#if !editing}<button class="ghost" onclick={startEdit}>Edit</button>{/if}
  </div>
  <span class="mono">{world.localPath}</span>
  {#if editing}
    <label class="field"><span>Game process names</span><input bind:value={processes} /></label>
    <label class="field"><span>Include</span><input bind:value={include} /></label>
    <label class="field"><span>Exclude</span><input bind:value={exclude} /></label>
    <div class="row"><button class="primary" onclick={saveEdit}>Save</button><button class="ghost" onclick={() => (editing = false)}>Cancel</button></div>
  {:else}
    <div class="small muted">{world.processNames.length ? `Watches ${world.processNames.join(', ')} so it never touches saves while you play` : 'No game program set, so SaveRelay can’t tell when you’re playing'}</div>
  {/if}
</section>

<section class="row spread">
  <p class="small muted">Stop sharing keeps your save files and history on this PC.</p>
  <button class="danger" onclick={stopSharing}>Stop sharing</button>
</section>

<style>
  .back { align-self: flex-start; color: var(--muted); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .cands { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .more { align-self: flex-start; }
  .presence { gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
  .dot.on { background: var(--ok); }
  @media (max-width: 1000px) { .two { grid-template-columns: 1fr; } }
</style>
