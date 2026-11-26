<script lang="ts">
  import { bytes, call, exact, POLICY_LABEL, shortId, splitList, totalSize, when, type AppState, type HistoryGroup, type Policy, type World } from '../lib/api'
  import StatusBadge from '../lib/StatusBadge.svelte'

  type Act = <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>
  type Go = (r: { kind: 'overview' }) => void
  let { world, ui, act, go }: { world: World; ui: AppState; act: Act; go: Go } = $props()

  let history = $state<HistoryGroup[]>([])
  let loaded = $state(false)
  let showAll = $state(false)
  let editing = $state(false)
  let processes = $state('')
  let include = $state('')
  let exclude = $state('')

  // Refresh history whenever the world's shared state moves.
  $effect(() => {
    void [world.acceptedContentId, world.liveContentId, world.status]
    void act(() => call<{ groups: HistoryGroup[] }>('history', world.id)).then((h) => {
      if (h) history = h.groups
      loaded = true
    })
  })

  const peerName = (id: string): string => (id === ui.device.deviceId ? `${ui.device.name} (this PC)` : (ui.peers.find((p) => p.deviceId === id)?.name ?? 'Unknown device'))
  const visible = $derived(showAll ? history : history.slice(0, 8))

  async function setPolicy(policy: Policy, preferred?: string): Promise<void> {
    if (policy === 'preferred-device' && !preferred) preferred = world.policy.preferredDeviceId ?? ui.device.deviceId
    await act(() => call('setPolicy', world.id, policy, preferred), 'Policy updated for the whole group')
  }

  async function restore(g: HistoryGroup): Promise<void> {
    const ok = confirm(`Restore the version from ${exact(g.modifiedAt)}?\n\nIt becomes the shared world for everyone. Current saves are backed up first and stay in history.`)
    if (ok) await act(() => call('restore', world.id, g.contentId), 'Restore recorded. It applies once the game is closed.')
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
    const ok = confirm(`Stop sharing “${world.name}” from this PC?\n\nYour save files, backups and history stay on disk. Friends keep what they already received.`)
    if (ok && (await act(() => call('removeWorld', world.id), 'Stopped sharing')) !== undefined) go({ kind: 'overview' })
  }

  const reasonLabel = { local: 'played', import: 'initial upload', restore: 'restored' }
</script>

<header class="row spread">
  <div class="stack tight grow">
    <div class="row">
      <h1 class="ellipsis">{world.name}</h1>
      <StatusBadge status={world.status} />
    </div>
    <p class="muted">{world.detail || (world.status === 'up-to-date' ? 'Everyone online has the same world.' : '')}</p>
  </div>
  <div class="row">
    <button onclick={() => act(() => call('openPath', world.localPath))}>Open folder</button>
    <button onclick={() => act(() => call<string>('backupNow', world.id), 'Backup created')}>Back up now</button>
  </div>
</header>

{#each world.warnings as w}
  <div class="card alert small">{w}</div>
{/each}

{#if world.conflict}
  <section class="card alert stack">
    <div class="stack tight">
      <h2>Friends continued this world separately</h2>
      <p class="muted">Pick the continuation everyone should keep playing. Nothing is merged and nothing is deleted: the other version stays in history and can be restored later.</p>
    </div>
    <div class="cands">
      {#each world.conflict as c (c.contentId)}
        <div class="card inset stack tight">
          <strong>{c.deviceNames.join(' + ')}</strong>
          <span class="small muted">Saved in game {exact(c.modifiedAt)}</span>
          <span class="small faint">{c.files.length} file(s), {bytes(totalSize(c.files))} · version {shortId(c.contentId)}</span>
          <button class="primary" onclick={() => act(() => call('chooseCandidate', world.id, c.contentId), 'Choice shared with the group')}>Keep this one</button>
        </div>
      {/each}
    </div>
    <p class="faint small">Different file contents don't always mean different progress: multiplayer saves can differ in player-specific details. SaveRelay can't tell yet, so it asks.</p>
  </section>
{/if}

<section class="two">
  <div class="card stack">
    <h2>When friends' versions compete</h2>
    <select value={world.policy.policy} onchange={(e) => setPolicy(e.currentTarget.value as Policy)}>
      {#each Object.entries(POLICY_LABEL) as [value, label]}<option {value}>{label}</option>{/each}
    </select>
    {#if world.policy.policy === 'preferred-device'}
      <label class="field">
        <span>Preferred device</span>
        <select value={world.policy.preferredDeviceId} onchange={(e) => setPolicy('preferred-device', e.currentTarget.value)}>
          <option value={ui.device.deviceId}>{ui.device.name} (this PC)</option>
          {#each ui.peers as p}<option value={p.deviceId}>{p.name}</option>{/each}
        </select>
      </label>
    {/if}
    <p class="faint small">
      {#if world.policy.policy === 'latest-modified'}
        The save with the newest in-game save time wins. A re-saved old world or a wrong PC clock can win too. The other version is always kept in history.
      {:else if world.policy.policy === 'ask'}
        Both versions are kept and you pick one. Ordinary hand-offs never ask.
      {:else}
        The preferred device's version wins genuine conflicts; otherwise you're asked.
      {/if}
      {#if world.policy.setBy}Set by {world.policy.setBy} {when(world.policy.setAt ?? 0)}. Applies to everyone.{/if}
    </p>
    {#if world.autoNote}<p class="small muted">Last automatic choice: {world.autoNote}</p>{/if}
  </div>

  <div class="card stack">
    <h2>Shared with</h2>
    {#if ui.peers.length === 0}
      <p class="muted small">Add friends on the Friends page to share this world.</p>
    {/if}
    {#each ui.peers as p (p.deviceId)}
      <label class="check">
        <input type="checkbox" checked={world.sharedWith.includes(p.deviceId)} onchange={(e) => toggleShare(p.deviceId, e.currentTarget.checked)} />
        <span class="grow">{p.name}</span>
        <span class="badge {p.connected ? 'ok' : ''}">{p.connected ? 'online' : 'offline'}</span>
      </label>
    {/each}
    <p class="faint small">Unticking stops future updates. Friends keep files they already have.</p>
  </div>
</section>

<section class="stack">
  <div class="row spread">
    <h2>History</h2>
    <span class="faint small">Versions are grouped by identical file contents.</span>
  </div>
  {#if !loaded}
    <p class="muted small">Loading…</p>
  {:else if history.length === 0}
    <div class="card muted">No versions yet. The first one appears after the game saves and closes.</div>
  {/if}
  {#each visible as g (g.contentId)}
    <article class="card version" class:current={g.accepted}>
      <div class="row spread">
        <div class="row wrap">
          <strong>Saved {exact(g.modifiedAt)}</strong>
          {#if g.accepted}<span class="badge ember">Shared current</span>{/if}
          {#if g.live}<span class="badge ok">On this PC</span>{/if}
        </div>
        <button disabled={g.accepted && g.live} onclick={() => restore(g)}>Restore</button>
      </div>
      <div class="cols small">
        <div class="stack tight">
          <span class="faint">Contributors</span>
          {#each g.contributions as c (c.eventId)}
            <span>{c.deviceName} <span class="faint">· {reasonLabel[c.reason]} {when(c.at)}</span></span>
          {/each}
        </div>
        <div class="stack tight">
          <span class="faint">Available on</span>
          <span>{g.availableOn.map((d) => peerName(d.deviceId)).join(', ')}</span>
        </div>
        <div class="stack tight">
          <span class="faint">Content</span>
          <span>{g.files.length} file(s), {bytes(totalSize(g.files))}</span>
          <span class="mono faint" title={g.contentId}>{shortId(g.contentId)} · exact match</span>
        </div>
      </div>
    </article>
  {/each}
  {#if history.length > 8}
    <button class="ghost" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${history.length} versions`}</button>
  {/if}
</section>

<section class="card stack">
  <div class="row spread">
    <h2>Folder &amp; detection</h2>
    {#if !editing}<button class="ghost" onclick={startEdit}>Edit</button>{/if}
  </div>
  <span class="mono">{world.localPath}</span>
  {#if editing}
    <label class="field"><span>Game process names</span><input bind:value={processes} /></label>
    <label class="field"><span>Include</span><input bind:value={include} /></label>
    <label class="field"><span>Exclude</span><input bind:value={exclude} /></label>
    <div class="row"><button class="primary" onclick={saveEdit}>Save</button><button class="ghost" onclick={() => (editing = false)}>Cancel</button></div>
  {:else}
    <div class="small muted">Detects: {world.processNames.join(', ') || 'nothing (no running-game protection)'}</div>
    <div class="small muted">Includes {world.include.join(', ')}{world.exclude.length ? `, excludes ${world.exclude.join(', ')}` : ''}</div>
  {/if}
</section>

<section class="card danger row spread">
  <div class="stack tight">
    <h3>Stop sharing this world</h3>
    <p class="small muted">Leaves your saves and history in place.</p>
  </div>
  <button class="danger" onclick={stopSharing}>Stop sharing</button>
</section>

<style>
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .cands { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .version { display: flex; flex-direction: column; gap: 12px; }
  .version.current { border-color: color-mix(in srgb, var(--ember) 60%, var(--line)); }
  .cols { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 16px; }
  @media (max-width: 1000px) { .two, .cols { grid-template-columns: 1fr; } }
</style>
