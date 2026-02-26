import '@testing-library/jest-dom'

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
