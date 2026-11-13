import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => [])
vi.mock('@capacitor/filesystem', () => ({ Filesystem: {}, Directory: {}, Encoding: {} }))
vi.mock('../androidFiles', () => ({
  moveLegacyFiles: vi.fn(async () => { calls.push('move') }),
  pruneScoresheetPdfs: vi.fn(async () => { calls.push('prune') }),
  exportToDocuments: vi.fn(async () => ({ folder: 'Documents/OpenVolley/export-x', backups: 2, scoresheets: 1, failed: 0 }))
}))
vi.mock('../platform', async (orig) => ({
  ...(await orig()),
  createPlatformStore: vi.fn(async () => ({ list: vi.fn(async () => { calls.push('rotate'); return [] }), info: vi.fn(async () => ({ folder: '/x' })) }))
}))

import { exportNativeFilesToDocuments, startNativeFileHousekeeping } from '..'

beforeEach(() => { calls.length = 0 })

describe('start-up housekeeping of the apps\' files', () => {
  it('Android: moves the old Documents files in first, then the PDF clean-up and the backups\' rotation', async () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
    try {
      await startNativeFileHousekeeping({ delayMs: 0 })
    } finally {
      delete window.Capacitor
    }
    expect(calls).toEqual(['move', 'prune', 'rotate'])
  })

  // Capacitor on iOS maps Documents, Data and External to one folder: a move
  // there deleted the latest.json of every match
  it('another Capacitor app (iOS): no move and no PDF clean-up', async () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    try {
      await startNativeFileHousekeeping({ delayMs: 0 })
    } finally {
      delete window.Capacitor
    }
    // (the rotation runs once per app session: the test above started it)
    expect(calls).not.toContain('move')
    expect(calls).not.toContain('prune')
  })

  it('a browser: nothing', async () => {
    await startNativeFileHousekeeping({ delayMs: 0, platform: 'web' })
    expect(calls).toEqual([])
  })

  it('Export to Documents hands the plugin to androidFiles', async () => {
    await expect(exportNativeFilesToDocuments()).resolves.toMatchObject({ backups: 2, scoresheets: 1 })
  })
})
