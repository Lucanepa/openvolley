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
  // the worker source of each reading (the modern build, then the main-thread retry)
  sources: [],
  getDocument () {
    pdfjsMock.sources.push(pdfjsMock.GlobalWorkerOptions.workerSrc)
    return { promise: Promise.reject(new Error('stop after worker setup')) }
  }
}))
vi.mock('pdfjs-dist', () => pdfjsMock)
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.legacy-TEST.mjs' }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjsMock)

import { parseRosterPdf } from '../parseRosterPdf'

describe('parseRosterPdf worker source', () => {
  it('points pdf.js at the bundled worker, never a CDN URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = { arrayBuffer: async () => new ArrayBuffer(0) }
    globalThis.pdfjsWorker = { WorkerMessageHandler: {} } // the main thread's worker code, "loaded"
    await expect(parseRosterPdf(file, { plan: { build: 'modern', worker: 'module' } })).rejects.toThrow('stop after worker setup')
    // the bundled worker, then the bundled legacy one (read again on the main thread)
    expect(pdfjsMock.sources).toEqual(['/assets/pdf.worker.min-TEST.mjs', '/assets/pdf.worker.legacy-TEST.mjs'])
  })

  it('imports the worker as a bundled asset and has no CDN URL left', () => {
    const src = readFileSync(resolve(__dirname, '../parseRosterPdf.js'), 'utf8')
    expect(src).toMatch(/from 'pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url'/)
    expect(src).toMatch(/from 'pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url'/)
    expect(src).not.toMatch(/unpkg\.com|cdn\.jsdelivr\.net/)
  })

  // A module worker is rejected unless served with a JavaScript MIME type, and
  // the bundled worker is a .mjs file: every static server must know .mjs.
  it.each([
    '../../../server.js',
    '../../../../backend/server.js'
  ])('%s serves .mjs as JavaScript', (file) => {
    const src = readFileSync(resolve(__dirname, file), 'utf8')
    expect(src).toMatch(/'\.mjs':\s*'(?:application|text)\/javascript'/)
  })
})
