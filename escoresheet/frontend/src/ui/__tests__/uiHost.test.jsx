import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { UiHost, confirmDialog, toast, cn } from '../index.js'

const frontend = resolve(__dirname, '../../..')
const read = (p) => readFileSync(resolve(frontend, p), 'utf8')

describe('volleyui kit wiring (P0)', () => {
  it('cn() merges the custom shadow-card utilities', () => {
    expect(cn('shadow-card', 'shadow-none')).toBe('shadow-none')
    expect(cn('h-9 px-3', 'h-11')).toBe('px-3 h-11')
  })

  it('UiHost renders confirmDialog() and resolves on the verb button', async () => {
    render(<UiHost />)
    let answer
    await act(async () => {
      confirmDialog({ title: 'Delete match?', confirmLabel: 'Delete', lang: 'EN' }).then((a) => { answer = a })
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete match?')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('Delete')) })
    expect(answer).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('UiHost renders toasts', async () => {
    render(<UiHost />)
    await act(async () => { toast.success('Saved.') })
    expect(screen.getByText('Saved.')).toBeInTheDocument()
    await act(async () => { toast.clear() })
  })

  // Every app root mounts the host once, inside its ErrorBoundary, and gets the
  // legacy stylesheet only through tailwind.css (in the `legacy` layer).
  it.each([
    'main.jsx',
    'referee-main.jsx',
    'bench-main.jsx',
    'livescore-main.jsx',
    'scoresheet-main.jsx',
    'upload-roster-main.jsx'
  ])('%s mounts <UiHost /> inside ErrorBoundary, in the .ov-kit host', (file) => {
    const src = read('src/' + file)
    // .ov-kit scopes the kit's preflight; .ov-kit-host stacks it above the
    // legacy overlays (z-index 1000-100000).
    expect(src).toMatch(/<ErrorBoundary[^>]*>[\s\S]*<div className="ov-kit ov-kit-host"><UiHost \/><\/div>\s*<\/ErrorBoundary>/)
    expect(src.match(/<UiHost \/>/g)).toHaveLength(1)
    expect(src).toMatch(/import '\.\/tailwind\.css'/)
    expect(src).not.toMatch(/import '\.\/styles\.css'/)
  })

  it('tailwind.css layers styles.css below utilities and loads the kit tokens', () => {
    const css = read('src/tailwind.css')
    expect(css).toMatch(/@layer theme, base, legacy, components, utilities;/)
    expect(css).toMatch(/@import '\.\/styles\.css' layer\(legacy\);/)
    expect(css).toMatch(/@import '\.\/ui\/tokens\.css';/)
    // R3: the legacy names keep their legacy meaning (no unlayered redefinition)
    expect(css).not.toMatch(/^\s*--(border|muted|accent):/m)
    // preflight stays off
    expect(css).not.toMatch(/tailwindcss\/preflight|@import ['"]tailwindcss['"]/)
    expect(read('src/ui/tokens.css')).not.toMatch(/^@import "tailwindcss";/m)
    // the kit host sits above every legacy overlay (AlertContext is 100000)
    expect(css).toMatch(/\.ov-kit-host \{[^}]*z-index: 100001;/)
  })

  it.each([
    'index.html',
    'referee/index.html',
    'bench/index.html',
    'livescore/index.html',
    'upload_roster/index.html',
    'scoresheet/index.html'
  ])('%s is light-only and loads no remote fonts', (file) => {
    const html = read(file)
    expect(html).toMatch(/<meta name="color-scheme" content="light" \/>/)
    expect(html).toMatch(/<meta name="theme-color" content="#ffffff" \/>/)
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
  })

  // The production subdomain builds (release workflow) write their own heads
  // and manifests: same light-only shell as the vite-build entries above.
  it('build-subdomains.js writes light-only heads and manifests', () => {
    const src = read('scripts/build-subdomains.js')
    const colors = [...src.matchAll(/themeColor: '([^']+)'/g)].map((m) => m[1])
    expect(colors).toHaveLength(7)
    expect(new Set(colors)).toEqual(new Set(['#ffffff']))
    // the manager builds from its own page, with the same light head
    expect(read('manager.html')).toMatch(/<meta name="color-scheme" content="light" \/>\s*<meta name="theme-color" content="#ffffff" \/>/)
    // both templates (createIndexHtml, createScoresheetHtml)
    expect(src.match(/<meta name="color-scheme" content="light" \/>\s*<meta name="theme-color" content="\$\{config\.themeColor\}" \/>/g)).toHaveLength(2)
    expect(src).toMatch(/theme_color: config\.themeColor/)
    expect(src).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
  })
})
