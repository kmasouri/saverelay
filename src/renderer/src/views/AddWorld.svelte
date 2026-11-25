<script lang="ts">
  import { onMount } from 'svelte'
  import { call, splitList, type AppState, type Discovered, type World, type WorldInput } from '../lib/api'

  type Act = <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>
  type Go = (r: { kind: 'world'; id: string } | { kind: 'overview' } | { kind: 'friends' }) => void
  let { ui, act, go, folderId }: { ui: AppState; act: Act; go: Go; folderId?: string } = $props()

  const invitation = $derived(folderId ? ui.invitations.find((i) => i.folderId === folderId) : undefined)
  const joining = $derived(!!folderId)

  let discovered = $state<Discovered[]>([])
  let scanning = $state(true)
  let path = $state('')
  let warnings = $state<string[]>([])
  let name = $state('')
  let gameId = $state('custom')
  let processes = $state('')
  let include = $state('**/*')
  let exclude = $state('')
  let sharedWith = $state<string[]>([])
  let mode = $state<'receive' | 'contribute'>('receive')
  let confirmed = $state(false)
  let busy = $state(false)

  onMount(async () => {
    if (invitation) name = invitation.label
    discovered = (await act(() => call<Discovered[]>('discover'))) ?? []
    scanning = false
  })

  function applyGame(id: string): void {
    gameId = id
    const g = ui.games.find((x) => x.id === id)
    if (g) {
      processes = g.processNames.join(', ')
      include = g.include.join(', ')
      exclude = g.exclude.join(', ')
    }
  }

  async function choose(p: string, preset?: Discovered): Promise<void> {
    path = p
    confirmed = false
    if (preset) {
      applyGame(preset.gameId)
      if (!joining) name = preset.name
    }
    warnings = (await act(() => call<string[]>('folderWarnings', p))) ?? []
  }

  async function browse(): Promise<void> {
    const p = await act(() => call<string | null>('pickFolder'))
    if (p) await choose(p)
  }

  async function submit(): Promise<void> {
    busy = true
    const input: WorldInput = {
      name,
      gameId,
      localPath: path,
      processNames: splitList(processes),
      include: splitList(include),
      exclude: splitList(exclude),
      sharedWith: $state.snapshot(sharedWith),
      mode,
    }
    const w = joining
      ? await act(() => call<World>('joinWorld', folderId, input), `Joined ${name}`)
      : await act(() => call<World>('addWorld', input), `Now sharing ${name}`)
    busy = false
    if (w) go({ kind: 'world', id: w.id })
  }

  const game = $derived(ui.games.find((g) => g.id === gameId))
  const valid = $derived(!!path && !!name.trim() && confirmed)
</script>

<header class="stack tight">
  <h1>{joining ? `Join “${invitation?.label ?? 'shared world'}”` : 'Share a world'}</h1>
  <p class="muted">
    {#if joining}
      Shared by {invitation?.offeredBy.join(', ')}. Choose where this world's saves live on <em>this</em> PC; your folder can differ from your friends'.
    {:else}
      Pick one world's save folder. Only that folder is shared, and only with the friends you tick below.
    {/if}
  </p>
</header>

{#if joining && !invitation}
  <div class="card danger">This invitation is no longer pending.</div>
{:else}
  <section class="card stack">
    <h2>1. Save folder</h2>
    {#if scanning}
      <p class="muted small">Looking for known games…</p>
    {:else if discovered.length}
      <div class="stack tight">
        <span class="muted small">Detected worlds</span>
        {#each discovered as d (d.path)}
          <button class="pick" class:selected={path === d.path} disabled={d.added} onclick={() => choose(d.path, d)}>
            <span class="badge plain ember">{d.gameName}</span>
            <strong>{d.name}</strong>
            <span class="mono faint ellipsis grow">{d.path}</span>
            {#if d.added}<span class="faint small">already shared</span>{/if}
          </button>
        {/each}
      </div>
    {:else}
      <p class="muted small">No known game worlds were detected on this PC. Browse to the folder instead.</p>
    {/if}
    <div class="row">
      <button onclick={browse}>Browse for a folder…</button>
      {#if path}<span class="mono ellipsis grow">{path}</span>{/if}
    </div>
    {#each warnings as w}
      <div class="card alert small">{w}</div>
    {/each}
  </section>

  {#if path}
    <section class="card stack">
      <h2>2. Details</h2>
      <div class="cols">
        <label class="field"><span>World name</span><input bind:value={name} maxlength="80" /></label>
        <label class="field">
          <span>Game</span>
          <select value={gameId} onchange={(e) => applyGame(e.currentTarget.value)}>
            {#each ui.games as g}<option value={g.id}>{g.name}</option>{/each}
            <option value="custom">Other / custom</option>
          </select>
        </label>
        <label class="field">
          <span>Game process names (comma separated)</span>
          <input bind:value={processes} placeholder="Game.exe" />
        </label>
        <label class="field">
          <span>Files to include</span>
          <input bind:value={include} placeholder="**/*" />
        </label>
        <label class="field">
          <span>Files to exclude</span>
          <input bind:value={exclude} placeholder="settings.ini" />
        </label>
      </div>
      {#if game}<p class="faint small">{game.notes}</p>{/if}
      {#if !processes.trim()}
        <p class="small" style="color: var(--warn)">Without a process name, Calm Ember can't tell when the game is running, and may apply updates while you play.</p>
      {/if}

      {#if joining}
        <div class="stack tight">
          <span class="muted small">If this folder already has saves</span>
          <label class="check"><input type="radio" bind:group={mode} value="receive" /> Back them up and use the shared world (recommended)</label>
          <label class="check"><input type="radio" bind:group={mode} value="contribute" /> Share them too, as a competing version</label>
        </div>
      {/if}

      <div class="stack tight">
        <span class="muted small">{joining ? 'Also share with' : 'Share with'}</span>
        {#if ui.peers.length === 0}
          <p class="small muted">No friends yet. <button class="link" onclick={() => go({ kind: 'friends' })}>Add friends</button> first, or share now and add them later.</p>
        {/if}
        {#each ui.peers as p (p.deviceId)}
          <label class="check"><input type="checkbox" bind:group={sharedWith} value={p.deviceId} /> {p.name}</label>
        {/each}
      </div>
    </section>

    <section class="card stack">
      <h2>3. Confirm</h2>
      <label class="check">
        <input type="checkbox" bind:checked={confirmed} />
        <span>Share the save files in <span class="mono">{path}</span>{exclude.trim() ? `, excluding ${exclude}` : ''}.</span>
      </label>
      <p class="faint small">Your existing saves are never moved or deleted. Before any update replaces them, they're backed up.</p>
      <div class="row">
        <button class="primary" disabled={!valid || busy} onclick={submit}>{joining ? 'Join world' : 'Start sharing'}</button>
        <button class="ghost" onclick={() => go({ kind: 'overview' })}>Cancel</button>
      </div>
    </section>
  {/if}
{/if}

<style>
  .pick { display: flex; gap: 10px; align-items: center; text-align: left; }
  .pick.selected { border-color: var(--ember); background: color-mix(in srgb, var(--ember) 8%, var(--panel-2)); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
</style>
