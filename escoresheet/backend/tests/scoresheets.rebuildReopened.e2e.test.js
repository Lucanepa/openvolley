/**
 * LOG-10 (audit 26.11, record-pdf-3): an admin's "Rebuild PDF" while a match
 * was reopened for a correction made the scorer's re-approval PDF be refused
 * (409 OV_MATCH_CLOSED: storePdf counted the rebuild as the approval's PDF),
 * and the sync queue dropped it: the served and mailed PDF stayed the
 * mid-correction rebuild.
 *  - a match that is not closed is not rebuilt (409 OV_NOT_CLOSED, both routes
 *    and the record read for one);
 *  - a rebuild or a vector copy is never the approval's PDF: the device's
 *    re-approval PDF is taken after one (also from the 26.11.x and 3.x apps,
 *    which send it as before);
 *  - the vector copy waiting from the earlier close is cancelled by the
 *    reopen, so it cannot take the re-approval's place either.
 * (audit PoC: poc/record-pdf/rebuild-blocks-reapproval.sh)
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { SKIP, sleep, waitUntil } from './helpers/e2eServer.js'
import { VECTOR, key, pdfBytes, startScoresheetsStack } from './helpers/scoresheetsStack.js'

describe('Rebuild PDF and a reopened match (LOG-10)', { skip: SKIP }, () => {
  let st
  before(async () => {
    st = await startScoresheetsStack({
      render: true,
      ipBase: '198.51.100',
      gameBase: 98100,
      // the vector copy waits 3 s after the approval's PDF (CLOSED_REPLACE_GRACE_MS in production)
      vectorTimes: { quietMs: 300, recheckMs: 200, graceMs: 3000, retryMs: 200, maxTries: 2, maxWaitMs: 30000 }
    })
    await st.account('admin', ['admin'])
    await st.account('ivan', ['scorer'])
    await st.account('cm', ['competition_manager'])
  })
  after(async () => { await st?.stop() })

  it('a reopened (open) match is not rebuilt: 409 OV_NOT_CLOSED, nothing drawn, read or stored', async () => {
    const { users } = st
    const m = await st.newMatch(users.ivan, { sets: [[25, 20], [25, 21], [25, 19]] })
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'approval', m.ext)).status, 200)
    await st.close(users.ivan, m.id)
    await st.reopen(users.admin, m.id)
    const renders = st.render.calls.length
    const before = await st.records(m.id)
    st.expectCode(await st.call(users.admin, 'POST', `/api/scoresheets/${m.id}/rebuild-vector`, { reason: 'out of date' }), 409, 'OV_NOT_CLOSED')
    st.expectCode(await st.call(users.admin, 'GET', `/api/scoresheets/${m.id}/match`), 409, 'OV_NOT_CLOSED')
    st.expectCode(await st.call(users.admin, 'POST', `/api/scoresheets/${m.id}/rebuild`, { reason: 'out of date', fileBase64: pdfBytes('REBUILT while reopened').toString('base64') }), 409, 'OV_NOT_CLOSED')
    assert.equal(st.render.calls.length, renders)
    assert.deepEqual(await st.records(m.id), before)
    const { rows } = await st.sql.query("SELECT count(*)::int AS n FROM public.audit_log WHERE match_id = $1 AND (action = 'scoresheet.rebuild' OR (action = 'scoresheet.read' AND details->>'purpose' = 'rebuild'))", [m.id])
    assert.equal(rows[0].n, 0)
  })

  it('after a reopen and a new approval, an admin\'s rebuild never keeps the scorer\'s re-approval PDF out', async () => {
    const { users } = st
    const m = await st.newMatch(users.ivan, { sets: [[25, 20], [25, 21], [25, 19]] })
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'first approval', m.ext)).status, 200)
    await st.close(users.ivan, m.id)
    await st.reopen(users.admin, m.id)
    // the scorer corrects and approves again; an admin rebuilds the closed match before the device's PDF is in
    await st.close(users.ivan, m.id, 'approved')
    const reb = await st.call(users.admin, 'POST', `/api/scoresheets/${m.id}/rebuild`, { reason: 'Set start times corrected', fileBase64: pdfBytes('admin rebuild').toString('base64') })
    assert.equal(reb.status, 200, reb.text)
    // the device's re-approval PDF (a 26.11.x app names its match; a 3.x one only its path)
    const up = await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'NEW approval PDF from the device', m.ext)
    assert.equal(up.status, 200, up.text)
    assert.ok((await st.newestPdf(users.cm, m.id)).equals(pdfBytes('NEW approval PDF from the device')), 'the re-approval\'s PDF is the served one')
    assert.equal((await st.records(m.id)).length, 3, 'the first approval\'s, the rebuild, the re-approval\'s')
    // a closed match still takes no OTHER file after its approval's PDF
    st.expectCode(await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'yet another file', m.ext), 409, 'OV_MATCH_CLOSED')
  })

  it('the same for a path-only upload (an older app): the rebuild is not the approval\'s PDF', async () => {
    const { users } = st
    const m = await st.newMatch(users.ivan, { sets: [[25, 18], [25, 16], [25, 14]] })
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'first approval')).status, 200)
    await st.close(users.ivan, m.id)
    await st.reopen(users.admin, m.id)
    await st.close(users.ivan, m.id, 'approved')
    assert.equal((await st.call(users.admin, 'POST', `/api/scoresheets/${m.id}/rebuild`, { reason: 'times', fileBase64: pdfBytes('admin rebuild').toString('base64') })).status, 200)
    const up = await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'NEW approval, path only')
    assert.equal(up.status, 200, up.text)
    assert.ok((await st.newestPdf(users.cm, m.id)).equals(pdfBytes('NEW approval, path only')))
  })

  it('the vector copy waiting from the earlier close is cancelled by the reopen; the re-approval\'s PDF queues its own', async () => {
    const { users } = st
    const m = await st.newMatch(users.ivan, { sets: [[25, 20], [25, 22], [25, 23]] })
    await st.close(users.ivan, m.id)
    // the approval's PDF after the close: the vector copy waits graceMs behind it
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'first approval', m.ext)).status, 200)
    await st.reopen(users.admin, m.id)
    await sleep(200)
    await st.close(users.ivan, m.id, 'approved')
    const renders = st.render.calls.length
    // past the earlier job's wait: it was cancelled, not run on the re-closed match
    await sleep(4000)
    assert.equal(st.render.calls.length, renders, 'no copy of the earlier approval')
    assert.equal((await st.records(m.id)).length, 1)
    const { rows } = await st.sql.query("SELECT count(*)::int AS n FROM public.audit_log WHERE match_id = $1 AND action = 'scoresheet.vector'", [m.id])
    assert.equal(rows[0].n, 0)
    // the re-approval's PDF is taken, and it gets its own vector copy
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'NEW approval', m.ext)).status, 200)
    await waitUntil(async () => (await st.records(m.id)).length === 3, { timeoutMs: 20000, what: 'the vector copy of the re-approval' })
    assert.ok((await st.newestPdf(users.cm, m.id)).equals(VECTOR))
  })

  it('a re-approval PDF that comes while the earlier copy still waits gets the copy (the earlier one is not made)', async () => {
    const { users } = st
    const m = await st.newMatch(users.ivan, { sets: [[25, 10], [25, 11], [25, 12]] })
    await st.close(users.ivan, m.id)
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'first approval', m.ext)).status, 200)
    await st.reopen(users.admin, m.id)
    await st.close(users.ivan, m.id, 'approved')
    // at once: the earlier job still waits its grace
    assert.equal((await st.uploadPdf(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, 'NEW approval', m.ext)).status, 200)
    await waitUntil(async () => (await st.records(m.id)).length === 3, { timeoutMs: 20000, what: 'the vector copy of the re-approval' })
    assert.ok((await st.newestPdf(users.cm, m.id)).equals(VECTOR))
    await sleep(1000)
    const { rows } = await st.sql.query("SELECT details FROM public.audit_log WHERE match_id = $1 AND action = 'scoresheet.vector'", [m.id])
    assert.equal(rows.length, 1, 'one copy, after the re-approval')
    const reopenedAt = (await st.sql.query("SELECT max(at) AS at FROM public.audit_log WHERE match_id = $1 AND action = 'match.reopen'", [m.id])).rows[0].at
    assert.ok(Date.parse(rows[0].details.stored_at) > new Date(reopenedAt).getTime())
  })
})
