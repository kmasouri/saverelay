import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

const license = { fileName: 'license-report.json' }

export default defineConfig({
  main: {
    build: { license, rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
  },
  preload: {
    // Sandboxed preloads must be CommonJS.
    build: { license, rollupOptions: { input: { index: resolve('src/preload/index.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: { license, rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
    plugins: [svelte()],
  },
})
