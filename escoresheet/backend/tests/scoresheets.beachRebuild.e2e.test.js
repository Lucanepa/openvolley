/**
 * LOG-02 (audit 26.11, record-pdf-1 / beach-logic-1): an admin's "Rebuild PDF"
 * of a beach match wrote an indoor-drawn sheet (no pairs, 0:0) over the
 * device's signed OpenBeach approval PDF: the beach file name has no random
 * part, so the rebuild's name was the device's own. Now neither rebuild route
 * nor the record read for one takes a beach match (409 OV_BEACH_SHEET), before
 * anything is drawn or stored; the device's PDF stays as it was, and a beach
 * row is never "Out of date" (nothing here could rebuild it).
 * (audit PoCs: poc/log_02/beach-rebuild-overwrite.sh, poc/record-pdf/beach-rebuild-overwrite.sh)
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SKIP } from './helpers/e2eServer.js'
import { pdfBytes, startScoresheetsStack } from './helpers/scoresheetsStack.js'

const sha = (b) => createHash('sha256').update(b).digest('hex')

describe('Rebuild PDF refuses a beach match (LOG-02)', { skip: SKIP }, () => {
  let st
  before(async () => {
    // with the render service: rebuild-vector gets past its 503 and must refuse the beach match itself
    st = await startScoresheetsStack({ render: true, ipBase: '203.0.113', gameBase: 97100 })
    await st.account('admin', ['admin'])
    await st.account('bea', ['beach:scorer'])
    await st.account('bcm', ['beach:competition_manager'])
  })
  after(async () => { await st?.stop() })

  it('the device\'s signed beach PDF stays: rebuild, rebuild-vector and the record read are 409, nothing drawn or stored', async () => {
    const { users } = st
    const m = await st.newMatch(users.bea, { sport: 'beach', sets: [[21, 17], [21, 19]], scheduledAt: '2026-11-23T10:00:00Z' })
    // OpenBeach's own name: beach/{day}/game{n}_{seed}.pdf (no random part)
    const path = `beach/${m.day}/game${m.n}_${m.ext}.pdf`
    const signed = pdfBytes('ORIGINAL device sheet signed by the referee')
    const up = await st.uploadPdf(users.bea, path, 'ORIGINAL device sheet signed by the referee')
    assert.equal(up.status, 200, up.text)
    await st.close(users.bea, m.id)
    const before = await st.records(m.id)
    assert.deepEqual(before.map((r) => [r.path, r.sha256]), [[path, sha(signed)]])
    const renders = st.render.calls.length

    st.expectCode(await st.call(users.admin, 'POST', `/api/scoresheets/${m.id}/rebuild-vector`, { reason: 'out of date' }), 409, 'OV_BEACH_SHEET')
    st.expectCode(await st.call(users.admin, 'GET', `/api/scoresheets/${m.id}/match`), 409, 'OV_BEACH_SHEET')
    const rebuilt = pdfBytes('REBUILT by admin (indoor sheet code)').toString('base64')
    st.expectCode(await st.call(users.admin, 'POST', `/api/scoresheets/${m.id}/rebuild`, { reason: 'out of date', fileBase64: rebuilt }), 409, 'OV_BEACH_SHEET')

    assert.equal(st.render.calls.length, renders, 'nothing sent to the render service')
    assert.deepEqual(await st.records(m.id), before, 'the record of the device\'s file is as it was')
    assert.ok((await st.newestPdf(users.bcm, m.id)).equals(signed), 'the served PDF is the signed device sheet')
    // neither a rebuild entry nor a read for one
    const { rows } = await st.sql.query("SELECT action, details FROM public.audit_log WHERE match_id = $1 AND action IN ('scoresheet.rebuild', 'scoresheet.read')", [m.id])
    assert.deepEqual(rows.filter((r) => r.action === 'scoresheet.rebuild' || r.details?.purpose === 'rebuild'), [])
  })

  it('a beach row is never "Out of date": nothing here rebuilds it', async () => {
    const { users } = st
    const m = await st.newMatch(users.bea, { sport: 'beach', sets: [[21, 15], [21, 18]], scheduledAt: '2026-11-23T11:00:00Z' })
    assert.equal((await st.uploadPdf(users.bea, `beach/${m.day}/game${m.n}_${m.ext}.pdf`, 'device sheet')).status, 200)
    await st.close(users.bea, m.id)
    // the PDF and the close an hour ago, then a correction of the record (Data or SQL tab)
    await st.sql.query('SET session_replication_role = replica')
    try {
      await st.sql.query("UPDATE public.matches SET closed_at = closed_at - interval '1 hour' WHERE id = $1", [m.id])
    } finally {
      await st.sql.query('SET session_replication_role = origin')
    }
    await st.sql.query("UPDATE public.match_scoresheets SET stored_at = stored_at - interval '1 hour' WHERE match_id = $1", [m.id])
    await st.sql.query('BEGIN')
    await st.sql.query("SET LOCAL ov.allow_closed = 'on'")
    await st.sql.query("UPDATE public.matches SET remarks = 'pair name corrected' WHERE id = $1", [m.id])
    await st.sql.query('COMMIT')
    const list = await st.call(users.bcm, 'GET', '/api/scoresheets?app=beach&limit=500')
    assert.equal(list.status, 200, list.text)
    const row = list.json.data.matches.find((x) => x.id === m.id)
    assert.equal(row.pdf, true)
    assert.ok(Date.parse(row.data_changed_at) > Date.parse(row.pdf_updated_at), 'the data did change after the PDF')
    assert.equal(row.pdf_stale, false)
  })
})
