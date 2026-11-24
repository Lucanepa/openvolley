import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => [])
vi.mock('@capacitor/filesystem', () => ({ Filesystem: {}, Directory: {}, Encoding: {} }))
vi.mock('../androidFiles', () => ({
  moveLegacyFiles: vi.fn(async (_fs, opts) => { calls.push(`move:${opts?.os}`) }),
  pruneScoresheetPdfs: vi.fn(async (_fs, opts) => { calls.push(`prune:${opts?.os}`) }),
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
    expect(calls).toEqual(['move:android', 'prune:android', 'rotate'])
  })

  // Owner decision 9 (SEC-51/52): the iOS app keeps its files in
  // Library/NoCloud, not in Documents (shown in the Files app); what older
  // versions left in Documents moves in at the first start, the PDFs follow
  // the 30 days. (This test used to pin "no move on iOS": Documents, Data and
  // External are one folder there, so a move into Data emptied it. The target
  // is Library/NoCloud now: androidFiles.test.js "iOS".)
  it('iOS: the Documents files move into the app folder, then the PDF clean-up', async () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    try {
      await startNativeFileHousekeeping({ delayMs: 0 })
    } finally {
      delete window.Capacitor
    }
    // (the rotation runs once per app session: the test above started it)
    expect(calls).toEqual(['move:ios', 'prune:ios'])
  })

  it('a Capacitor app that does not say its OS: no move', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    try {
      await startNativeFileHousekeeping({ delayMs: 0 })
    } finally {
      delete window.Capacitor
    }
    expect(calls).toEqual([])
  })

  it('a browser: nothing', async () => {
    await startNativeFileHousekeeping({ delayMs: 0, platform: 'web' })
    expect(calls).toEqual([])
  })

  it('Export to Documents hands the plugin to androidFiles', async () => {
    await expect(exportNativeFilesToDocuments()).resolves.toMatchObject({ backups: 2, scoresheets: 1 })
  })
})
