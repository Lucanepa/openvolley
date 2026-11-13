// @vitest-environment node
// Legacy surfaces removed in 2026-11 stay removed: the Electron shell (a
// Chromium without updates whose child windows kept the preload), packages
// no code imports, the deploy file that started an unpinned static server,
// and the old Supabase Edge Function and build secrets.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const frontendDir = resolve(__dirname, '../..')
const backendDir = resolve(frontendDir, '../backend')
const workflowsDir = resolve(frontendDir, '../../.github/workflows')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const depNames = (pkg) => Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })

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
})
