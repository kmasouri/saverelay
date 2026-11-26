<script lang="ts">
  // Material Symbols (Rounded, weight 400), bundled so the app needs no network to draw them.
  import games from '@material-symbols/svg-400/rounded/sports_esports.svg?raw'
  import group from '@material-symbols/svg-400/rounded/group.svg?raw'
  import settings from '@material-symbols/svg-400/rounded/settings.svg?raw'

  const ICONS = { games, group, settings }
  let { name, size = 20 }: { name: keyof typeof ICONS; size?: number } = $props()

  const svg = $derived(ICONS[name].replace('<svg ', '<svg aria-hidden="true" fill="currentColor" ').replace('width="48" height="48"', `width="${size}" height="${size}"`))
</script>

<span class="icon">{@html svg}</span>

<style>
  .icon { display: inline-flex; flex-shrink: 0; }
</style>
