import React from 'react'
import { buildReloadUrl } from '../hooks/useServiceWorker'
import { reportAppError } from '../utils/activity/appError'

/**
 * Top-level error boundary for every app entry (scorer, referee, bench,
 * livescore, upload_roster, scoresheet). A render error shows a recoverable
 * screen instead of a white page. Match data lives in IndexedDB, so "Try again"
 * (re-mount) or "Reload" (same URL, so ?match=&team= stay attached) is safe.
 *
 * Deliberately has no i18n/context dependencies: those may be what crashed.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, resetKey: 0 }
    this.handleRetry = this.handleRetry.bind(this)
    this.handleReload = this.handleReload.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    reportAppError(error?.message || String(error), error?.stack, `render${this.props.name ? `:${this.props.name}` : ''}`)
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}] Render error:`, error, errorInfo?.componentStack)
  }

  handleRetry() {
    // New key forces a fresh mount of the subtree (clears the broken state)
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))
  }

  handleReload() {
    window.location.replace(buildReloadUrl())
  }

  render() {
    const { error, resetKey } = this.state
    if (!error) {
      return <React.Fragment key={resetKey}>{this.props.children}</React.Fragment>
    }

    const buttonStyle = {
      padding: '12px 24px',
      fontSize: '16px',
      fontWeight: 600,
      borderRadius: '8px',
      cursor: 'pointer',
      minWidth: '140px'
    }

    return (
      <div role="alert" style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px',
        padding: '24px',
        boxSizing: 'border-box',
        background: 'var(--bg, #0b1120)',
        color: 'var(--text, #f9fafb)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        textAlign: 'center'
      }}>
        <div style={{ fontSize: '22px', fontWeight: 700 }}>Something went wrong</div>
        <div style={{ maxWidth: '520px', opacity: 0.75, lineHeight: 1.5 }}>
          This screen hit an error. Match data is saved on this device -
          try again, or reload the page.
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{ ...buttonStyle, background: '#3b82f6', color: '#fff', border: 'none' }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={this.handleReload}
            style={{ ...buttonStyle, background: 'transparent', color: 'inherit', border: '1px solid rgba(127, 127, 127, 0.5)' }}
          >
            Reload
          </button>
        </div>
        <details style={{ maxWidth: '720px', width: '100%', textAlign: 'left', opacity: 0.7, fontSize: '12px' }}>
          <summary style={{ cursor: 'pointer' }}>Details</summary>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {String(error?.stack || error?.message || error)}
          </pre>
        </details>
      </div>
    )
  }
}
