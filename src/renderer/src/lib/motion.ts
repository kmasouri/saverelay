import { flip } from 'svelte/animate'
import { fade, fly, slide } from 'svelte/transition'

// Svelte transitions run in script, so the CSS reduced-motion rule doesn't reach them.
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A duration that collapses to nothing when Windows is set to reduce animations. */
export const ms = (n: number): number => (reduced ? 0 : n)

export const fadeIn = (node: Element): ReturnType<typeof fade> => fade(node, { duration: ms(120) })
export const slideY = (node: Element): ReturnType<typeof slide> => slide(node, { duration: ms(160) })
export const rise = (node: Element): ReturnType<typeof fly> => fly(node, { y: 12, duration: ms(180) })
export const move = (node: Element, rects: { from: DOMRect; to: DOMRect }): ReturnType<typeof flip> => flip(node, rects, { duration: ms(160) })
