// Inline SVG icons for the server's own HTML (the status page at '/').
//
// The same icon packs as the app (and wiedisync): Lucide for the UI glyphs,
// Phosphor for the volleyball. The markup is copied verbatim from the packages'
// SVG files (only the whitespace is collapsed), so the page needs no runtime
// dependency, no build step and no CDN: it must render on a venue LAN with no
// internet.
//
//   Lucide:   lucide-static 1.52.0, icons/<name>.svg
//             ISC License, Copyright (c) 2026 Lucide Icons and Contributors
//             https://lucide.dev/license
//   Phosphor: @phosphor-icons/core 2.1.1, assets/regular/volleyball.svg
//             MIT License, Copyright (c) 2023 Phosphor Icons
//             https://github.com/phosphor-icons/core/blob/main/LICENSE
//
// To add one: copy the file's <svg> element as it is, under its pack name.

const LUCIDE = {
  // lucide-static 1.52.0 icons/whistle.svg
  whistle: '<svg class="lucide lucide-whistle" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6v4" /><path d="M21 6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-5.675A7 7 0 1 1 9 6z" /></svg>',
  // lucide-static 1.52.0 icons/house.svg
  house: '<svg class="lucide lucide-house" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>',
  // lucide-static 1.52.0 icons/plane.svg
  plane: '<svg class="lucide lucide-plane" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" /></svg>',
  // lucide-static 1.52.0 icons/clipboard-list.svg
  'clipboard-list': '<svg class="lucide lucide-clipboard-list" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" /></svg>',
  // lucide-static 1.52.0 icons/tv.svg
  tv: '<svg class="lucide lucide-tv" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2-5 5-5-5" /><rect width="20" height="15" x="2" y="7" rx="2" /></svg>',
  // lucide-static 1.52.0 icons/tree-palm.svg
  'tree-palm': '<svg class="lucide lucide-tree-palm" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4" /><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3" /><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35" /><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14" /></svg>',
  // lucide-static 1.52.0 icons/smartphone.svg
  smartphone: '<svg class="lucide lucide-smartphone" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></svg>'
}

const PHOSPHOR = {
  // @phosphor-icons/core 2.1.1 assets/regular/volleyball.svg
  volleyball: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm81.74,136.58a88,88,0,0,1-93.49,3.78L132.62,136h83A87.16,87.16,0,0,1,209.74,160.58ZM91.12,48.11a87.57,87.57,0,0,1,24.22-7.2,88,88,0,0,1,50,79.09H132.62ZM215.63,120H181.37a104.18,104.18,0,0,0-35.78-78.23A88.18,88.18,0,0,1,215.63,120ZM77.27,56.13,94.39,85.78a104.14,104.14,0,0,0-49.86,70.09A87.95,87.95,0,0,1,77.27,56.13ZM58.9,182.43a88,88,0,0,1,43.49-82.79L118.76,128,77.27,199.87A88.62,88.62,0,0,1,58.9,182.43ZM128,216a87.5,87.5,0,0,1-36.88-8.11l17.13-29.67a104.23,104.23,0,0,0,85.53,8.17A87.81,87.81,0,0,1,128,216Z"/></svg>'
}

export const ICONS = { ...LUCIDE, ...PHOSPHOR }

/**
 * One icon as inline SVG markup, `size` px square, aria-hidden, colour from
 * `currentColor`. Throws on an unknown name, so a typo fails the page test
 * instead of rendering an empty box.
 */
export function icon(name, { size = 20, className = 'icon' } = {}) {
  const svg = ICONS[name]
  if (!svg) throw new Error(`unknown icon: ${name}`)
  // Drop the file's own size and class; set ours. Everything else is the pack's.
  const open = svg.indexOf('>')
  const attrs = svg.slice('<svg'.length, open).replace(/\s(?:width|height|class)="[^"]*"/g, '')
  return `<svg class="${className}" width="${size}" height="${size}" aria-hidden="true" focusable="false"${attrs}${svg.slice(open)}`
}
