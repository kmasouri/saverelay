<script lang="ts">
  import { when, type Graph, type GraphNode } from './api'

  let {
    graph,
    me,
    online,
    limit,
    onrestore,
  }: { graph: Graph; me: string; online: (deviceId: string) => boolean; limit: number; onrestore: (n: GraphNode) => void } = $props()

  const ROW = 60
  const LANE = 28
  const DOT = 11
  const CURVE = 12

  const rows = $derived(graph.nodes.slice(0, limit))
  const byId = $derived(new Map(graph.nodes.map((n) => [n.id, n])))
  const hasRestore = $derived(rows.some((n) => n.restoredFrom))
  const restoreLane = $derived(graph.lanes)
  const width = $derived(LANE * (graph.lanes + (hasRestore ? 1 : 0)) + 8)

  const x = (lane: number): number => 16 + lane * LANE
  const y = (row: number): number => row * ROW + ROW / 2

  const name = (id: string): string => (id === me ? 'You' : (graph.names[id] ?? 'A friend'))
  function initial(id: string): string {
    const words = name(id).trim().split(/\s+/)
    return (words.length > 1 ? words.at(-1)! : words[0]).charAt(0).toUpperCase()
  }

  function label(n: GraphNode): string {
    const who = name(n.deviceId)
    if (n.kind === 'restore') {
      const from = n.restoredFrom ? byId.get(n.restoredFrom) : undefined
      return from ? `${who} brought back the save from ${when(from.savedAt)}` : `${who} brought back an older save`
    }
    if (!n.parentId) return n.main ? `${who} started sharing` : `${who} shared their own save`
    return n.main ? `${who} played` : `${who} played separately`
  }

  function onThisSave(n: GraphNode): string {
    return n.here.map((id) => (id === me || online(id) ? name(id) : `${name(id)} (offline)`)).join(', ')
  }

  /** Line from a version down to the one it continued from. */
  function edge(n: GraphNode): string | null {
    const p = n.parentId ? byId.get(n.parentId) : undefined
    if (!p) return null
    const [xn, yn, xp, yp] = [x(n.lane), y(n.row), x(p.lane), y(p.row)]
    if (xn === xp) return `M ${xn} ${yn} V ${yp}`
    if (xn > xp) return `M ${xp} ${yp} H ${xn - CURVE} Q ${xn} ${yp} ${xn} ${yp - CURVE} V ${yn}`
    return `M ${xp} ${yp} V ${yn + CURVE} Q ${xp} ${yn} ${xp - CURVE} ${yn} H ${xn}`
  }

  /** Dashed line from a restored version up to the restore, routed outside the other lanes. */
  function restoreEdge(n: GraphNode): string | null {
    const s = n.restoredFrom ? byId.get(n.restoredFrom) : undefined
    if (!s) return null
    const rx = x(restoreLane)
    const [xs, ys, xn, yn] = [x(s.lane) + DOT, y(s.row), x(n.lane) + DOT + 6, y(n.row)]
    return `M ${xs} ${ys} H ${rx - CURVE} Q ${rx} ${ys} ${rx} ${ys - CURVE} V ${yn + CURVE} Q ${rx} ${yn} ${rx - CURVE} ${yn} H ${xn}`
  }
</script>

<div class="graph" style="--row: {ROW}px">
  <svg width={width} height={rows.length * ROW} aria-hidden="true">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ok)" />
      </marker>
    </defs>
    {#each graph.nodes as n (n.id)}
      {@const d = edge(n)}
      {#if d && n.row < limit}
        <path {d} class="line" class:main={n.main && byId.get(n.parentId ?? '')?.main} />
      {/if}
    {/each}
    {#each rows as n (n.id)}
      {@const d = restoreEdge(n)}
      {#if d}<path {d} class="restore" marker-end="url(#arrow)" />{/if}
    {/each}
    {#each rows as n (n.id)}
      <g class="dot" class:main={n.main} class:latest={n.latest}>
        {#if n.latest}<circle cx={x(n.lane)} cy={y(n.row)} r={DOT + 4} class="ring" />{/if}
        <circle cx={x(n.lane)} cy={y(n.row)} r={DOT} />
        <text x={x(n.lane)} y={y(n.row)} dy="0.35em">{initial(n.deviceId)}</text>
      </g>
    {/each}
  </svg>

  <ol>
    {#each rows as n (n.id)}
      <li>
        <div class="stack tight grow">
          <div class="row wrap tight-row">
            <strong class:faint-text={!n.main}>{label(n)}</strong>
            <span class="muted small">{when(n.savedAt)}</span>
            {#if n.latest}<span class="latest">Latest</span>{/if}
          </div>
          {#if n.here.length}<span class="muted small">On this save: {onThisSave(n)}</span>{/if}
        </div>
        {#if !n.latest}<button onclick={() => onrestore(n)}>Restore</button>{/if}
      </li>
    {/each}
  </ol>
</div>

<div class="legend small muted">
  <span><i class="swatch main"></i>The shared game</span>
  {#if graph.lanes > 1}<span><i class="swatch"></i>Played separately</span>{/if}
  {#if hasRestore}<span><i class="swatch dashed"></i>Brought back</span>{/if}
</div>

<style>
  .graph { display: flex; gap: 12px; }
  svg { flex-shrink: 0; overflow: hidden; }
  .line { fill: none; stroke: var(--faint); stroke-width: 2; }
  .line.main { stroke: var(--ember); }
  .restore { fill: none; stroke: var(--ok); stroke-width: 2; stroke-dasharray: 5 4; }
  .dot circle { fill: var(--panel); stroke: var(--faint); stroke-width: 2; }
  .dot text { fill: var(--muted); font-size: 11px; font-weight: 700; text-anchor: middle; }
  .dot.main circle { fill: var(--ember); stroke: none; }
  .dot.main text { fill: #1b0f08; }
  .dot .ring { fill: none !important; stroke: var(--ember) !important; stroke-width: 2; }
  ol { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 0; }
  li { height: var(--row); display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--panel-2); }
  li:last-child { border-bottom: none; }
  .tight-row { gap: 8px; }
  .faint-text { color: var(--muted); }
  .latest { font-size: 12px; font-weight: 600; color: #1b0f08; background: var(--ember); padding: 1px 8px; border-radius: 999px; }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; padding-top: 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { display: inline-block; width: 18px; border-top: 2px solid var(--faint); }
  .swatch.main { border-top-color: var(--ember); }
  .swatch.dashed { border-top: 2px dashed var(--ok); }
</style>
