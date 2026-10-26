import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Scoreboard.jsx is too large to mount for its Reopen set dialog; this pins
// the wiring. Stress test 2026-10-25 (correction-clears-signatures-only-locally):
// reopening a set of a finished match cleared the post-match signatures on the
// device only, the server kept them for the changed sheet. Its match job now
// carries the cleared signatures, as MatchEnd's Reopen last set does.
const src = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')

describe('Reopen set on a finished match', () => {
  it('sends the cleared post-match signatures with its status job', () => {
    const start = src.indexOf('Reopen Set {reopenSetConfirm.setIndex}?')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('Yes, reopen', start))
    const clear = body.indexOf('...clearedPostMatchSignatures()')
    const job = body.indexOf("status: 'live',\n", clear)
    expect(clear).toBeGreaterThan(-1)
    expect(job).toBeGreaterThan(clear)
    expect(body.slice(job)).toMatch(/signatures: signaturesPayload\(\{ \.\.\.matchRecord, \.\.\.clearedPostMatchSignatures\(\) \}\)/)
  })
})
