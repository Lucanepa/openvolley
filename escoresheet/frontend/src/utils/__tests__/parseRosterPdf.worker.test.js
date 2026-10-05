import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Roster PDF import must work offline / on a LAN-only venue box: the pdf.js
// worker has to come from the app bundle (same origin, precached), not a CDN.

// Stand-in for Vite's emitted asset URL (resolving the real ?url import needs
// the dev server's fs allow-list, which a symlinked node_modules can trip).
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-TEST.mjs' }))

const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  version: '5.0.0',
  getDocument: () => ({ promise: Promise.reject(new Error('stop after worker setup')) })
}))
vi.mock('pdfjs-dist', () => pdfjsMock)

import { parseRosterPdf } from '../parseRosterPdf'

describe('parseRosterPdf worker source', () => {
  it('points pdf.js at the bundled worker, never a CDN URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = { arrayBuffer: async () => new ArrayBuffer(0) }
    await expect(parseRosterPdf(file)).rejects.toThrow('stop after worker setup')
    expect(pdfjsMock.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min-TEST.mjs')
  })

  it('imports the worker as a bundled asset and has no CDN URL left', () => {
    const src = readFileSync(resolve(__dirname, '../parseRosterPdf.js'), 'utf8')
    expect(src).toMatch(/from 'pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url'/)
    expect(src).not.toMatch(/unpkg\.com|cdn\.jsdelivr\.net/)
  })

  // A module worker is rejected unless served with a JavaScript MIME type, and
  // the bundled worker is a .mjs file: every static server must know .mjs.
  it.each([
    '../../../server.js',
    '../../../electron/relayServer.js',
    '../../../../backend/server.js'
  ])('%s serves .mjs as JavaScript', (file) => {
    const src = readFileSync(resolve(__dirname, file), 'utf8')
    expect(src).toMatch(/'\.mjs':\s*'(?:application|text)\/javascript'/)
  })
})
