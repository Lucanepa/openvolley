import { writeFileSync, readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

/**
 * Dev-branch builds of the web apps (owner decision 5): a Cloudflare Pages
 * preview, which also serves the dev-*.openvolley.app sites, never talks to
 * the production backend and stays out of search engines. Shared by
 * vite.config.js (main multi-page build) and scripts/build-subdomains.js
 * (per-app builds). Deploy: docs/manager-site-deploy.md, "Dev builds and the
 * test backend".
 *
 *   - Its backend is VITE_DEV_BACKEND_URL (the test backend, with its own
 *     database), put in VITE_BACKEND_URL. The VITE_BACKEND_URL of the Pages
 *     environment (production's, on many projects) is ignored. Without a test
 *     backend the build has none at all: VITE_OV_DEV_BUILD makes
 *     src/utils/backendConfig.js drop its fallback to backend.openvolley.app,
 *     and the pages say "No test backend configured".
 *   - Its pages carry noindex (a robots meta, an X-Robots-Tag header in
 *     _headers, robots.txt) and a small "Test build" badge, so nobody scores
 *     an official match there by mistake.
 *
 * Which builds: Pages sets CF_PAGES=1 and CF_PAGES_BRANCH; every branch but
 * PRODUCTION_BRANCH is a dev build. OV_BUILD_CHANNEL=dev|production wins (a
 * local test of a dev build, a production branch with another name).
 * Everything else (the desktop, Android and release builds) is production.
 */

export const PRODUCTION_BRANCH = 'main'
export const PRODUCTION_BACKEND_URL = 'https://backend.openvolley.app'

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {'dev'|'production'}
 */
export function buildChannel(env = process.env) {
  const explicit = String(env.OV_BUILD_CHANNEL || '').trim().toLowerCase()
  if (explicit === 'dev' || explicit === 'production') return explicit
  if (env.CF_PAGES === '1' && env.CF_PAGES_BRANCH && env.CF_PAGES_BRANCH !== PRODUCTION_BRANCH) return 'dev'
  return 'production'
}

/**
 * The test backend of a dev build: VITE_DEV_BACKEND_URL when it is an https
 * address and not the production backend, else '' (none).
 * @param {Record<string, string|undefined>} [env]
 * @param {{ warn?: (msg: string) => void }} [opts]
 */
export function devBackendUrl(env = process.env, { warn = (msg) => console.warn(msg) } = {}) {
  const raw = String(env.VITE_DEV_BACKEND_URL || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  let url
  try { url = new URL(raw) } catch { url = null }
  if (!url || url.protocol !== 'https:') {
    warn(`[build-channel] VITE_DEV_BACKEND_URL is not an https address (${raw}): this dev build has no backend`)
    return ''
  }
  if (url.hostname === new URL(PRODUCTION_BACKEND_URL).hostname) {
    warn('[build-channel] VITE_DEV_BACKEND_URL names the production backend: this dev build has no backend')
    return ''
  }
  return raw
}

/**
 * The Vite `define` entries of a dev build ({} for production): its test
 * backend in place of VITE_BACKEND_URL, no VITE_CLOUD_API_URL, the dev flag.
 * @param {Record<string, string|undefined>} [env]
 */
export function channelDefines(env = process.env, opts) {
  if (buildChannel(env) !== 'dev') return {}
  return {
    'import.meta.env.VITE_OV_DEV_BUILD': JSON.stringify('true'),
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify(devBackendUrl(env, opts)),
    'import.meta.env.VITE_CLOUD_API_URL': JSON.stringify('')
  }
}

export const DEV_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'
const X_ROBOTS_TAG = 'X-Robots-Tag: noindex, nofollow'

/**
 * The _headers file of a dev build: the one the build wrote (if any) with an
 * X-Robots-Tag rule for every path. Cloudflare Pages applies every rule that
 * matches a path, so a second "/*" block adds to the first.
 * @param {string|null} existing
 */
export function devHeadersFile(existing) {
  const text = existing || ''
  if (text.includes(X_ROBOTS_TAG)) return text
  const sep = text && !text.endsWith('\n') ? '\n' : ''
  return `${text}${sep}/*\n  ${X_ROBOTS_TAG}\n`
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** The badge's text: which backend this dev build uses, or that it has none. */
export function devBadgeText(env = process.env, opts) {
  const backend = devBackendUrl(env, opts)
  return backend ? `Test build · ${new URL(backend).host}` : 'Test build · No test backend configured'
}

/**
 * Vite transformIndexHtml tags of a dev build: noindex (unless the page has
 * its own robots meta, as the manager consoles) and the badge, bottom left,
 * never in the way of a tap and never on paper.
 * @param {string} html
 */
export function devBuildTags(html, env = process.env, opts) {
  const tags = []
  if (!/<meta\s+name=["']robots["']/i.test(html)) {
    tags.push({ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' }, injectTo: 'head' })
  }
  tags.push({ tag: 'style', children: '@media print{[data-ov-dev-build]{display:none!important}}', injectTo: 'head' })
  tags.push({
    tag: 'div',
    attrs: {
      'data-ov-dev-build': '',
      role: 'note',
      style: 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;padding:2px 8px;border-radius:9999px;background:rgba(180,83,9,0.92);color:#fff;font:600 11px/1.6 system-ui,sans-serif'
    },
    children: escapeHtml(devBadgeText(env, opts)),
    injectTo: 'body'
  })
  return tags
}

/**
 * The Vite plugin: nothing in a production build; in a dev build the
 * defines, the noindex tags and the badge on every page, robots.txt and the
 * X-Robots-Tag rule in _headers.
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 */
export function buildChannelPlugin({ env = process.env } = {}) {
  const dev = buildChannel(env) === 'dev'
  let outDir = null
  return {
    name: 'openvolley-build-channel',
    apply: 'build',
    config() {
      if (!dev) return undefined
      console.log(`[build-channel] dev build, ${devBadgeText(env, { warn: () => {} }).replace('Test build · ', '')}`)
      return { define: channelDefines(env) }
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    transformIndexHtml(html) {
      return dev ? devBuildTags(html, env, { warn: () => {} }) : undefined
    },
    // After the public files are copied: robots.txt and _headers are
    // written over / added to whatever the build put there
    closeBundle() {
      if (!dev || !outDir || !existsSync(outDir)) return
      writeFileSync(resolve(outDir, 'robots.txt'), DEV_ROBOTS_TXT)
      const headersPath = resolve(outDir, '_headers')
      writeFileSync(headersPath, devHeadersFile(existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : null))
    }
  }
}
