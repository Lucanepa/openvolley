// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { subdomains, htmlFor, usesPwa, extraFilesFor, hostFor, manifestFor } from '../../scripts/build-subdomains.js'

const frontendDir = resolve(__dirname, '../..')

describe('build-subdomains: manager.openvolley.app', () => {
  const manager = subdomains.manager

  it('is a subdomain build with its own entry', () => {
    expect(manager).toBeTruthy()
    expect(manager.title).toBe('OpenVolley Manager')
    expect(manager.mainEntry).toBe('manager-main')
    expect(existsSync(resolve(frontendDir, 'src', `${manager.mainEntry}.jsx`))).toBe(true)
    expect(existsSync(resolve(frontendDir, manager.htmlFile))).toBe(true)
  })

  it('builds from manager.html: title, icons, noindex, the manager entry', () => {
    const html = htmlFor(manager)
    expect(html).toContain('<title>OpenVolley Manager</title>')
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />')
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(html).toContain('src="/src/manager-main.jsx"')
  })

  it('ships no service worker (no stale admin builds), the others keep theirs', () => {
    expect(usesPwa(manager, false)).toBe(false)
    for (const name of ['app', 'referee', 'bench', 'livescore', 'roster', 'scoresheet']) {
      expect(usesPwa(subdomains[name], false), name).toBe(true)
      expect(usesPwa(subdomains[name], true), name).toBe(false)
    }
  })

  it('writes robots.txt and an X-Robots-Tag header for the manager only', () => {
    const files = extraFilesFor(manager)
    expect(files['robots.txt']).toBe('User-agent: *\nDisallow: /\n')
    expect(files._headers).toMatch(/^\/\*\n/)
    expect(files._headers).toContain('X-Robots-Tag: noindex, nofollow')
    expect(files._headers).toContain('X-Frame-Options: DENY')
    expect(extraFilesFor(subdomains.app)).toEqual({})
  })

  it('the other subdomains still get a generated page', () => {
    expect(htmlFor(subdomains.referee)).toContain('src="/src/referee-main.jsx"')
    expect(htmlFor(subdomains.scoresheet)).toContain('src="/src/scoresheet-main.jsx"')
  })
})

describe('build-subdomains: manager-beach.openvolley.app (OpenBeach\'s manager)', () => {
  const beach = subdomains['manager-beach']

  it('the same console from its own page and entry, OpenBeach\'s title', () => {
    expect(beach).toBeTruthy()
    expect(beach.title).toBe('OpenBeach Manager')
    expect(hostFor('manager-beach')).toBe('manager-beach.openvolley.app')
    expect(hostFor('manager')).toBe('manager.openvolley.app')
    expect(existsSync(resolve(frontendDir, 'src', `${beach.mainEntry}.jsx`))).toBe(true)
    const entry = readFileSync(resolve(frontendDir, 'src', `${beach.mainEntry}.jsx`), 'utf8')
    expect(entry).toContain("renderManager('beach')")
    const html = htmlFor(beach)
    expect(html).toContain('<title>OpenBeach Manager</title>')
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />')
    expect(html).toContain('src="/src/manager-beach-main.jsx"')
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(html).not.toMatch(/OpenVolley/)
  })

  it('no service worker; noindex files and its own manifest', () => {
    expect(usesPwa(beach, false)).toBe(false)
    const files = extraFilesFor(beach)
    expect(files['robots.txt']).toBe('User-agent: *\nDisallow: /\n')
    expect(files._headers).toContain('X-Robots-Tag: noindex, nofollow')
    const manifest = JSON.parse(files['manifest.webmanifest'])
    expect(manifest).toMatchObject({ name: 'OpenBeach Manager', start_url: '/', theme_color: '#ffffff' })
    expect(manifest.icons.map(i => i.src)).toEqual(['/icon-192.png', '/icon-512.png'])
    expect(JSON.parse(manifestFor(beach))).toEqual(manifest)
    // OpenVolley's manager is unchanged: no manifest
    expect(extraFilesFor(subdomains.manager)['manifest.webmanifest']).toBeUndefined()
  })

  it('OpenBeach\'s icons (logo B2) replace the OpenVolley ones, at their sizes', () => {
    const png = (p) => { const b = readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)] }
    expect(Object.keys(beach.brandFiles).sort()).toEqual(['apple-touch-icon.png', 'favicon.ico', 'favicon.svg', 'icon-192.png', 'icon-512.png'])
    for (const source of Object.values(beach.brandFiles)) expect(existsSync(resolve(frontendDir, source)), source).toBe(true)
    expect(png(resolve(frontendDir, beach.brandFiles['apple-touch-icon.png']))).toEqual([180, 180])
    expect(png(resolve(frontendDir, beach.brandFiles['icon-192.png']))).toEqual([192, 192])
    expect(png(resolve(frontendDir, beach.brandFiles['icon-512.png']))).toEqual([512, 512])
    expect(readFileSync(resolve(frontendDir, beach.brandFiles['favicon.svg']), 'utf8')).toContain('aria-label="OpenBeach"')
    expect(readFileSync(resolve(frontendDir, 'brand/beach/lockup.svg'), 'utf8')).toContain('aria-label="OpenBeach"')
  })
})

describe('build-subdomains: outputs', () => {
  // Every dist-<name> must be gitignored, or a local build of a new subdomain
  // (dist-manager was missed once) lands in `git add -A`
  it.each(Object.keys(subdomains))('dist-%s is gitignored', (name) => {
    const r = spawnSync('git', ['check-ignore', '-q', `dist-${name}/index.html`], { cwd: frontendDir })
    if (r.error) return // no git here: nothing to check against
    expect(r.status).toBe(0)
  })
})

// A build whose entry chunk outgrows workbox's 2 MiB default fails ("won't
// be precached"): OpenBeach's web app stopped deploying that way at 2.4 MB
// (2026-10-10). The main build and every subdomain build raise the limit.
describe('precache limit', () => {
  it('both builds precache files up to PRECACHE_MAX_FILE_BYTES (at least 4 MiB)', async () => {
    const { PRECACHE_MAX_FILE_BYTES } = await import('../../pwa-workbox.js')
    expect(PRECACHE_MAX_FILE_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024)
    for (const f of ['vite.config.js', 'scripts/build-subdomains.js']) {
      expect(readFileSync(resolve(frontendDir, f), 'utf8'), f).toMatch(/maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES/)
    }
  })
})
