// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { resolve } from 'path'
import { subdomains, htmlFor, usesPwa, extraFilesFor } from '../../scripts/build-subdomains.js'

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
    expect(html).toContain('href="/openvolley_no_bg.png"')
    expect(html).toContain('rel="apple-touch-icon"')
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

describe('build-subdomains: outputs', () => {
  // Every dist-<name> must be gitignored, or a local build of a new subdomain
  // (dist-manager was missed once) lands in `git add -A`
  it.each(Object.keys(subdomains))('dist-%s is gitignored', (name) => {
    const r = spawnSync('git', ['check-ignore', '-q', `dist-${name}/index.html`], { cwd: frontendDir })
    if (r.error) return // no git here: nothing to check against
    expect(r.status).toBe(0)
  })
})
