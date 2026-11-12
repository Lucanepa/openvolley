import { describe, it, expect, beforeEach } from 'vitest'
import { holdTapsUntilReload, showUpdatingNotice } from '../useServiceWorker'

// The desktop app reloads into a new build right after its first start
// (owner 2026-11-11): the page says so while taps are held
describe('the "Updating OpenVolley…" notice', () => {
  beforeEach(() => {
    document.getElementById('ov-updating-notice')?.remove()
    document.body.inert = false
  })
  it('shows next to the inert body, once', () => {
    holdTapsUntilReload(window)
    expect(document.body.inert).toBe(true)
    const el = document.getElementById('ov-updating-notice')
    expect(el).not.toBeNull()
    expect(el.parentElement).toBe(document.documentElement)
    expect(el.getAttribute('role')).toBe('status')
    expect(el.textContent.length).toBeGreaterThan(0)
    showUpdatingNotice(window)
    expect(document.querySelectorAll('#ov-updating-notice').length).toBe(1)
  })
})
