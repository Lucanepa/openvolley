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
})
