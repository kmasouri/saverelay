<script lang="ts">
  import { bytes, call, downloadLine, uploadingLine, when, type AppState, type Discovered, type World } from '../lib/api'
  import { move, slideY } from '../lib/motion'
  import StatusBadge from '../lib/StatusBadge.svelte'
  import AddWorld from './AddWorld.svelte'

  type Act = <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>
  type Go = (r: { kind: 'world'; id: string } | { kind: 'add'; folderId?: string } | { kind: 'friends' } | { kind: 'overview' }) => void
  let { ui, act, go, attention }: { ui: AppState; act: Act; go: Go; attention: number } = $props()

  /** One row on the page: a save on this PC, shared or not. */
  type Row = { key: string; name: string; lastPlayedAt: number; world?: World; found?: Discovered }
  type Group = { gameId: string; gameName: string; rows: Row[]; shared: number; lastPlayedAt: number }

  let discovered = $state<Discovered[]>([])
  let query = $state('')
  let toggled = $state<Record<string, boolean>>({})
  let sharing = $state<{ path: string; discovered?: Discovered } | null>(null)
  let dialog = $state<HTMLDialogElement>()

  // Rescan whenever the set of shared saves changes, so "Share" buttons stay accurate.
  $effect(() => {
    void ui.worlds.length
    void act(() => call<Discovered[]>('discover')).then((d) => (discovered = d ?? []))
  })

  $effect(() => {
    if (sharing) dialog?.showModal()
    else dialog?.close()
  })

  const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
  const gameName = (id: string): string => ui.games.find((g) => g.id === id)?.name ?? 'Other games'

  const groups = $derived.by(() => {
    const byGame = new Map<string, Group>()
    const add = (gameId: string, row: Row): void => {
      const g = byGame.get(gameId) ?? { gameId, gameName: gameName(gameId), rows: [], shared: 0, lastPlayedAt: 0 }
      g.rows.push(row)
      if (row.world) g.shared++
      g.lastPlayedAt = Math.max(g.lastPlayedAt, row.lastPlayedAt)
      byGame.set(gameId, g)
    }
    for (const w of ui.worlds) {
      const found = discovered.find((d) => samePath(d.path, w.localPath))
      add(w.gameId, { key: w.id, name: w.name, world: w, found, lastPlayedAt: Math.max(found?.lastPlayedAt ?? 0, w.lastCaptureAt) })
    }
    for (const d of discovered) {
      if (!ui.worlds.some((w) => samePath(d.path, w.localPath))) add(d.gameId, { key: d.path, name: d.name, found: d, lastPlayedAt: d.lastPlayedAt })
    }
    const q = query.trim().toLowerCase()
    return [...byGame.values()]
      .map((g) => ({ ...g, rows: g.rows.filter((r) => !q || r.name.toLowerCase().includes(q) || g.gameName.toLowerCase().includes(q)) }))
      .filter((g) => g.rows.length)
      .map((g) => ({ ...g, rows: g.rows.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt) }))
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
  })
  const total = $derived(ui.worlds.length + discovered.filter((d) => !d.added).length)
  // The most recently played game starts open, the rest closed; searching opens everything.
  const isOpen = (g: Group, i: number): boolean => !!query.trim() || (toggled[g.gameId] ?? i === 0)

  async function other(): Promise<void> {
    const path = await act(() => call<string | null>('pickFolder'))
    if (path) sharing = { path }
  }
</script>

<header class="stack tight">
  <h1>Saves</h1>
  <p class="muted">Play as usual through Steam or Ubisoft Connect. Shared saves hand off in the background.</p>
</header>

{#if ui.invitations.length}
  <section class="stack" transition:slideY>
    {#each ui.invitations as inv (inv.folderId)}
      <div class="card alert row spread" transition:slideY>
        <div class="stack tight">
          <strong>{inv.label}</strong>
          <span class="muted small">Shared with you by {inv.offeredBy.join(', ')}</span>
        </div>
        <button class="primary" onclick={() => go({ kind: 'add', folderId: inv.folderId })}>Join…</button>
      </div>
    {/each}
  </section>
{/if}

{#if ui.peers.length === 0}
  <div class="card inset row spread small">
    <span class="muted">Add your friends first, so you have someone to share with.</span>
    <button onclick={() => go({ kind: 'friends' })}>Add friends</button>
  </div>
{/if}

{#if total > 5}
  <input type="search" bind:value={query} placeholder="Search games and saves" aria-label="Search games and saves" />
{/if}

{#each groups as g, i (g.gameId)}
  {@const open = isOpen(g, i)}
  <section class="group" animate:move>
    <button class="group-head" aria-expanded={open} onclick={() => (toggled[g.gameId] = !open)}>
      <span class="chev" class:open aria-hidden="true">›</span>
      <strong class="grow">{g.gameName}</strong>
      <span class="faint small">{g.rows.length} {g.rows.length === 1 ? 'save' : 'saves'}{g.shared ? ` · ${g.shared} shared` : ''}</span>
    </button>
    {#if open}
      <div transition:slideY>
      {#each g.rows as r (r.key)}
        <div class="save row" animate:move transition:slideY>
          {#if r.world}
            {@const w = r.world}
            <button class="open grow" title={w.localPath} onclick={() => go({ kind: 'world', id: w.id })}>
              <strong class="ellipsis">{r.name}</strong>
              <span class="muted small">{w.uploading.length ? `${uploadingLine(w.uploading.map((u) => u.name), w.uploading.length === 1 ? w.uploading[0].percent : null)} · keep SaveRelay open` : w.download ? downloadLine(w.download) : w.detail || `Last played ${when(r.lastPlayedAt)} · with ${w.sharedWith.length} friend${w.sharedWith.length === 1 ? '' : 's'}${w.storageBytes !== null ? ` · ${bytes(w.storageBytes)}` : ''}`}</span>
            </button>
            <StatusBadge status={w.status} download={w.download} />
          {:else}
            <div class="stack tight grow" title={r.found?.path}>
              <strong class="ellipsis">{r.name}</strong>
              <span class="muted small">Last played {when(r.lastPlayedAt)} · Only on this PC</span>
            </div>
            <button class="primary" onclick={() => (sharing = { path: r.found!.path, discovered: r.found })}>Share</button>
          {/if}
        </div>
      {/each}
      </div>
    {/if}
  </section>
{:else}
  {#if query.trim()}<p class="muted small">Nothing matches “{query}”.</p>{/if}
{/each}

<button class="other" onclick={other}>
  <strong class="grow">Other game…</strong>
  <span class="faint small">Choose its save folder</span>
</button>

{#if attention === 0 && ui.peers.length > 0 && !ui.peers.some((p) => p.connected)}
  <p class="faint small">None of your friends are online right now. Updates are delivered when you and a friend holding them are online at the same time.</p>
{/if}

<dialog bind:this={dialog} onclose={() => (sharing = null)}>
  {#if sharing}
    {#key sharing.path}
      <div class="stack">
        <AddWorld {ui} {act} {go} preset={sharing} onclose={() => (sharing = null)} />
      </div>
    {/key}
  {/if}
</dialog>

<style>
  .group { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .group-head { width: 100%; display: flex; gap: 12px; align-items: center; text-align: left; background: none; border: none; border-radius: 0; padding: 14px 16px; }
  .group-head:hover:not(:disabled) { background: var(--panel-2); border: none; }
  .chev { color: var(--muted); font-size: 18px; line-height: 1; width: 12px; transition: transform 0.12s; }
  .chev.open { transform: rotate(90deg); }
  .save { padding: 10px 16px 10px 44px; border-top: 1px solid var(--line); min-height: 56px; }
  .open { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left; background: none; border: none; padding: 0; min-width: 0; }
  .open:hover:not(:disabled) { background: none; border: none; }
  .open:hover strong { color: var(--ember-2); }
  .other { display: flex; gap: 10px; align-items: center; text-align: left; padding: 14px 16px; border-style: dashed; background: none; }
  .other:hover:not(:disabled) { border-color: var(--ember); background: none; }
  /* Wide buttons barely shrink when pressed, or the whole row lurches. */
  .group-head:active:not(:disabled), .other:active:not(:disabled) { transform: scale(0.995); }
  .open:active:not(:disabled) { transform: none; }
  dialog { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 12px; padding: 24px; width: min(640px, 90vw); }
  dialog::backdrop { background: #000a; }
</style>
