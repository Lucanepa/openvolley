import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, fireEvent } from '@testing-library/react'
import ErrorBoundary from '../ErrorBoundary'

let shouldThrow = true
function Bomb() {
  if (shouldThrow) throw new Error('boom')
  return <span>recovered</span>
}

describe('ErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows a recoverable screen instead of unmounting the app, and "Try again" re-mounts', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    shouldThrow = true
    render(<ErrorBoundary name="test"><Bomb /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()

    shouldThrow = false
    fireEvent.click(screen.getByText('Try again'))
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })

  // Every app root must be wrapped, or a render error is a white page.
  it.each([
    'main.jsx',
    'referee-main.jsx',
    'bench-main.jsx',
    'livescore-main.jsx',
    'scoresheet-main.jsx',
    'upload-roster-main.jsx'
  ])('%s wraps its app in ErrorBoundary', (file) => {
    const src = readFileSync(resolve(__dirname, '../..', file), 'utf8')
    expect(src).toMatch(/<React\.StrictMode>\s*<ErrorBoundary[^>]*>[\s\S]*<\/ErrorBoundary>\s*<\/React\.StrictMode>/)
    expect(src).not.toMatch(/replaceState\(null, '', window\.location\.pathname\)/)
  })

  // The main build's /scoresheet page is scoresheet/index.html ->
  // scoresheet_pdf/index_scoresheet.tsx (scoresheet-main.jsx is only used by the
  // subdomain build). It has its own boundary: every render must use it.
  it('main-build scoresheet entry (index_scoresheet.tsx) wraps every root.render in its ErrorBoundary', () => {
    const html = readFileSync(resolve(__dirname, '../../../scoresheet/index.html'), 'utf8')
    expect(html).toMatch(/src="\/scoresheet_pdf\/index_scoresheet\.tsx"/)
    const src = readFileSync(resolve(__dirname, '../../../scoresheet_pdf/index_scoresheet.tsx'), 'utf8')
    const renders = src.split('root.render(').slice(1)
    expect(renders.length).toBeGreaterThan(0)
    // Every render except the synchronous catch-path fallback (plain markup)
    const appRenders = renders.filter((r) => /<React\.StrictMode>/.test(r.slice(0, 80)))
    expect(appRenders.length).toBe(renders.length - 1)
    for (const r of appRenders) {
      expect(r).toMatch(/^\s*<React\.StrictMode>\s*<ErrorBoundary>/)
    }
  })
})
