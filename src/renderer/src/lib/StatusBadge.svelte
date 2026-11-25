<script lang="ts">
  import { STATUS_LABEL, type WorldStatus } from './api'

  let { status }: { status: WorldStatus } = $props()

  const tone: Record<WorldStatus, string> = {
    'setting-up': '',
    'up-to-date': 'ok',
    playing: 'ember',
    'waiting-for-peer': 'info',
    'pending-update': 'info',
    conflict: 'warn',
    error: 'bad',
  }
</script>

<span class="badge {tone[status]}">{STATUS_LABEL[status]}</span>
