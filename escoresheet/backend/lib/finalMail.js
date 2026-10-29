/**
 * finalMail — the final scoresheet by email (db/021; owner decisions
 * 2026-10-29, ~/ov-ops/club-manager-home-email-PLAN.md step 4).
 *
 *   getSettings()                        { send_final_email, changed_at }
 *   setSettings({ actorId, body })       { send_final_email } (admins and competition managers;
 *                                        lib/manageApi.js checks), audited
 *   sweep()                              mails the matches that are due (server.js, every minute)
 *   testMail({ userId, body, lang })     a test match's PDF to its scorer only, never stored
 *
 * Official matches: once an indoor, non-test match is closed (closed_at) and
 * DELAY_MS have passed (the final PDF is on its way: the app queues it with
 * the approval), the newest stored PDF of the match (lib/scoresheets.js
 * latestPdf), stored around the close or after it, goes once to:
 *   - the scorer: the account that closed the match and the scorer's approval account;
 *   - the referees: their approval accounts, and the addresses typed in the
 *     match setup (officials[].email, 1st and 2nd referee);
 *   - the coaches: the contact address of each team's club (db/020
 *     clubs.contact_email; the team names as club_teams spells them).
 * One mail per address (nobody sees the others'). An account's mail is in the
 * language picked at its sign-up (user metadata mail_lang, lib/auth.js); a
 * typed address or a club's contact in English (FINAL_MAIL_LANG overrides). Only while the switch is
 * on, and only matches closed after it was turned on (never the backlog).
 * A match reopened and closed again is mailed again, as "corrected". No PDF
 * within NO_PDF_AFTER_MS of the close: recorded as no_pdf, never mailed. A
 * failed send is tried again on the next sweep, MAX_TRIES times.
 *
 * Addresses are never logged or stored (match_final_mails counts them); the
 * audit entry (match.final_mail) names how many went out.
 */

import { fail, invalid, isUuid, ok, unavailable } from './accounts.js'
import { pickLang } from './mailer.js'

export const DELAY_MS = 2 * 60 * 1000
export const NO_PDF_AFTER_MS = 2 * 60 * 60 * 1000
// The PDF must be the final one: stored at most this long before the close
const PDF_BEFORE_CLOSE_MS = 15 * 60 * 1000
const LOOKBACK = '24 hours'
const MAX_RECIPIENTS = 12
const MAX_TRIES = 5
const BATCH = 20
export const TEST_PDF_MAX_BYTES = 5 * 1024 * 1024
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
// An address without an account (a typed referee address, a club's contact):
// who reads it is not known, so English, the app's binding language (owner,
// 2026-10-29; FINAL_MAIL_LANG overrides, e.g. de)
const DEFAULT_LANG = 'en'

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null)
const cleanAddress = (raw) => {
  const s = String(raw || '').trim().toLowerCase()
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null
}
/** dd.mm.yyyy in Zurich of a date-like value; '' when there is none. */
export function zurichDate (v) {
  const d = v instanceof Date ? v : new Date(v)
  if (!v || Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
}

/** The distinct, valid addresses of `list`, at most MAX_RECIPIENTS. */
export function recipientList (list) {
  const out = []
  for (const raw of list) {
    const a = cleanAddress(raw)
    if (a && !out.includes(a)) out.push(a)
    if (out.length >= MAX_RECIPIENTS) break
  }
  return out
}

/** The referees' addresses typed in the match setup (officials JSON). */
export function refereeAddresses (officials) {
  const list = Array.isArray(officials) ? officials : []
  return list.filter((o) => o && (o.role === '1st referee' || o.role === '2nd referee')).map((o) => o.email).filter(Boolean)
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {{ enabled: boolean, send: Function }} o.mailer  lib/mailer.js
 * @param {{ latestPdf: Function }} o.scoresheets          lib/scoresheets.js
 * @param {(client: any, entry: object) => Promise<void>} o.audit  lib/accounts.js audit
 */
export function createFinalMail ({ pool, mailer, scoresheets, audit, logger = console, now = () => Date.now(), lang = DEFAULT_LANG } = {}) {
  const log = logger
  const tries = new Map() // `${matchId}|${closedAt}` -> failed sends
  let running = false

  async function readSettings () {
    try {
      const { rows: [r] } = await pool.query('SELECT send_final_email, changed_at FROM public.app_settings WHERE id')
      return { send_final_email: r?.send_final_email === true, changed_at: iso(r?.changed_at) }
    } catch (err) {
      if (err?.code === '42P01') return { send_final_email: false, changed_at: null } // before db/021
      throw err
    }
  }

  /** GET /api/settings */
  async function getSettings () {
    try {
      return ok({ settings: await readSettings(), mail: mailer?.enabled === true })
    } catch (err) {
      log.error?.(`[final-mail] settings failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /** PUT /api/settings { send_final_email } */
  async function setSettings ({ actorId, body } = {}) {
    if (!body || typeof body.send_final_email !== 'boolean') return invalid('send_final_email: true or false')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.app_settings (id, send_final_email, changed_by, changed_at) VALUES (true, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET send_final_email = EXCLUDED.send_final_email, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
        [body.send_final_email, isUuid(actorId) ? actorId : null])
      await audit(client, { actorId, action: 'settings.final_email', details: { send_final_email: body.send_final_email } })
      await client.query('COMMIT')
      return ok({ settings: await readSettings(), mail: mailer?.enabled === true })
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* gone */ }
      log.error?.(`[final-mail] settings failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    } finally {
      client.release()
    }
  }

  /** The addresses of one match row (see the header), with the accounts' languages. */
  async function recipientsOf (m) {
    const { rows: accounts } = await pool.query(
      `SELECT lower(u.email) AS email, u.raw_user_meta_data->>'mail_lang' AS lang FROM auth.users u
        WHERE u.id = $2
           OR u.id IN (SELECT a.user_id FROM public.match_approvals a
                        WHERE a.match_id = $1 AND a.revoked_at IS NULL AND a.slot IN ('scorer', 'referee1', 'referee2'))`,
      [m.id, isUuid(m.closed_by) ? m.closed_by : null])
    const names = [m.home_name, m.away_name].filter(Boolean).map((n) => n.trim().toLowerCase())
    let clubs = []
    if (names.length) {
      const { rows } = await pool.query(
        `SELECT DISTINCT c.contact_email AS email FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id
          WHERE lower(btrim(ct.team_name)) = ANY($1::text[]) AND c.contact_email IS NOT NULL`, [names])
      clubs = rows
    }
    const to = recipientList([...accounts.map((r) => r.email), ...refereeAddresses(m.officials), ...clubs.map((r) => r.email)])
    const langs = new Map(accounts.filter((r) => r.lang).map((r) => [r.email, pickLang(r.lang, null)]))
    return to.map((address) => ({ address, lang: langs.get(address) || lang }))
  }

  // closed_at as the database wrote it (microseconds): a JS Date keeps
  // milliseconds only, so the row would never match its close and the match
  // would be mailed again on every sweep
  async function record (m, outcome, recipients, corrected) {
    await pool.query(
      `INSERT INTO public.match_final_mails (match_id, closed_at, outcome, recipients, corrected) VALUES ($1, $2::timestamptz, $3, $4, $5)
       ON CONFLICT (match_id, closed_at) DO NOTHING`, [m.id, m.closed_at_exact, outcome, recipients, corrected])
    if (outcome === 'sent') {
      await audit(pool, { actorId: null, action: 'match.final_mail', matchId: m.id, details: { recipients, corrected, game_n: m.game_n ?? null } })
    }
  }

  /** One due match: mailed, recorded as not mailable, or left for the next sweep. */
  async function mailOne (m) {
    const key = `${m.id}|${m.closed_at_exact}`
    const closedMs = new Date(m.closed_at).getTime()
    const pdf = await scoresheets.latestPdf({ ...m, sport: 'indoor' })
    if (pdf?.unknown) return 'later' // the storage could not be read: next sweep
    if (!pdf || pdf.mtimeMs < closedMs - PDF_BEFORE_CLOSE_MS) {
      if (now() - closedMs >= NO_PDF_AFTER_MS) {
        await record(m, 'no_pdf', 0, m.corrected)
        return 'no_pdf'
      }
      return 'later'
    }
    const to = await recipientsOf(m)
    if (!to.length) {
      await record(m, 'no_recipients', 0, m.corrected)
      return 'no_recipients'
    }
    const vars = {
      teams: `${m.home_name || '?'} – ${m.away_name || '?'}`,
      game: m.game_n != null ? String(m.game_n) : '',
      date: zurichDate(m.scheduled_at || m.closed_at),
      result: m.final_score || '',
      corrected: m.corrected === true
    }
    let sent = 0
    let failed = 0
    for (const { address, lang: mailLang } of to) {
      try {
        const r = await mailer.send('scoresheet', { to: address, lang: mailLang, vars, attachments: [{ filename: pdf.filename, content: pdf.data }] })
        if (r?.sent) sent++
      } catch (err) {
        failed++
        log.warn?.(`[final-mail] a send failed: ${String(err?.code || err?.message || err).slice(0, 120)}`)
      }
    }
    if (failed && !sent) {
      const n = (tries.get(key) || 0) + 1
      tries.set(key, n)
      if (n < MAX_TRIES) return 'later'
      log.error?.(`[final-mail] match ${m.id}: no mail went out after ${n} tries; given up`)
    }
    tries.delete(key)
    await record(m, 'sent', sent, m.corrected)
    return 'sent'
  }

  /** Mail every due match (one sweep at a time). Never throws. */
  async function sweep () {
    if (running || !mailer?.enabled) return { skipped: true }
    running = true
    try {
      const settings = await readSettings()
      if (!settings.send_final_email || !settings.changed_at) return { skipped: true }
      const { rows } = await pool.query(
        `SELECT m.id, m.external_id, m.game_n, m.closed_at, m.closed_at::text AS closed_at_exact, m.closed_by, m.scheduled_at, m.updated_at, m.created_at,
                m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name, m.match_info->>'league' AS league,
                m.officials, to_jsonb(m) ->> 'final_score' AS final_score,
                EXISTS (SELECT 1 FROM public.match_final_mails f WHERE f.match_id = m.id) AS corrected
           FROM public.matches m
          WHERE m.closed_at IS NOT NULL
            AND m.closed_at >= greatest($1::timestamptz, now() - interval '${LOOKBACK}')
            AND m.closed_at <= $2::timestamptz
            AND m.test IS NOT TRUE AND (m.sport_type IS NOT DISTINCT FROM 'beach') IS NOT TRUE
            AND NOT EXISTS (SELECT 1 FROM public.match_final_mails f WHERE f.match_id = m.id AND f.closed_at = m.closed_at)
          ORDER BY m.closed_at
          LIMIT ${BATCH}`, [settings.changed_at, new Date(now() - DELAY_MS).toISOString()])
      const out = {}
      for (const m of rows) {
        const r = await mailOne(m)
        out[r] = (out[r] || 0) + 1
      }
      return out
    } catch (err) {
      log.error?.(`[final-mail] sweep failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return { error: true }
    } finally {
      running = false
    }
  }

  /**
   * POST /api/scoresheet/test-mail { pdf (base64), teams, result }: a test
   * match's PDF to the caller's own address, whatever the switch (a test is
   * never stored: the mail is its only copy). Capped per inbox (lib/mailer.js).
   */
  async function testMail ({ userId, body, lang: requestLang } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    if (!mailer?.enabled) return fail(503, 'OV_MAIL_UNAVAILABLE', 'Email is not available on this server')
    if (!body || typeof body.pdf !== 'string' || body.pdf.length > Math.ceil(TEST_PDF_MAX_BYTES * 4 / 3) + 4) return invalid('pdf: a PDF of at most 5 MB, base64')
    const data = Buffer.from(body.pdf, 'base64')
    if (data.length < 5 || data.subarray(0, 5).toString('latin1') !== '%PDF-') return invalid('pdf: not a PDF')
    const teams = typeof body.teams === 'string' ? body.teams.slice(0, 200) : ''
    const result = typeof body.result === 'string' ? body.result.slice(0, 60) : ''
    try {
      const { rows: [u] } = await pool.query(`SELECT email, raw_user_meta_data->>'mail_lang' AS lang FROM auth.users WHERE id = $1`, [userId])
      const to = cleanAddress(u?.email)
      if (!to) return fail(409, 'OV_NO_EMAIL', 'Your account has no email address')
      const r = await mailer.send('scoresheet_test', {
        to,
        lang: pickLang(u?.lang, requestLang),
        vars: { teams: teams || '?', result },
        attachments: [{ filename: 'scoresheet_test.pdf', content: data }]
      })
      if (!r?.sent) return fail(429, 'OV_MAIL_LIMIT', 'Too many emails for now, try again later')
      return ok({ sent: true, to })
    } catch (err) {
      log.warn?.(`[final-mail] test mail failed: ${String(err?.code || err?.message || err).slice(0, 120)}`)
      return fail(502, 'OV_MAIL_FAILED', 'The email could not be sent')
    }
  }

  return { enabled: mailer?.enabled === true, getSettings, setSettings, sweep, testMail }
}
