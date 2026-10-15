/**
 * Colour theme boot (src/utils/theme.js): an inline script at the top of each
 * page's <head> that sets <html data-theme> before the first paint, so a dark
 * or e-ink page does not flash light while the bundle loads, and follows a
 * change made in another tab. Shared by vite.config.js (main multi-page build,
 * dev server) and scripts/build-subdomains.js (per-app builds).
 *
 * Not on the scoresheet page (the paper form) and not on the manager consoles
 * (no theme choice there, and on their own domain the key is never set).
 */
export const THEME_BOOT_SCRIPT = "(function(){var r=document.documentElement;function a(){var t;try{t=localStorage.getItem('theme')}catch(e){}if(t==='dark'||t==='eink')r.setAttribute('data-theme',t);else r.removeAttribute('data-theme')}a();addEventListener('storage',function(e){if(e.key==='theme'||e.key===null)a()})})()"

// Pages of the main build / dev server that stay light
const LIGHT_ONLY_PAGES = ['/scoresheet/index.html', '/manager.html', '/manager-beach.html']

/** Whether the page at this path (vite's transformIndexHtml ctx.path) gets the boot script. */
export function themedPage(path) {
  return !LIGHT_ONLY_PAGES.some(p => path.endsWith(p))
}

/**
 * The vite plugin.
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] false: a light-only build (the subdomain build of the scoresheet or a manager)
 */
export function themeBoot({ enabled = true } = {}) {
  return {
    name: 'theme-boot',
    transformIndexHtml(html, ctx) {
      if (!enabled || !themedPage(ctx.path)) return html
      return [{ tag: 'script', injectTo: 'head-prepend', children: THEME_BOOT_SCRIPT }]
    }
  }
}
