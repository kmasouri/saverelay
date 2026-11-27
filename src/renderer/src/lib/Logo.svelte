<script lang="ts">
  // The Relay Loop mark; same geometry as the app and tray icons.
  let { size = 26, spin = false }: { size?: number; spin?: boolean } = $props()
</script>

<svg class:spin width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" rx="22" fill="var(--panel-2)" />
  <path d="M27.4 58.2 A24 24 0 0 1 62 29.2" fill="none" stroke="var(--ember)" stroke-width="9" stroke-linecap="round" />
  <polygon points="69.8,33.7 66.5,21.4 57.5,37" fill="var(--ember)" />
  <path d="M72.6 41.8 A24 24 0 0 1 38 70.8" fill="none" stroke="var(--ember-2)" stroke-width="9" stroke-linecap="round" />
  <polygon points="30.2,66.3 33.5,78.6 42.5,63" fill="var(--ember-2)" />
</svg>

<style>
  svg { flex-shrink: 0; display: block; }
  .spin path, .spin polygon { transform-origin: 50px 50px; animation: spin 1.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
