import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { render, screen, act } from '@testing-library/react'
import { THEME_KEY, applyTheme, getTheme, initTheme, setTheme, useTheme } from '../theme'
import { TEAM_COLOUR_MARK, teamBoxStyle } from '../teamColours'
import { THEME_BOOT_SCRIPT, themeBoot, themedPage } from '../../../theme-boot.js'

// Light / dark / e-ink: one value in localStorage, shown as <html data-theme>.
// The boot script (theme-boot.js) reads the same key before the first paint.

const root = document.documentElement

function Probe() {
  return <span data-testid="theme">{useTheme()}</span>
}

describe('colour theme', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_KEY)
    root.removeAttribute('data-theme')
  })

  it('initTheme applies the stored theme without the boot script', () => {
    localStorage.setItem(THEME_KEY, 'eink')
    initTheme()
    expect(root.getAttribute('data-theme')).toBe('eink')
    localStorage.setItem(THEME_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
    expect(root.getAttribute('data-theme')).toBe('dark')
  })

  it('every themed page entry calls initTheme', () => {
    for (const entry of ['main', 'referee-main', 'bench-main', 'livescore-main', 'upload-roster-main']) {
      const src = readFileSync(resolve(__dirname, `../../${entry}.jsx`), 'utf-8')
      expect(src, entry).toMatch(/^initTheme\(\)$/m)
    }
  })

  it('is light by default and for an unknown value', () => {
    expect(getTheme()).toBe('light')
    localStorage.setItem(THEME_KEY, 'neon')
    expect(getTheme()).toBe('light')
  })

  it('stores the choice and sets data-theme (none for light)', () => {
    setTheme('eink')
    expect(localStorage.getItem(THEME_KEY)).toBe('eink')
    expect(root.getAttribute('data-theme')).toBe('eink')
    setTheme('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    setTheme('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('treats a bad value as light', () => {
    setTheme('neon')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    applyTheme('neon')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('re-renders on a change here and on one from another tab', () => {
    render(<Probe />)
    expect(screen.getByTestId('theme').textContent).toBe('light')
    act(() => setTheme('dark'))
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    act(() => {
      localStorage.setItem(THEME_KEY, 'eink')
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
    })
    expect(screen.getByTestId('theme').textContent).toBe('eink')
  })
})

describe('theme boot script (theme-boot.js)', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_KEY)
    root.removeAttribute('data-theme')
  })

  it('sets data-theme from the same key and values, and follows another tab', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    new Function(THEME_BOOT_SCRIPT)()
    expect(root.getAttribute('data-theme')).toBe('dark')
    localStorage.setItem(THEME_KEY, 'eink')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
    expect(root.getAttribute('data-theme')).toBe('eink')
    localStorage.setItem(THEME_KEY, 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('goes at the top of every page but the scoresheet and the manager consoles', () => {
    const plugin = themeBoot()
    for (const path of ['/index.html', '/referee/index.html', '/bench/index.html', '/livescore/index.html', '/upload_roster/index.html', '/_build_referee.html']) {
      expect(themedPage(path), path).toBe(true)
      expect(plugin.transformIndexHtml('<html></html>', { path })).toEqual([{ tag: 'script', injectTo: 'head-prepend', children: THEME_BOOT_SCRIPT }])
    }
    for (const path of ['/scoresheet/index.html', '/manager.html', '/manager-beach.html']) {
      expect(themedPage(path), path).toBe(false)
      expect(plugin.transformIndexHtml('<html></html>', { path })).toBe('<html></html>')
    }
    expect(themeBoot({ enabled: false }).transformIndexHtml('<html></html>', { path: '/index.html' })).toBe('<html></html>')
  })

  it('is allowed by the CSP of the backend that serves the pages on a venue box', () => {
    const hash = createHash('sha256').update(THEME_BOOT_SCRIPT, 'utf8').digest('base64')
    const server = readFileSync(resolve(__dirname, '../../../../backend/server.js'), 'utf-8')
    expect(server).toContain(`"script-src 'self' 'sha256-${hash}'"`)
  })

  it('both builds use it', () => {
    const config = readFileSync(resolve(__dirname, '../../../vite.config.js'), 'utf-8')
    expect(config).toContain('themeBoot()')
    const subdomains = readFileSync(resolve(__dirname, '../../../scripts/build-subdomains.js'), 'utf-8')
    expect(subdomains).toContain('themeBoot({ enabled: usesTheme(config) })')
  })
})

describe('team colour mark', () => {
  it('team colour boxes carry the mark the themes look for', () => {
    expect(teamBoxStyle('#3b82f6')).toMatchObject(TEAM_COLOUR_MARK)
    expect(teamBoxStyle('#ffffff')).toMatchObject(TEAM_COLOUR_MARK)
    expect(teamBoxStyle('var(--accent)')).toMatchObject(TEAM_COLOUR_MARK)
    expect(teamBoxStyle(null)).toEqual({})
    const css = readFileSync(resolve(__dirname, '../../tailwind.css'), 'utf-8')
    expect(css).toContain(`[style*='${Object.keys(TEAM_COLOUR_MARK)[0]}']`)
  })
})
