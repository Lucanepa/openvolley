// @vitest-environment node
// Legacy surfaces removed in 2026-11 stay removed: the Electron shell (a
// Chromium without updates whose child windows kept the preload), packages
// no code imports, the deploy file that started an unpinned static server,
// the old Supabase Edge Function and build secrets, a leftover page that
// loaded React from a third-party CDN, dead code that called third-party
// image and QR services, and the old Workers config.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const frontendDir = resolve(__dirname, '../..')
const backendDir = resolve(frontendDir, '../backend')
const workflowsDir = resolve(frontendDir, '../../.github/workflows')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const depNames = (pkg) => Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })

/** Files under dir whose name passes keep (paths relative to dir), without build output, native projects and tests. */
function walk(dir, keep, base = dir) {
  const skip = new Set(['node_modules', 'android', 'ios', 'src-tauri', 'coverage', '__tests__'])
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith('.')) continue
    if (entry.isDirectory() && entry.name.startsWith('dist')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, keep, base))
    else if (keep(entry.name)) out.push(path.slice(base.length + 1))
  }
  return out
}

describe('legacy surfaces stay removed', () => {
  it('the frontend has no Electron shell', () => {
    const pkg = readJson(join(frontendDir, 'package.json'))
    expect(pkg.main).toBeUndefined()
    expect(pkg.build).toBeUndefined()
    expect(depNames(pkg).filter((name) => name.startsWith('electron'))).toEqual([])
    expect(Object.keys(pkg.scripts).filter((name) => name.startsWith('electron'))).toEqual([])
    // electron/ holds the shared relay cores only
    for (const file of ['main.js', 'preload.js', 'serverManager.js', 'relayServer.js', 'package.json']) {
      expect(existsSync(join(frontendDir, 'electron', file)), file).toBe(false)
    }
  })

  it('packages that no code imports are not dependencies', () => {
    const frontend = depNames(readJson(join(frontendDir, 'package.json')))
    expect(frontend).not.toContain('serve')
    expect(frontend).not.toContain('html5-qrcode')
    expect(depNames(readJson(join(backendDir, 'package.json')))).not.toContain('cors')
  })

  it('the subdomain builds write no deploy package.json (it started an unpinned `npx serve`)', () => {
    const src = readFileSync(join(frontendDir, 'scripts/build-subdomains.js'), 'utf8')
    expect(src).not.toMatch(/npx serve/)
    expect(src).not.toMatch(/resolve\(outDir, 'package\.json'\)/)
  })

  it('the old Supabase Edge Function and build secrets are gone', () => {
    expect(existsSync(join(backendDir, 'legacy'))).toBe(false)
    if (!existsSync(workflowsDir)) return // a checkout of escoresheet/ alone
    for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name))) {
      expect(readFileSync(join(workflowsDir, file), 'utf8'), file).not.toMatch(/VITE_SUPABASE_/)
    }
  })

  it('no page loads scripts, styles or import maps from another host', () => {
    const pages = walk(frontendDir, (name) => name.endsWith('.html'))
    expect(pages).toContain('index.html')
    for (const page of pages) {
      const html = readFileSync(join(frontendDir, page), 'utf8')
      expect(html, page).not.toMatch(/<script\b[^>]*\bsrc=["'](?:https?:)?\/\//i)
      expect(html, page).not.toMatch(/<link\b[^>]*\brel=["'](?:stylesheet|modulepreload|preload)["'][^>]*\bhref=["'](?:https?:)?\/\//i)
      expect(html, page).not.toMatch(/<link\b[^>]*\bhref=["'](?:https?:)?\/\/[^>]*\brel=["'](?:stylesheet|modulepreload|preload)["']/i)
      for (const [, map] of html.matchAll(/<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        expect(map, page).not.toMatch(/https?:\/\//)
      }
    }
  })

  it('no source file calls the old third-party flag, QR or CDN hosts', () => {
    const sources = ['src', 'scoresheet_pdf'].flatMap((dir) =>
      walk(join(frontendDir, dir), (name) => /\.(jsx?|tsx?)$/.test(name)).map((file) => join(dir, file)))
    expect(sources.length).toBeGreaterThan(50)
    for (const file of sources) {
      expect(readFileSync(join(frontendDir, file), 'utf8'), file).not.toMatch(/flagcdn\.com|api\.qrserver\.com|aistudiocdn\.com/)
    }
  })

  it('the old Workers config is gone', () => {
    expect(existsSync(join(frontendDir, 'wrangler.toml'))).toBe(false)
  })
})
