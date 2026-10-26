/**
 * The manager's Scoresheets tab (lib/scoresheets.js): where a match's stored
 * PDF is found, and end to end who may list and open it (admins and the
 * sport's competition managers; scorers only their own, through storage),
 * with every open in the audit log.
 *
 * The end-to-end part needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { VIEW_LINK_MAX, VIEW_LINK_TTL_MS, bestPdf, cleanGame, createScoresheets, downloadName, filePart, pdfLocator } from '../lib/scoresheets.js'
import { manageFamilyOf } from '../lib/manageApi.js'

const key = () => `k${randomBytes(16).toString('hex')}`
const pdfBytes = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`)

describe('scoresheets (unit)', () => {
  it('routes /api/scoresheets to its own family', () => {
    assert.equal(manageFamilyOf('/api/scoresheets'), 'scoresheets')
    assert.equal(manageFamilyOf('/api/scoresheets/00000000-0000-4000-8000-000000000000/pdf'), 'scoresheets')
    assert.equal(manageFamilyOf('/api/scoresheetsx'), null)
  })

  it('indoor: the game number (else the external id) and the scheduled UTC day', () => {
    const k = key()
    const loc = pdfLocator({ sport: 'indoor', game_n: 402397, external_id: 'match_1', scheduled_at: '2026-10-10T12:30:00Z' })
    assert.deepEqual(loc.folders, ['2026-10-10'])
    assert.equal(loc.rank(`game402397_${k}.pdf`), 2)
    assert.equal(loc.rank('game402397.pdf'), 1, 'an older file without the random part')
    assert.equal(loc.rank(`game4023970_${k}.pdf`), 0, 'another game')
    assert.equal(loc.rank(`game402397_${k}_final.json`), 0, 'not the PDF')
    // no game number: the external id, path-safe as the app writes it
    const friendly = pdfLocator({ sport: 'indoor', game_n: null, external_id: 'vm:abc 1', scheduled_at: '2026-10-10T23:30:00+02:00' })
    assert.deepEqual(friendly.folders, ['2026-10-10'])
    assert.equal(cleanGame('vm:abc 1'), 'vm-abc-1')
    assert.equal(friendly.rank(`gamevm-abc-1_${k}.pdf`), 2)
  })

  it('beach: beach/{day}/game{n}_{seed}.pdf, the seed being the external id', () => {
    const loc = pdfLocator({ sport: 'beach', game_n: 7, external_id: 'match_1760000000000_ab.c', scheduled_at: '2026-10-11T09:00:00Z' })
    assert.deepEqual(loc.folders, ['beach/2026-10-11'])
    assert.equal(loc.rank('game7_match_1760000000000_ab-c.pdf'), 2)
    assert.equal(loc.rank('game7_match_1760000000000_zz.pdf'), 0, 'another tournament\'s game 7')
    assert.equal(loc.rank('game7.pdf'), 1)
    assert.equal(loc.rank('game7_match_1760000000000_ab-c_final.json'), 0)
  })

  it('no scheduled date: the days it was closed, updated and created', () => {
    const loc = pdfLocator({ sport: 'indoor', game_n: 5, scheduled_at: null, closed_at: '2026-10-12T20:00:00Z', updated_at: '2026-10-12T21:00:00Z', created_at: '2026-10-11T18:00:00Z' })
    assert.deepEqual(loc.folders, ['2026-10-12', '2026-10-11'])
  })

  it('the download is named like a scoresheet the app saves: game<n>_<league>_<day in Zurich>', () => {
    assert.equal(downloadName({ game_n: 402397, league: '1L D', scheduled_at: '2026-10-10T12:30:00Z' }, '2026-10-10'), 'game402397_1LD_2026-10-10.pdf')
    // beach leagues keep their words apart; so does an indoor league name (not a code)
    assert.equal(downloadName({ game_n: 8, league: 'Mobiliar Volley Cup', scheduled_at: '2026-10-10T12:30:00Z' }, '2026-10-10'), 'game8_Mobiliar-Volley-Cup_2026-10-10.pdf')
    assert.equal(downloadName({ game_n: 7, sport: 'beach', league: 'Swiss Beach Tour', scheduled_at: '2026-10-10T12:30:00Z' }, '2026-10-10'), 'game7_Swiss-Beach-Tour_2026-10-10.pdf')
    // 00:30 in Zurich (22:30 UTC, filed under the UTC day): the name has the match day, as the app's
    assert.equal(downloadName({ game_n: 5, league: '', scheduled_at: '2026-10-10T22:30:00Z' }, '2026-10-10'), 'game5_2026-10-11.pdf')
    assert.equal(downloadName({ game_n: null, external_id: 'match_1_x', sport: 'beach', league: 'Coop Beachtour Zürich', home_name: 'Müller / Weber', away_name: 'Rossi / Bianchi' }, '2026-10-11'),
      'Mueller-Weber_vs_Rossi-Bianchi_Coop-Beachtour-Zuerich_2026-10-11.pdf')
    assert.equal(filePart('../a/b:c.d', 60), 'a-b-c-d')
  })

  it('the best file: a file of the match before an older one, then the newest', () => {
    const rank = (name) => (name.startsWith('k') ? 2 : name === 'old' ? 1 : 0)
    assert.equal(bestPdf([{ name: 'old', mtimeMs: 9 }, { name: 'k1', mtimeMs: 1 }, { name: 'k2', mtimeMs: 5 }, { name: 'x', mtimeMs: 99 }], rank).name, 'k2')
    assert.equal(bestPdf([{ name: 'old', mtimeMs: 9 }], rank).name, 'old')
    assert.equal(bestPdf([{ name: 'x', mtimeMs: 9 }], rank), null)
  })
})

describe('scoresheet view links (unit)', () => {
  // a module with a fake clock and one stored PDF; readPdf's database and storage stubbed
  function sheets () {
    let t = 1_000_000
    const audits = []
    const m = { id: '11111111-1111-4111-8111-111111111111', game_n: 402397, external_id: 'x', status: 'final', scheduled_at: new Date('2026-10-10T12:30:00Z'), is_beach: false, test: false, league: '1L D', home_name: 'H', away_name: 'A' }
    const pool = { query: async () => ({ rows: [m] }) }
    const storage = {
      listFilesTrusted: async () => [{ name: `game402397_k${'a'.repeat(32)}.pdf`, mtimeMs: 1 }],
      readTrusted: async () => Buffer.from('%PDF-1.4\n%%EOF\n')
    }
    const accounts = { audit: async (_c, e) => { audits.push(e) } }
    const s = createScoresheets({ pool, storage, accounts, logger: { warn () {}, error () {} }, now: () => t })
    return { s, m, audits, tick: (ms) => { t += ms } }
  }
  const tokenOf = (path) => path.split('/')[3]

  it('serves its PDF until the TTL, then 404; another name is 404', async () => {
    const { s, m, audits, tick } = sheets()
    const made = await s.createViewLink({ actorId: 'u1', matchId: m.id })
    assert.equal(made.status, 200)
    assert.equal(made.body.data.filename, 'game402397_1LD_2026-10-10.pdf')
    assert.equal(audits.length, 1)
    const token = tokenOf(made.body.data.path)
    assert.equal(s.readViewLink({ token, name: 'game402397_1LD_2026-10-10.pdf' }).status, 200)
    assert.equal(s.readViewLink({ token, name: 'game402397.pdf' }).status, 404)
    tick(VIEW_LINK_TTL_MS - 1)
    assert.equal(s.readViewLink({ token, name: 'game402397_1LD_2026-10-10.pdf' }).status, 200)
    tick(1)
    assert.equal(s.readViewLink({ token, name: 'game402397_1LD_2026-10-10.pdf' }).status, 404)
  })

  it('keeps at most VIEW_LINK_MAX PDFs: the oldest link goes first', async () => {
    const { s, m } = sheets()
    const first = tokenOf((await s.createViewLink({ actorId: 'u1', matchId: m.id })).body.data.path)
    for (let i = 0; i < VIEW_LINK_MAX; i++) await s.createViewLink({ actorId: 'u1', matchId: m.id })
    assert.equal(s.readViewLink({ token: first, name: 'game402397_1LD_2026-10-10.pdf' }).status, 404)
  })

  it('a refused read makes no link', async () => {
    const { s } = sheets()
    assert.equal((await s.createViewLink({ actorId: 'u1', matchId: 'not-a-uuid' })).status, 404)
  })
})

describe('scoresheets end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  let gameSeq = 93100

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const get = (user, path) => api(srv.base, path, { method: 'GET', token: user?.token, proto: null })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  async function newMatch (owner, { sport = 'indoor', scheduledAt = '2026-10-10T16:00:00Z' } = {}) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const data = { external_id: ext, game_n: n, status: 'live', scheduled_at: scheduledAt, home_team: { name: `Home ${n}` }, away_team: { name: `Away ${n}` }, ...(sport === 'beach' ? { sport_type: 'beach' } : {}) }
    const r = await api(srv.base, '/api/db', { token: owner.token, body: { table: 'matches', action: 'insert', params: { data, returning: 'id', single: true } } })
    assert.equal(r.status, 200, r.text)
    return { ext, n, id: r.json.data.id }
  }
  async function uploadPdf (owner, path, label) {
    const r = await api(srv.base, '/api/storage/upload', { token: owner.token, body: { bucket: 'scoresheets', path, fileBase64: pdfBytes(label).toString('base64'), contentType: 'application/pdf' } })
    assert.equal(r.status, 200, r.text)
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-sheets-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-sheets-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    await account('admin', ['admin'])
    await account('ivan', ['scorer'])
    await account('bea', ['beach:scorer'])
    await account('cm', ['competition_manager'])
    await account('bcm', ['beach:competition_manager'])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('lists a sport\'s matches with their PDF for its competition managers and admins only', async () => {
    const withPdf = await newMatch(users.ivan)
    const without = await newMatch(users.ivan)
    await uploadPdf(users.ivan, `2026-10-10/game${withPdf.n}_${key()}.pdf`, 'indoor')
    const beach = await newMatch(users.bea, { sport: 'beach', scheduledAt: '2026-10-11T09:00:00Z' })
    await uploadPdf(users.bea, `beach/2026-10-11/game${beach.n}_${beach.ext}.pdf`, 'beach')

    const list = await get(users.cm, '/api/scoresheets?app=indoor')
    assert.equal(list.status, 200, list.text)
    const byId = new Map(list.json.data.matches.map((m) => [m.id, m]))
    assert.equal(byId.get(withPdf.id)?.pdf, true)
    assert.equal(byId.get(without.id)?.pdf, false)
    assert.equal(byId.get(withPdf.id)?.home_name, `Home ${withPdf.n}`)
    assert.equal(byId.has(beach.id), false, 'indoor only')
    assert.equal(byId.get(withPdf.id)?.scorer_email, undefined, 'no addresses for competition managers')

    const beachList = await get(users.bcm, '/api/scoresheets?app=beach')
    assert.equal(beachList.status, 200, beachList.text)
    assert.deepEqual(beachList.json.data.matches.map((m) => [m.id, m.pdf, m.sport]), [[beach.id, true, 'beach']])
    assert.equal((await get(users.admin, '/api/scoresheets?app=beach')).status, 200)
    assert.equal((await get(users.cm, `/api/scoresheets?app=indoor&q=${withPdf.n}`)).json.data.matches.length, 1)

    expectCode(await get(users.cm, '/api/scoresheets?app=beach'), 403, 'OV_FORBIDDEN')
    expectCode(await get(users.bcm, '/api/scoresheets?app=indoor'), 403, 'OV_FORBIDDEN')
    expectCode(await get(users.bcm, '/api/scoresheets'), 403, 'OV_FORBIDDEN')
    expectCode(await get(users.ivan, '/api/scoresheets?app=indoor'), 403, 'OV_FORBIDDEN')
    expectCode(await get(users.cm, '/api/scoresheets?app=volley'), 400, 'OV_INVALID_REQUEST')
    assert.equal((await get(null, '/api/scoresheets?app=indoor')).status, 401)
  })

  it('opens the newest PDF of a match in its sport, audited; others are refused', async () => {
    const m = await newMatch(users.ivan)
    await uploadPdf(users.ivan, `2026-10-10/game${m.n}_${key()}.pdf`, 'first device')
    await sleep(20)
    await uploadPdf(users.ivan, `2026-10-10/game${m.n}_${key()}.pdf`, 'second device')

    // the uploader-only rule still holds for everyone else through storage
    const list = await api(srv.base, '/api/storage/list', { token: users.cm.token, body: { bucket: 'scoresheets', path: '2026-10-10' } })
    assert.equal(list.json.data.some((f) => f.name.startsWith(`game${m.n}_`)), false)

    const r = await fetch(`${srv.base}/api/scoresheets/${m.id}/pdf?download=1`, { headers: { Authorization: `Bearer ${users.cm.token}` } })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'application/pdf')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.match(r.headers.get('content-disposition'), new RegExp(`^attachment; filename="game${m.n}_2026-10-10\\.pdf"$`))
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), pdfBytes('second device').toString())

    const { rows } = await sql.query("SELECT actor_id, details, app FROM audit_log WHERE action = 'scoresheet.read' AND match_id = $1", [m.id])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].actor_id, users.cm.id)
    assert.equal(rows[0].details.download, true)
    assert.equal(rows[0].app, null, 'an indoor entry')
    assert.equal(JSON.stringify(rows[0].details).includes('_k'), false, 'the random part stays out of the log')

    const inline = await fetch(`${srv.base}/api/scoresheets/${m.id}/pdf`, { headers: { Authorization: `Bearer ${users.admin.token}` } })
    assert.equal(inline.status, 200)
    assert.match(inline.headers.get('content-disposition'), /^inline; /)

    expectCode(await get(users.bcm, `/api/scoresheets/${m.id}/pdf`), 403, 'OV_FORBIDDEN')
    expectCode(await get(users.ivan, `/api/scoresheets/${m.id}/pdf`), 403, 'OV_FORBIDDEN')
    assert.equal((await sql.query("SELECT count(*)::int n FROM audit_log WHERE action = 'scoresheet.read' AND match_id = $1", [m.id])).rows[0].n, 2)
  })

  it('a view link opens the PDF in the browser\'s viewer under its name, audited; others get 404', async () => {
    const m = await newMatch(users.ivan)
    await uploadPdf(users.ivan, `2026-10-10/game${m.n}_${key()}.pdf`, 'view me')
    const post = (user, id) => api(srv.base, `/api/scoresheets/${id}/view`, { token: user?.token, body: {} })

    const made = await post(users.cm, m.id)
    assert.equal(made.status, 200, made.text)
    const { path, filename, expires_at: expiresAt } = made.json.data
    assert.equal(filename, `game${m.n}_2026-10-10.pdf`)
    assert.match(path, new RegExp(`^/api/scoresheet-view/[A-Za-z0-9_-]{43}/game${m.n}_2026-10-10\\.pdf$`))
    const ttl = Date.parse(expiresAt) - Date.now()
    assert.ok(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000, `expires in ~10 min, not ${ttl} ms`)
    // the read is on record when the link is made, as for GET .../pdf
    const { rows } = await sql.query("SELECT actor_id, details FROM audit_log WHERE action = 'scoresheet.read' AND match_id = $1", [m.id])
    assert.deepEqual(rows.map((x) => [x.actor_id, x.details.download]), [[users.cm.id, false]])

    // no session needed: the browser's viewer has none; inline, named, never cached or passed on
    const r = await fetch(`${srv.base}${path}`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'application/pdf')
    assert.equal(r.headers.get('content-disposition'), `inline; filename="game${m.n}_2026-10-10.pdf"`)
    assert.equal(r.headers.get('cache-control'), 'no-store, private')
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), pdfBytes('view me').toString())
    // the viewer may load it again (a reload) within the TTL
    assert.equal((await fetch(`${srv.base}${path}`)).status, 200)
    assert.equal((await fetch(`${srv.base}${path}`, { method: 'HEAD' })).status, 200)

    // another name, another token, a malformed one: 404, and nothing else is answered
    const token = path.split('/')[3]
    for (const bad of [
      `/api/scoresheet-view/${token}/other.pdf`,
      `/api/scoresheet-view/${'A'.repeat(43)}/game${m.n}_2026-10-10.pdf`,
      `/api/scoresheet-view/${token}`,
      '/api/scoresheet-view/x/y.pdf'
    ]) {
      const b = await fetch(`${srv.base}${bad}`)
      assert.equal(b.status, 404, bad)
      assert.notEqual(b.headers.get('content-type'), 'application/pdf', bad)
    }
    assert.equal((await fetch(`${srv.base}${path}`, { method: 'POST' })).status, 405)

    // only who may open the PDF may make a link; no session, no link
    expectCode(await post(users.bcm, m.id), 403, 'OV_FORBIDDEN')
    expectCode(await post(users.ivan, m.id), 403, 'OV_FORBIDDEN')
    assert.equal((await post(null, m.id)).status, 401)
    const none = await newMatch(users.ivan)
    expectCode(await post(users.cm, none.id), 404, 'OV_SCORESHEET_NOT_FOUND')
  })

  it('a beach PDF for the beach competition manager; no PDF and no match are 404', async () => {
    const beach = await newMatch(users.bea, { sport: 'beach', scheduledAt: '2026-10-12T09:00:00Z' })
    await uploadPdf(users.bea, `beach/2026-10-12/game${beach.n}_${beach.ext}.pdf`, 'beach sheet')
    // another tournament's game with the same number on the same day
    await uploadPdf(users.bea, `beach/2026-10-12/game${beach.n}_match_1_other.pdf`, 'other tournament')
    const r = await fetch(`${srv.base}/api/scoresheets/${beach.id}/pdf`, { headers: { Authorization: `Bearer ${users.bcm.token}` } })
    assert.equal(r.status, 200)
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), pdfBytes('beach sheet').toString())
    const { rows } = await sql.query("SELECT app FROM audit_log WHERE action = 'scoresheet.read' AND match_id = $1", [beach.id])
    assert.deepEqual(rows.map((x) => x.app), ['beach'])
    expectCode(await get(users.cm, `/api/scoresheets/${beach.id}/pdf`), 403, 'OV_FORBIDDEN')

    const none = await newMatch(users.ivan)
    expectCode(await get(users.cm, `/api/scoresheets/${none.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
    expectCode(await get(users.cm, '/api/scoresheets/00000000-0000-4000-8000-000000000000/pdf'), 404, 'OV_NOT_FOUND')
  })

  it('a beach match is listed and searched under its pairs (team1_data / team2_data), and its file named so', async () => {
    // OpenBeach writes team1_data / team2_data and leaves home_team / away_team empty
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const data = { external_id: ext, status: 'live', sport_type: 'beach', scheduled_at: '2026-10-12T09:00:00Z', team1_data: { name: 'Muster / Beispiel' }, team2_data: { name: 'Rossi / Bianchi' } }
    const r = await api(srv.base, '/api/db', { token: users.bea.token, body: { table: 'matches', action: 'insert', params: { data, returning: 'id', single: true } } })
    assert.equal(r.status, 200, r.text)
    const id = r.json.data.id
    await uploadPdf(users.bea, `beach/2026-10-12/game_${ext}.pdf`, 'beach')
    const row = (await get(users.bcm, '/api/scoresheets?app=beach')).json.data.matches.find((m) => m.id === id)
    assert.deepEqual([row?.home_name, row?.away_name], ['Muster / Beispiel', 'Rossi / Bianchi'])
    assert.deepEqual((await get(users.bcm, '/api/scoresheets?app=beach&q=bianchi')).json.data.matches.map((m) => m.id), [id])
    const pdf = await get(users.bcm, `/api/scoresheets/${id}/pdf?download=1`)
    assert.equal(pdf.status, 200, pdf.text)
    assert.match(pdf.headers.get('content-disposition'), /filename="Muster-Beispiel_vs_Rossi-Bianchi/)
  })
})
