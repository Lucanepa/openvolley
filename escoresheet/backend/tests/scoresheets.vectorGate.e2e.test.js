/**
 * LOG-09 (audit 26.11, record-pdf-2; owner decision 3): the server's vector
 * copy may replace the device's signed PDF as the official sheet only after a
 * FULL completeness check of its record (lib/scoresheets.js recordGate): the
 * number of finished sets, each set's score = set_results, final_score and
 * the winner, every finished set's points ending at its score (forfeit
 * excepted), no set left unfinished. Otherwise the device's PDF stays the
 * served one and an ops error is logged (the error tracker, not only a log
 * line). A print that misses a picture (a signature) is refused the same way.
 * (audit PoC: wt-audit-ov/tests/_audit/record-pdf-vector-gate.test.mjs)
 *
 * The e2e part needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { recordGate, setsMatchClose } from '../lib/scoresheets.js'
import { SKIP, sleep, waitUntil } from './helpers/e2eServer.js'
import { VECTOR, key, pdfBytes, startScoresheetsStack } from './helpers/scoresheetsStack.js'

const pt = (set, seq, home, away, extra = {}) => ({ set_index: set, seq, type: 'point', payload: { team: 'home', score: { home, away }, ...extra } })
const set = (index, home, away, finished = true) => ({ index, home_points: home, away_points: away, finished })
// 3:1, as the scorer app writes the match end (eventSync buildSetEndMatchPayload)
const match = {
  status: 'approved',
  final_score: '3-1',
  winner: 'home',
  set_results: [{ set: 1, home: 25, away: 20 }, { set: 2, home: 22, away: 25 }, { set: 3, home: 25, away: 18 }, { set: 4, home: 25, away: 23 }]
}
const sets = [set(1, 25, 20), set(2, 22, 25), set(3, 25, 18), set(4, 25, 23)]
const events = [pt(1, 45, 25, 20), pt(2, 92, 22, 25), pt(3, 135, 25, 18), pt(4, 183, 25, 23)]

describe('recordGate: the record ends as its close says (owner decision 3)', () => {
  it('a complete record passes', () => {
    assert.deepEqual(recordGate({ match, sets, events }), { ok: true })
    // the older form of the close's result ("3:1", { index }) and a JSON string
    assert.equal(setsMatchClose({ match: { ...match, final_score: '3:1', set_results: JSON.stringify(match.set_results.map(({ set: index, ...r }) => ({ index, ...r }))) }, sets, events }), true)
  })

  it('the audit PoC: set 4 never finished on the server (its set end refused for good)', () => {
    const r = recordGate({ match, sets: [...sets.slice(0, 3), set(4, 21, 23, false)], events: [...events.slice(0, 3), pt(4, 179, 21, 23)] })
    assert.deepEqual(r, { ok: false, reason: 'unfinished_set' })
  })

  it('the audit PoC: a finished set without a single point event', () => {
    const r = recordGate({ match: { ...match, set_results: [...match.set_results.slice(0, 3), { set: 4, home: 25, away: 0 }] }, sets: [...sets.slice(0, 3), set(4, 25, 0)], events: events.slice(0, 3) })
    assert.deepEqual(r, { ok: false, reason: 'no_points' })
  })

  it('fewer or more finished sets than the close lists, another score, another result or winner', () => {
    assert.equal(recordGate({ match, sets: sets.slice(0, 3), events: events.slice(0, 3) }).reason, 'set_results_count')
    assert.equal(recordGate({ match: { ...match, set_results: match.set_results.slice(0, 3) }, sets, events }).reason, 'set_results_count')
    assert.equal(recordGate({ match: { ...match, set_results: [...match.set_results.slice(0, 3), { set: 4, home: 25, away: 21 }] }, sets, events }).reason, 'set_score')
    assert.equal(recordGate({ match: { ...match, final_score: '3-0' }, sets, events }).reason, 'final_score')
    assert.equal(recordGate({ match: { ...match, final_score: null }, sets, events }).reason, 'final_score')
    assert.equal(recordGate({ match: { ...match, winner: 'away' }, sets, events }).reason, 'winner')
    assert.equal(recordGate({ match: { ...match, winner: null }, sets, events }).reason, 'winner')
    assert.equal(recordGate({ match: { ...match, set_results: null }, sets, events }).reason, 'no_set_results')
    assert.equal(recordGate({ match, sets: [], events: [] }).reason, 'no_finished_set')
  })

  it('the last point is not at the set\'s score (points still on their way); without a running score the points are counted', () => {
    assert.equal(recordGate({ match, sets, events: [...events.slice(0, 3), pt(4, 182, 24, 23)] }).reason, 'points_score')
    // newest by seq, whatever the order they came in
    assert.equal(recordGate({ match, sets, events: [...events.slice(0, 3), pt(4, 183, 25, 23), pt(4, 170, 20, 20)] }).ok, true)
    const counted = Array.from({ length: 25 }, (_, i) => ({ set_index: 1, seq: i + 1, type: 'point', payload: { team: 'home' } }))
    const one = { match: { ...match, final_score: '1-0', set_results: [{ set: 1, home: 25, away: 0 }] }, sets: [set(1, 25, 0)] }
    assert.equal(recordGate({ ...one, events: counted }).ok, true)
    assert.equal(recordGate({ ...one, events: counted.slice(1) }).reason, 'points_score')
  })

  it('forfeit excepted: a set the forfeit ended, and every set of a match forfeited in default', () => {
    // a set awarded by the forfeit: no rally, no point at its score
    const awarded = { match: { ...match, set_results: [...match.set_results.slice(0, 3), { set: 4, home: 25, away: 0 }] }, sets: [...sets.slice(0, 3), set(4, 25, 0)] }
    assert.equal(recordGate({ ...awarded, events: [...events.slice(0, 3), { set_index: 4, seq: 140, type: 'set_end', payload: { reason: 'forfait', team: 'home' } }] }).ok, true)
    // in default: every set of the result 25:0, the played ones rewritten
    const zero = [1, 2, 3].map((i) => set(i, 25, 0))
    const inDefault = { match: { ...match, final_score: '3-0', set_results: zero.map((s) => ({ set: s.index, home: 25, away: 0 })) }, sets: zero }
    assert.equal(recordGate({ ...inDefault, events: [pt(1, 10, 5, 3), { set_index: 1, seq: 11, type: 'forfait', payload: { scope: 'match', inDefault: true, team: 'away' } }] }).ok, true)
    assert.equal(recordGate({ ...inDefault, events: [pt(1, 10, 5, 3)] }).reason, 'points_score')
  })
})

describe('the vector copy after the approval, gated (LOG-09)', { skip: SKIP }, () => {
  let st
  before(async () => {
    st = await startScoresheetsStack({ render: true, ipBase: '192.0.2', gameBase: 99100 })
    await st.account('ivan', ['scorer'])
    await st.account('cm', ['competition_manager'])
  })
  after(async () => { await st?.stop() })

  const opsErrors = async (reason) => (await st.sql.query(
    "SELECT e.kind, e.level, e.message, e.data FROM public.error_events e WHERE e.source = 'server' AND e.message LIKE $1",
    [`%vector copy refused (${reason})%`])).rows
  const vectorRows = async (id) => (await st.sql.query("SELECT count(*)::int AS n FROM public.audit_log WHERE match_id = $1 AND action = 'scoresheet.vector'", [id])).rows[0].n

  it('a record that does not end as the close says: no vector copy, the device\'s PDF served, an ops error logged', async () => {
    const { users } = st
    // the close says 3:1, but set 4's end never reached the server
    const m = await st.newMatch(users.ivan, { sets: [[25, 20], [22, 25], [25, 18]] })
    await st.sql.query("UPDATE public.matches SET set_results = $2::jsonb, final_score = '3-1', winner = 'home' WHERE id = $1",
      [m.id, JSON.stringify([{ set: 1, home: 25, away: 20 }, { set: 2, home: 22, away: 25 }, { set: 3, home: 25, away: 18 }, { set: 4, home: 25, away: 23 }])])
    await st.sql.query('INSERT INTO public.sets (match_id, external_id, index, home_points, away_points, finished) VALUES ($1, $2, 4, 21, 23, false)', [m.id, `${m.ext}:set:4`])
    const renders = st.render.calls.length
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'device sheet, signed', m.ext)).status, 200)
    await st.close(users.ivan, m.id)
    await waitUntil(async () => (await opsErrors('unfinished_set')).length > 0, { timeoutMs: 20000, what: 'the ops error' })
    const [e] = await opsErrors('unfinished_set')
    assert.deepEqual([e.kind, e.level], ['job.failed', 'error'])
    assert.equal(e.data.game_n, m.n)
    assert.equal(e.data.reason, 'unfinished_set')
    assert.equal(st.render.calls.length, renders, 'nothing printed')
    assert.equal(await vectorRows(m.id), 0)
    assert.ok((await st.newestPdf(users.cm, m.id)).equals(pdfBytes('device sheet, signed')))
  })

  it('a print that misses a picture (a signature) is refused the same way', async () => {
    const { users } = st
    const m = await st.newMatch(users.ivan, { sets: [[25, 20], [25, 18], [25, 16]] })
    st.render.missingPictures = 1
    try {
      assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'device sheet with signatures', m.ext)).status, 200)
      await st.close(users.ivan, m.id)
      await waitUntil(async () => (await opsErrors('missing_pictures')).some((e) => e.data.game_n === m.n), { timeoutMs: 20000, what: 'the ops error' })
    } finally {
      st.render.missingPictures = 0
    }
    assert.equal(await vectorRows(m.id), 0)
    assert.ok((await st.newestPdf(users.cm, m.id)).equals(pdfBytes('device sheet with signatures')))
  })

  it('a complete record still gets its copy, served as the newest', async () => {
    const { users } = st
    const m = await st.newMatch(users.ivan, { sets: [[25, 20], [22, 25], [25, 18], [25, 23]] })
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'device sheet', m.ext)).status, 200)
    await st.close(users.ivan, m.id)
    await waitUntil(async () => (await vectorRows(m.id)) === 1, { timeoutMs: 20000, what: 'the vector copy' })
    assert.ok((await st.newestPdf(users.cm, m.id)).equals(VECTOR))
    await sleep(200)
    assert.equal((await st.sql.query("SELECT count(*)::int AS n FROM public.error_events WHERE source = 'server' AND (data->>'game_n')::int = $1", [m.n])).rows[0].n, 0)
  })
})
