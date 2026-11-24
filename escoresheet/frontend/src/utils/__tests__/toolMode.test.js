import { describe, it, expect, beforeEach } from 'vitest'
import { getToolMode, setToolMode, toolModeLocked, impliedToolMode } from '../toolMode'

describe('toolMode', () => {
  beforeEach(() => localStorage.clear())
  it('is unset until chosen, then remembered', () => {
    expect(getToolMode()).toBeNull()
    setToolMode('global')
    expect(getToolMode()).toBe('global')
    setToolMode('nonsense')
    expect(getToolMode()).toBe('global')
  })
  it('locks while a match is on the device', () => {
    expect(toolModeLocked(null, undefined)).toBe(false)
    expect(toolModeLocked(null, { id: 1 })).toBe(true)
  })
  it('a device that never chose takes the tool of its match', () => {
    expect(impliedToolMode({ global: true, test: true })).toBe('global')
    expect(impliedToolMode({ gameNumber: '1' })).toBe('swiss')
    expect(impliedToolMode({ test: true })).toBeNull()
    expect(impliedToolMode(null)).toBeNull()
  })
})
