// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { build } from 'vite'
import {
  buildChannel, devBackendUrl, channelDefines, devHeadersFile, devBuildTags, devBadgeText, buildChannelPlugin, DEV_ROBOTS_TXT
} from '../../build-channel.js'

// Owner decision 5 (x-live-passive-3): the dev-branch builds of every web app
// (Pages previews, the dev-*.openvolley.app sites) used the production
// backend and were indexable. They now use the test backend or none.

const frontendDir = resolve(__dirname, '../..')
const pagesDev = { CF_PAGES: '1', CF_PAGES_BRANCH: 'dev' }
const quiet = { warn: () => {} }

describe('build channel', () => {
  it('a Pages build of any branch but main is a dev build; OV_BUILD_CHANNEL wins', () => {
    expect(buildChannel(pagesDev)).toBe('dev')
    expect(buildChannel({ CF_PAGES: '1', CF_PAGES_BRANCH: 'fix/some-branch' })).toBe('dev')
    expect(buildChannel({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main' })).toBe('production')
    // the desktop, Android and release builds (no Pages)
    expect(buildChannel({})).toBe('production')
    expect(buildChannel({ CF_PAGES_BRANCH: 'dev' })).toBe('production')
    expect(buildChannel({ OV_BUILD_CHANNEL: 'dev' })).toBe('dev')
    expect(buildChannel({ ...pagesDev, OV_BUILD_CHANNEL: 'production' })).toBe('production')
  })

  it('the test backend is an https address that is not production', () => {
    expect(devBackendUrl({ VITE_DEV_BACKEND_URL: 'https://dev-backend.openvolley.app/' }, quiet)).toBe('https://dev-backend.openvolley.app')
    const warn = vi.fn()
    expect(devBackendUrl({ VITE_DEV_BACKEND_URL: 'https://backend.openvolley.app' }, { warn })).toBe('')
    expect(devBackendUrl({ VITE_DEV_BACKEND_URL: 'http://dev-backend.openvolley.app' }, { warn })).toBe('')
    expect(devBackendUrl({ VITE_DEV_BACKEND_URL: 'not a url' }, { warn })).toBe('')
    expect(warn).toHaveBeenCalledTimes(3)
    expect(devBackendUrl({}, quiet)).toBe('')
  })

  it('a dev build replaces VITE_BACKEND_URL by its test backend; production defines nothing', () => {
    const env = { ...pagesDev, VITE_BACKEND_URL: 'https://backend.openvolley.app', VITE_DEV_BACKEND_URL: 'https://dev-backend.openvolley.app' }
    expect(channelDefines(env, quiet)).toEqual({
      'import.meta.env.VITE_OV_DEV_BUILD': '"true"',
      'import.meta.env.VITE_BACKEND_URL': '"https://dev-backend.openvolley.app"',
      'import.meta.env.VITE_CLOUD_API_URL': '""'
    })
    // no test backend: none at all, never production's
    expect(channelDefines({ ...pagesDev, VITE_BACKEND_URL: 'https://backend.openvolley.app' }, quiet)['import.meta.env.VITE_BACKEND_URL']).toBe('""')
    expect(channelDefines({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main', VITE_BACKEND_URL: 'https://backend.openvolley.app' })).toEqual({})
  })

  it('noindex: a robots meta unless the page has one, an X-Robots-Tag rule added to _headers', () => {
    const tags = devBuildTags('<html><head></head><body></body></html>', pagesDev, quiet)
    expect(tags.find(t => t.tag === 'meta')).toMatchObject({ attrs: { name: 'robots', content: 'noindex, nofollow' } })
    const own = devBuildTags('<head><meta name="robots" content="noindex, nofollow" /></head>', pagesDev, quiet)
    expect(own.some(t => t.tag === 'meta')).toBe(false)
    expect(devHeadersFile(null)).toBe('/*\n  X-Robots-Tag: noindex, nofollow\n')
    expect(devHeadersFile('/assets/*\n  Cache-Control: max-age=31536000')).toBe('/assets/*\n  Cache-Control: max-age=31536000\n/*\n  X-Robots-Tag: noindex, nofollow\n')
    const managerHeaders = '/*\n  X-Robots-Tag: noindex, nofollow\n  X-Frame-Options: DENY\n'
    expect(devHeadersFile(managerHeaders)).toBe(managerHeaders)
  })

  it('the badge says which backend, or that there is none', () => {
    expect(devBadgeText(pagesDev, quiet)).toBe('Test build · No test backend configured')
    expect(devBadgeText({ ...pagesDev, VITE_DEV_BACKEND_URL: 'https://dev-backend.openvolley.app' }, quiet)).toBe('Test build · dev-backend.openvolley.app')
    const badge = devBuildTags('', pagesDev, quiet).find(t => t.tag === 'div')
    expect(badge.attrs.style).toContain('pointer-events:none')
    expect(badge.children).toBe('Test build · No test backend configured')
  })

  it('both builds use the plugin (the main multi-page build and every subdomain build)', () => {
    for (const f of ['vite.config.js', 'scripts/build-subdomains.js']) {
      expect(readFileSync(resolve(frontendDir, f), 'utf8'), f).toMatch(/buildChannelPlugin\(\)/)
    }
  })
})

// A real (tiny) Vite build through the plugin: what the bundle and the
// output folder of a dev and a production build hold
describe('build channel plugin in a build', () => {
  let dir
  const savedBackend = process.env.VITE_BACKEND_URL
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    if (savedBackend === undefined) delete process.env.VITE_BACKEND_URL
    else process.env.VITE_BACKEND_URL = savedBackend
  })

  async function buildWith(env) {
    dir = mkdtempSync(join(tmpdir(), 'ov-build-channel-'))
    mkdirSync(join(dir, 'public'))
    writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><html><head><title>t</title></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>')
    writeFileSync(join(dir, 'main.js'), 'window.__backend = [import.meta.env.VITE_BACKEND_URL || "no-backend", import.meta.env.VITE_OV_DEV_BUILD || "prod-build"].join("|")\n')
    // the Pages environment's variable, production's on many projects
    process.env.VITE_BACKEND_URL = 'https://backend.openvolley.app'
    await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      plugins: [buildChannelPlugin({ env })],
      build: { outDir: join(dir, 'out'), emptyOutDir: true }
    })
    const out = join(dir, 'out')
    const js = readdirSync(join(out, 'assets')).filter(f => f.endsWith('.js')).map(f => readFileSync(join(out, 'assets', f), 'utf8')).join('\n')
    const read = (f) => (existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8') : null)
    return { js, html: read('index.html'), robots: read('robots.txt'), headers: read('_headers') }
  }

  it('dev build without a test backend: no backend in the bundle, noindex, the badge', async () => {
    const r = await buildWith({ ...pagesDev })
    expect(r.js).toContain('no-backend')
    expect(r.js).not.toContain('backend.openvolley.app')
    expect(r.html).toContain('<meta name="robots" content="noindex, nofollow"')
    expect(r.html).toContain('Test build · No test backend configured')
    expect(r.robots).toBe(DEV_ROBOTS_TXT)
    expect(r.headers).toContain('X-Robots-Tag: noindex, nofollow')
  }, 60000)

  it('dev build with a test backend: that one', async () => {
    const r = await buildWith({ ...pagesDev, VITE_DEV_BACKEND_URL: 'https://dev-backend.openvolley.app' })
    expect(r.js).toContain('https://dev-backend.openvolley.app')
    expect(r.js).not.toContain('https://backend.openvolley.app')
    expect(r.html).toContain('Test build · dev-backend.openvolley.app')
  }, 60000)

  it('production build: unchanged', async () => {
    const r = await buildWith({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main' })
    expect(r.js).toContain('https://backend.openvolley.app')
    expect(r.js).toContain('prod-build')
    expect(r.html).not.toContain('noindex')
    expect(r.html).not.toContain('Test build')
    expect(r.robots).toBeNull()
    expect(r.headers).toBeNull()
  }, 60000)
})
