// lib/sheetTimes.js is a byte-for-byte copy of the app's time rules
// (frontend/src/domain/sheetTimes.js): the public API's set minutes are the
// minutes printed on the scoresheet (owner 2026-11-16).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cloudSetTimes, rebuildSetStart } from '../lib/sheetTimes.js'

describe('lib/sheetTimes.js', () => {
  it('is the same file as frontend/src/domain/sheetTimes.js (copy it over after a change)', () => {
    const server = readFileSync(new URL('../lib/sheetTimes.js', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../../frontend/src/domain/sheetTimes.js', import.meta.url), 'utf8')
    assert.equal(server, app)
  })

  const ev = (type, setIndex, ts, payload = {}) => ({ type, set_index: setIndex, ts, payload })
  it('the confirmed start, to the minute; minutes = end - start of the printed times', () => {
    const [t] = cloudSetTimes(
      [{ index: 1, start_time: '2026-11-15T14:00:00Z', end_time: '2026-11-15T14:19:40Z', finished: true }],
      [ev('set_start', 1, '2026-11-15T14:15:30Z', { startTime: '2026-11-15T14:15:30Z' }), ev('point', 1, '2026-11-15T14:16:00Z', { team: 'home' })]
    )
    // the row's 14:00 is its creation time (earlier than the confirmed 14:15): the confirmed start
    assert.equal(new Date(t.startMs).toISOString(), '2026-11-15T14:15:00.000Z')
    assert.equal(new Date(t.endMs).toISOString(), '2026-11-15T14:19:00.000Z')
    assert.equal(t.minutes, 4)
  })
  it('a start corrected after the match (logged) wins', () => {
    const set = { index: 1, start_time: '2026-11-15T14:10:00Z' }
    const events = [ev('set_start', 1, '2026-11-15T14:15:00Z', { startTime: '2026-11-15T14:15:00Z' })]
    assert.equal(rebuildSetStart(set, events, [{ action: 'setTimes', setIndex: 1, after: { startTime: '2026-11-15T14:10:00Z' } }]), '2026-11-15T14:10:00Z')
    assert.equal(rebuildSetStart(set, events, []), '2026-11-15T14:15:00.000Z')
  })
  it('an unfinished set has no minutes', () => {
    const [t] = cloudSetTimes([{ index: 2, start_time: '2026-11-15T14:40:00Z', end_time: null, finished: false }], [])
    assert.equal(t.minutes, null)
  })
})
