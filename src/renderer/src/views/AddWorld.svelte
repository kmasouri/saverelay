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
  let advanced = $state(false)
  let busy = $state(false)

  onMount(async () => {
    if (invitation) name = invitation.label
    sharedWith = ui.peers.map((p) => p.deviceId)
    discovered = (await act(() => call<Discovered[]>('discover'))) ?? []
    scanning = false
  })

  function applyGame(id: string): void {
    gameId = id
    const g = ui.games.find((x) => x.id === id)
    processes = g ? g.processNames.join(', ') : ''
    include = g ? g.include.join(', ') : '**/*'
    exclude = g ? g.exclude.join(', ') : ''
  }

  async function choose(p: string, preset?: Discovered): Promise<void> {
    path = p
    applyGame(preset?.gameId ?? 'custom')
    if (!joining) name = preset?.name ?? p.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    warnings = (await act(() => call<string[]>('folderWarnings', p))) ?? []
  }

  async function browse(): Promise<void> {
    const p = await act(() => call<string | null>('pickFolder'))
    if (p) await choose(p)
  }

  async function pickExe(): Promise<void> {
    const exe = await act(() => call<string | null>('pickExe'))
    if (exe) processes = exe
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
    const w = joining ? await act(() => call<World>('joinWorld', folderId, input), `Joined ${name}`) : await act(() => call<World>('addWorld', input), `Now sharing ${name}`)
    busy = false
    if (w) go({ kind: 'world', id: w.id })
  }

  const gameName = (id: string): string => ui.games.find((g) => g.id === id)?.name ?? 'Other game'
</script>

<header class="stack tight">
  <h1>{joining ? `Join “${invitation?.label ?? 'shared save'}”` : 'Share a save'}</h1>
  {#if joining && invitation}<p class="muted">From {invitation.offeredBy.join(', ')}. Pick where it goes on this PC.</p>{/if}
</header>

{#if joining && !invitation}
  <div class="card danger">This invitation is no longer pending.</div>
{:else if !path}
  <section class="stack">
    {#if scanning}
      <p class="muted small">Looking for games…</p>
    {:else}
      {#each discovered as d (d.path)}
        <button class="pick" disabled={d.added} title={d.path} onclick={() => choose(d.path, d)}>
          <span class="badge plain ember">{d.gameName}</span>
          <strong class="grow ellipsis">{d.name}</strong>
          <span class="faint small">{d.added ? 'already shared' : 'Select'}</span>
        </button>
      {/each}
    {/if}
    <button class="pick other" onclick={browse}>
      <strong class="grow">Other game…</strong>
      <span class="faint small">Choose its save folder</span>
    </button>
  </section>
{:else}
  <section class="card stack">
    <div class="row">
      <span class="badge plain ember">{gameName(gameId)}</span>
      <input class="grow" bind:value={name} maxlength="80" aria-label="Name" />
    </div>
    <span class="mono faint ellipsis" title={path}>{path}</span>

    {#if !processes.trim()}
      <div class="card alert row spread small">
        <span>Pick the game's .exe so SaveRelay knows when you're playing.</span>
        <button onclick={pickExe}>Choose .exe…</button>
      </div>
    {/if}
    {#each warnings as w}<div class="card alert small">{w}</div>{/each}

    {#if ui.peers.length}
      <div class="row wrap">
        <span class="muted small">Share with</span>
        {#each ui.peers as p (p.deviceId)}
          <label class="check"><input type="checkbox" bind:group={sharedWith} value={p.deviceId} /> {p.name}</label>
        {/each}
      </div>
    {:else}
      <p class="small muted">No friends yet. You can <button class="link" onclick={() => go({ kind: 'friends' })}>add them</button> later.</p>
    {/if}

    {#if joining}<p class="faint small">Saves already in this folder are backed up first.</p>{/if}

    <button class="ghost adv" onclick={() => (advanced = !advanced)}>{advanced ? '▾' : '▸'} Advanced</button>
    {#if advanced}
      <div class="cols">
        <label class="field"><span>Game program(s)</span>
          <div class="row"><input bind:value={processes} placeholder="Game.exe" /><button onclick={pickExe}>…</button></div>
        </label>
        <label class="field"><span>Include files</span><input bind:value={include} placeholder="**/*" /></label>
        <label class="field"><span>Exclude files</span><input bind:value={exclude} /></label>
        {#if joining}
          <label class="field"><span>Existing saves in this folder</span>
            <select bind:value={mode}>
              <option value="receive">Back up and replace with the shared save</option>
              <option value="contribute">Share them too, as a competing version</option>
            </select>
          </label>
        {/if}
      </div>
    {/if}

    <div class="row">
      <button class="primary" disabled={!name.trim() || busy} onclick={submit}>{joining ? 'Join' : 'Share'}</button>
      <button class="ghost" onclick={() => (path = '')}>Back</button>
    </div>
  </section>
{/if}

<style>
  .pick { display: flex; gap: 10px; align-items: center; text-align: left; padding: 12px 14px; }
  .pick:hover:not(:disabled) { border-color: var(--ember); }
  .pick.other { border-style: dashed; }
  .adv { align-self: flex-start; padding-left: 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
</style>
