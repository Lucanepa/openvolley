import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'

// waitFor / findBy end on what the screen or the database shows, never on a
// timer, so a longer limit costs a passing test nothing. The default 1 s (and
// the 5 s given by hand to many waits) was too short with the machine loaded:
// one write of a scoring screen took up to 1 s, an action of several writes
// longer, and different tests failed in turn in full-suite runs (OpenBeach
// 8eb8306, 2026-10-08). 10 s, under the 30 s per test (vitest.config.js), so
// a real failure still reports its assertion rather than a test timeout.
configure({ asyncUtilTimeout: 10000 })

// Mock import.meta.env
if (!globalThis.import_meta_env) {
  globalThis.import_meta_env = {}
}

// Mock localStorage
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value) },
    removeItem: (key) => { delete store[key] },
    clear: () => { store = {} },
    get length() { return Object.keys(store).length },
    key: (i) => Object.keys(store)[i] ?? null
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

// Mock navigator.clipboard
Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue('')
  },
  writable: true
})
