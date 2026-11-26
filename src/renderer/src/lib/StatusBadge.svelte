<script lang="ts">
  import { downloadPercent, STATUS_LABEL, type Download, type WorldStatus } from './api'

  let { status, download = null }: { status: WorldStatus; download?: Download | null } = $props()

  const tone: Record<WorldStatus, string> = {
    'setting-up': '',
    'up-to-date': 'ok',
    playing: 'ember',
    'waiting-for-peer': 'info',
    'pending-update': 'info',
    conflict: 'warn',
    error: 'bad',
  }
  const pct = $derived(download ? downloadPercent(download) : 0)
</script>

{#if status === 'waiting-for-peer' && download}
  <!-- The badge fills up as the save arrives. -->
  <span class="badge plain progress {download.paused ? 'warn' : 'info'}" style="--pct: {pct}%" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
    <span class="label">{download.paused ? `Paused at ${pct}%` : `Downloading ${pct}%`}</span>
  </span>
{:else}
  <span class="badge {tone[status]}">{STATUS_LABEL[status]}</span>
{/if}

<style>
  .progress { position: relative; overflow: hidden; font-weight: 600; }
  .progress::after { content: ''; position: absolute; inset: 0 auto 0 0; width: var(--pct); background: currentColor; opacity: 0.22; transition: width 0.4s; }
  .label { position: relative; }
</style>
