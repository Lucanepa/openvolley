// @vitest-environment node
// Legacy surfaces removed in 2026-11 stay removed: the Electron shell (a
// Chromium without updates whose child windows kept the preload).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const frontendDir = resolve(__dirname, '../..')
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
})
