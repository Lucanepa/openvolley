/**
 * finalMail — the final scoresheet by email (db/021 + db/040; owner decisions
 * 2026-10-29, ~/ov-ops/club-manager-home-email-PLAN.md step 4).
 *
 *   getSettings()                        { send_final_email, changed_at }
 *   setSettings({ actorId, body })       { send_final_email } (admins and competition managers;
 *                                        lib/manageApi.js checks), audited
 *   sweep()                              mails the closes that are due (server.js, every minute)
 *   testMail({ userId, body, lang })     a test match's PDF to its scorer only, never stored
 *
 * Official matches: once an indoor, non-test match with a game number is
 * closed (closed_at) and DELAY_MS have passed, its mail goes once to:
 *   - the scorer: the account that closed the match and the scorer's approval account;
 *   - the referees: their approval accounts (a corrected close: also those
 *     whose approvals an admin reopen voided: they signed the sheet it corrects);
 *   - for a game of the imported schedule (svrz_games) only, the addresses
 *     typed in the match setup (officials[].email, the first 1st and the
 *     first 2nd referee) and the coaches: the contact address of the club of
 *     each of the schedule's two teams (db/018 club_teams -> the club ->
 *     db/020 clubs.contact_email). Never a club the match's typed team names
 *     name; the mail then carries the schedule's team names.
 * A match an admin released (release-game: official_game_exempt with
 * released_at, db/040) is not mailed. One mail per address (nobody sees the
 * others), at most MAX_RECIPIENTS. An account's mail is in the language picked
 * at its sign-up (user metadata mail_lang, lib/auth.js); a typed address or a
 * club's contact in English (FINAL_MAIL_LANG overrides). Only while the
 * switch is on, and only matches closed after it was turned on (never the backlog).
 *
 * The PDF is the one of the close's approval: the newest PDF stored for the
 * match (lib/scoresheets.js latestPdf: the files recorded for it, db/033),
 * if it was stored after the last admin reopen before the close (an older one
 * is the sheet this close corrects), and only a real PDF (isMailablePdf). The
 * app sends it in its own queue lane, so it can come long before the close or
 * after it. Without it the sweep looks again every minute; once PDF_GRACE_MS
 * have passed the mail goes without it (saying that it follows), the closing
 * scorer and the admins are told (kind scoresheet_no_pdf), and the PDF goes
 * out on its own as soon as it is stored (up to LATE_PDF_DAYS after the close).
 * A match reopened and closed again is mailed again, as "corrected"; the
 * officials whose approvals the reopen voided hear of the reopen first
 * (kind scoresheet_reopened).
 *
 * One row per close in match_final_mails holds the state (db/040: outcome,
 * attempts, next_try_at, delivered). A mail the hourly budget holds back is
 * deferred (DEFER_MS; no try counted, and that budget is not asked again in
 * the same sweep); a failed send is tried again after a growing pause,
 * MAX_TRIES rounds, then the close is recorded as failed (or partial; a mail
 * without the PDF that reached some stays sent_no_pdf, the PDF follows). A
 * retry mails only the addresses its round has not reached. Every sweep
 * looks at every due close (the longest due first, at most MAX_PER_SWEEP),
 * so one still waiting for its PDF holds back none behind it.
 *
 * Addresses are never logged or stored (match_final_mails counts them;
 * `delivered` holds hashes of round, match, close and address while a round
 * is open); the audit entry (match.final_mail) names how many went out.
 */

import { createHash } from 'node:crypto'
import { fail, invalid, isUuid, ok, unavailable } from './accounts.js'
import { ADMIN_ROLES } from './access.js'
import { MAIL_BUDGET_OF, pickLang } from './mailer.js'
import { connectClient } from './pgClient.js'

export const DELAY_MS = 2 * 60 * 1000
// No PDF of the approval this long after the close: mailed without it
export const PDF_GRACE_MS = 2 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
// The next look at a close waiting for its PDF, and at one mailed without it
const RECHECK_MS = MINUTE_MS
const LATE_RECHECK_MS = 10 * MINUTE_MS
// A PDF stored later than this after the close is not mailed any more
const LATE_PDF_DAYS = 7
// The next try after the hourly budget held mails back
const DEFER_MS = 5 * MINUTE_MS
// Rounds with a failed send; the pause after the n-th: 2, 4, ... 60 minutes (about 3 hours in all)
const MAX_TRIES = 8
const retryMs = (attempts) => Math.min(60, 2 ** attempts) * MINUTE_MS
// A close the sweep has not looked at yet: closed within this
const LOOKBACK_MS = DAY_MS
const MAX_RECIPIENTS = 12
const BATCH = 20
const MAX_PER_SWEEP = 200
export const TEST_PDF_MAX_BYTES = 5 * 1024 * 1024
// The largest attachment a final mail carries (mail servers refuse bigger)
export const MAIL_PDF_MAX_BYTES = 10 * 1024 * 1024
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
// An address without an account (a typed referee address, a club's contact):
// who reads it is not known, so English, the app's binding language (owner,
// 2026-10-29; FINAL_MAIL_LANG overrides, e.g. de)
const DEFAULT_LANG = 'en'
// An address is unconfirmed when the users table tracks confirmation and it is NULL (as lib/approvals.js)
const UNCONFIRMED_SQL = `((to_jsonb(u) ? 'email_confirmed_at') AND (to_jsonb(u) ->> 'email_confirmed_at') IS NULL)`
// A deactivated account (db/027 banned_until) is told nothing (as lib/signupNotices.js)
const ACTIVE_SQL = `coalesce((to_jsonb(u) ->> 'banned_until')::timestamptz <= now(), true)`

const iso = (v) => (v instanceof Date ? v.toISOString() : typeof v === 'number' ? new Date(v).toISOString() : v ?? null)
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

/** The referees' addresses typed in the match setup (officials JSON): the first 1st and the first 2nd referee. */
export function refereeAddresses (officials) {
  const list = Array.isArray(officials) ? officials : []
  return ['1st referee', '2nd referee'].map((role) => list.find((o) => o && o.role === role)?.email).filter(Boolean)
}

/** A file the final mail attaches: a PDF ('%PDF-', '%%EOF' at its end) of at most MAIL_PDF_MAX_BYTES. */
export function isMailablePdf (data) {
  if (!Buffer.isBuffer(data) || data.length < 16 || data.length > MAIL_PDF_MAX_BYTES) return false
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') return false
  return data.subarray(Math.max(0, data.length - 2048)).includes('%%EOF')
}

/** That a round of a close's mails reached an address, as match_final_mails.delivered keeps it (no address). */
const reachedKey = (round, m, address) => createHash('sha256').update(`${round}|${m.id}|${m.closed_at_exact}|${address}`).digest('hex').slice(0, 32)

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {{ enabled: boolean, send: Function }} o.mailer  lib/mailer.js
 * @param {{ latestPdf: Function }} o.scoresheets          lib/scoresheets.js
 * @param {(client: any, entry: object) => Promise<void>} o.audit  lib/accounts.js audit
 */
export function createFinalMail ({ pool, mailer, scoresheets, audit, logger = console, now = () => Date.now(), lang = DEFAULT_LANG } = {}) {
  const log = logger
  const warned = new Set() // matches whose stored file was logged as unusable (once per process)
  const noticeTries = new Map() // `${matchId}|${closedAt}` -> reopen-notice rounds with a failed send
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
    const client = await connectClient(pool, log)
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

  /** The game of the imported schedule (svrz_games: one row per game number): { home, away }, or null. */
  async function scheduleOf (gameN) {
    try {
      const { rows: [g] } = await pool.query(
        `SELECT btrim(team_home) AS home, btrim(team_away) AS away FROM public.svrz_games
          WHERE game_number = $1 AND coalesce(btrim(team_home), '') <> '' AND coalesce(btrim(team_away), '') <> ''
          ORDER BY id DESC LIMIT 1`, [String(gameN)])
      return g || null
    } catch (err) {
      if (err?.code === '42P01') return null // no schedule on this database
      throw err
    }
  }

  /** Accounts ({ email, lang }) first, then the other addresses: recipients { address, lang }, at most MAX_RECIPIENTS. */
  function withLangs (accounts, others = []) {
    const to = recipientList([...accounts.map((r) => r.email), ...others])
    const langs = new Map(accounts.filter((r) => r.lang).map((r) => [String(r.email).toLowerCase(), pickLang(r.lang, null)]))
    return to.map((address) => ({ address, lang: langs.get(address) || lang }))
  }

  /** The addresses of one close (see the header), with the accounts' languages. `game`: scheduleOf. */
  async function recipientsOf (m, game) {
    const { rows: accounts } = await pool.query(
      `SELECT lower(u.email) AS email, u.raw_user_meta_data->>'mail_lang' AS lang FROM auth.users u
        WHERE u.id = $2
           OR u.id IN (SELECT a.user_id FROM public.match_approvals a
                        WHERE a.match_id = $1 AND a.slot IN ('scorer', 'referee1', 'referee2')
                          AND (a.revoked_at IS NULL OR ($3 AND a.revoked_reason = 'match_reopened')))
        ORDER BY u.id = $2 DESC, u.id`,
      [m.id, isUuid(m.closed_by) ? m.closed_by : null, m.corrected === true])
    let others = []
    if (game) {
      // the clubs of the schedule's two teams: the club each team name is
      // recorded for (a team plays for one club, db/018), by its id
      const { rows: clubs } = await pool.query(
        `SELECT c.contact_email AS email FROM public.clubs c
          WHERE c.contact_email IS NOT NULL
            AND c.id IN (SELECT ct.club_id FROM public.club_teams ct WHERE lower(btrim(ct.team_name)) = ANY($1::text[]))
          ORDER BY c.id`, [[game.home, game.away].map((n) => n.toLowerCase())])
      others = [...refereeAddresses(m.officials), ...clubs.map((r) => r.email)]
    }
    return withLangs(accounts, others)
  }

  /** The PDF of the close's approval (see the header): { data, filename, mtimeMs }, or null. */
  async function approvalPdf (m) {
    const once = (what) => {
      if (warned.has(m.id)) return
      if (warned.size >= 1000) warned.clear()
      warned.add(m.id)
      log.warn?.(`[final-mail] match ${m.id}: ${what}`)
    }
    const pdf = await scoresheets.latestPdf({ ...m, sport: 'indoor' })
    if (!pdf) return null
    if (pdf.unknown) {
      once('its stored scoresheets could not be read; the mail waits for them (after the grace it goes without the PDF)')
      return null
    }
    // after an admin reopen only one stored since: an older one is the sheet this close corrects
    if (m.reopened_at && !(pdf.mtimeMs > new Date(m.reopened_at).getTime())) return null
    if (!isMailablePdf(pdf.data)) {
      once('its stored scoresheet is not a PDF a mail carries; it is not attached')
      return null
    }
    return pdf
  }

  // closed_at as the database wrote it (microseconds): a JS Date keeps
  // milliseconds only, so the row would never match its close and the match
  // would be mailed again on every sweep
  async function save (m, { outcome, recipients = m.mailed ?? 0, attempts = 0, nextTryAt = null, delivered = [] }) {
    await pool.query(
      `INSERT INTO public.match_final_mails (match_id, closed_at, outcome, recipients, corrected, attempts, next_try_at, delivered)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7::timestamptz, $8::text[])
       ON CONFLICT (match_id, closed_at) DO UPDATE SET outcome = EXCLUDED.outcome, recipients = EXCLUDED.recipients,
         attempts = EXCLUDED.attempts, next_try_at = EXCLUDED.next_try_at, delivered = EXCLUDED.delivered, at = now()`,
      [m.id, m.closed_at_exact, outcome, recipients, m.corrected === true, attempts, iso(nextTryAt), delivered])
  }

  /**
   * Sends `kind` to each recipient `plan` gives a mail ({ key, vars,
   * attachments }; null: this round reached it already) and adds its key to
   * `done`. Stops at the first mail its budget holds back; that budget is not
   * asked again in this sweep (ctx.held). { sent, failed, held }
   */
  async function deliver (kind, to, plan, done, ctx) {
    const budget = MAIL_BUDGET_OF[kind] || kind
    let sent = 0
    let failed = 0
    for (const rcpt of to) {
      const p = plan(rcpt)
      if (!p) continue
      if (ctx.held.has(budget)) return { sent, failed, held: true }
      try {
        const r = await mailer.send(kind, { to: rcpt.address, lang: rcpt.lang, vars: p.vars, attachments: p.attachments })
        if (r?.skipped === 'budget') {
          ctx.held.add(budget)
          return { sent, failed, held: true }
        }
        // (dropped for another cap: none applies to these kinds; not tried again)
        done.add(p.key)
        if (r?.sent) sent++
      } catch (err) {
        failed++
        log.warn?.(`[final-mail] a ${kind} send failed: ${String(err?.code || err?.message || err).slice(0, 120)}`)
      }
    }
    return { sent, failed, held: false }
  }

  /** The closing scorer and the admins: the result mail went without the PDF. One try; never fails the sweep. */
  async function tellNoPdf (m, vars, ctx) {
    try {
      const { rows } = await pool.query(
        `SELECT lower(u.email) AS email, u.raw_user_meta_data->>'mail_lang' AS lang, u.id = $2 AS scorer
           FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id
          WHERE (u.id = $2 OR p.roles && $1::text[]) AND ${ACTIVE_SQL}
          ORDER BY u.id = $2 DESC, u.created_at, u.id`, [[...ADMIN_ROLES], isUuid(m.closed_by) ? m.closed_by : null])
      const scorers = new Set(rows.filter((r) => r.scorer).map((r) => r.email))
      const r = await deliver('scoresheet_no_pdf', withLangs(rows), (x) => ({ key: x.address, vars: { ...vars, admin: !scorers.has(x.address) } }), new Set(), ctx)
      if (r.held || r.failed) log.warn?.(`[final-mail] match ${m.id}: the notice of its missing PDF did not reach everyone (${r.held ? 'hourly budget' : 'a send failed'})`)
    } catch (err) {
      log.warn?.(`[final-mail] match ${m.id}: the notice of its missing PDF failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
    }
  }

  /** One due close: mailed (with or without the PDF), recorded, or left for a later sweep. */
  async function mailOne (m, ctx) {
    const t = now()
    const late = m.outcome === 'sent_no_pdf' // mailed without the PDF: the PDF is what is still to go
    const pdf = await approvalPdf(m)
    if (!pdf && (late || t - new Date(m.closed_at).getTime() < PDF_GRACE_MS)) {
      await save(m, { outcome: m.outcome || 'pending', attempts: m.attempts, delivered: m.delivered, nextTryAt: t + (late ? LATE_RECHECK_MS : RECHECK_MS) })
      return 'later'
    }
    const game = await scheduleOf(m.game_n)
    const to = await recipientsOf(m, game)
    if (!to.length) {
      await save(m, { outcome: 'no_recipients', recipients: 0 })
      return 'no_recipients'
    }
    const vars = {
      teams: game ? `${game.home} – ${game.away}` : `${m.home_name || '?'} – ${m.away_name || '?'}`,
      game: String(m.game_n),
      date: zurichDate(m.scheduled_at || m.closed_at),
      result: m.final_score || '',
      corrected: m.corrected === true,
      pdf: !!pdf
    }
    // Each address gets the mail with the PDF once ('pdf'); while there is
    // none, the mail without it once ('nopdf'), and then the PDF on its own
    const done = new Set(m.delivered)
    const has = (round, x) => done.has(reachedKey(round, m, x.address))
    const r = await deliver('scoresheet', to, (x) => {
      if (has('pdf', x) || (!pdf && has('nopdf', x))) return null
      return pdf
        ? { key: reachedKey('pdf', m, x.address), vars: { ...vars, late: has('nopdf', x) }, attachments: [{ filename: pdf.filename, content: pdf.data }] }
        : { key: reachedKey('nopdf', m, x.address), vars }
    }, done, ctx)
    const reached = to.filter((x) => has('pdf', x) || has('nopdf', x)).length
    const recipients = late ? Math.max(m.mailed ?? 0, reached) : reached
    const auditMail = (details) => audit(pool, { actorId: null, action: 'match.final_mail', matchId: m.id, details: { ...details, corrected: m.corrected === true, game_n: m.game_n ?? null } })
    if (!to.every((x) => has('pdf', x) || (!pdf && has('nopdf', x)))) {
      const attempts = m.attempts + (r.failed ? 1 : 0)
      if (r.failed && attempts >= MAX_TRIES && !pdf && !late && reached) {
        // Those reached were told the PDF follows: it still does (its own tries)
        await save(m, { outcome: 'sent_no_pdf', recipients, delivered: [...done], nextTryAt: t + LATE_RECHECK_MS })
        log.error?.(`[final-mail] match ${m.id}: the mail without the PDF did not reach all ${to.length} recipients after ${attempts} tries`)
        await auditMail({ outcome: 'partial', recipients: reached, pdf: false })
        await tellNoPdf(m, vars, ctx)
        return 'sent_no_pdf'
      }
      if (r.failed && attempts >= MAX_TRIES) {
        const outcome = late ? 'sent_no_pdf' : reached ? 'partial' : 'failed'
        await save(m, { outcome, recipients, attempts })
        log.error?.(`[final-mail] match ${m.id}: ${pdf ? 'the PDF' : 'the mail'} did not reach all ${to.length} recipients after ${attempts} tries; given up`)
        await auditMail({ outcome: late ? 'pdf_failed' : outcome, recipients: reached, pdf: !!pdf })
        return 'failed'
      }
      await save(m, { outcome: late ? 'sent_no_pdf' : r.held ? 'deferred' : 'pending', recipients, attempts, delivered: [...done], nextTryAt: t + (r.failed ? retryMs(attempts) : DEFER_MS) })
      return r.held ? 'deferred' : 'later'
    }
    if (pdf) {
      await save(m, { outcome: 'sent', recipients })
      await auditMail({ recipients: to.length, pdf: true, ...(late ? { late_pdf: true } : {}) })
      return 'sent'
    }
    await save(m, { outcome: 'sent_no_pdf', recipients, delivered: [...done], nextTryAt: t + LATE_RECHECK_MS })
    await auditMail({ recipients, pdf: false })
    await tellNoPdf(m, vars, ctx)
    return 'sent_no_pdf'
  }

  /** The closes due now, the longest due first, without the matches `seen`. */
  async function dueCloses (changedAt, seen) {
    const t = now()
    const { rows } = await pool.query(
      `SELECT m.id, m.external_id, m.game_n, m.closed_at, m.closed_at::text AS closed_at_exact, m.closed_by, m.scheduled_at, m.updated_at, m.created_at,
              m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name, m.match_info->>'league' AS league,
              m.officials, to_jsonb(m) ->> 'final_score' AS final_score,
              f.outcome, coalesce(f.attempts, 0) AS attempts, coalesce(f.delivered, '{}') AS delivered, f.recipients AS mailed,
              EXISTS (SELECT 1 FROM public.match_final_mails p WHERE p.match_id = m.id AND p.closed_at < m.closed_at AND p.recipients > 0) AS corrected,
              (SELECT max(a.at) FROM public.audit_log a WHERE a.action = 'match.reopen' AND a.match_id = m.id AND a.at <= m.closed_at) AS reopened_at
         FROM public.matches m
         LEFT JOIN public.match_final_mails f ON f.match_id = m.id AND f.closed_at = m.closed_at
        WHERE m.closed_at IS NOT NULL
          AND m.closed_at >= greatest($1::timestamptz, $2::timestamptz)
          AND m.closed_at <= $3::timestamptz
          AND m.test IS NOT TRUE AND (m.sport_type IS NOT DISTINCT FROM 'beach') IS NOT TRUE
          AND m.game_n > 0
          AND NOT (m.official_game_exempt AND m.released_at IS NOT NULL)
          AND ((f.match_id IS NULL AND m.closed_at >= $4::timestamptz)
               OR (f.outcome IN ('pending', 'deferred', 'sent_no_pdf') AND f.next_try_at <= $5::timestamptz))
          AND m.id <> ALL($6::uuid[])
        ORDER BY coalesce(f.next_try_at, m.closed_at), m.id
        LIMIT ${BATCH}`,
      [changedAt, iso(t - LATE_PDF_DAYS * DAY_MS), iso(t - DELAY_MS), iso(t - LOOKBACK_MS), iso(t), seen])
    return rows
  }

  /**
   * The officials who signed a mailed close that an admin reopened since:
   * the accounts of its approvals the reopen voided (made before the close,
   * voided as match_reopened after it). Once per close.
   */
  async function reopenNotices (changedAt, ctx) {
    const t = now()
    const { rows } = await pool.query(
      `SELECT f.match_id AS id, f.closed_at::text AS closed_at_exact, f.delivered, m.game_n, m.scheduled_at,
              m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name, r.details->>'reason' AS reason
         FROM public.match_final_mails f
         JOIN public.matches m ON m.id = f.match_id
         JOIN LATERAL (SELECT a.at, a.details FROM public.audit_log a
                        WHERE a.action = 'match.reopen' AND a.match_id = f.match_id AND a.at > f.closed_at
                        ORDER BY a.at LIMIT 1) r ON true
        WHERE f.reopen_notice IS NULL AND f.recipients > 0 AND r.at >= greatest($1::timestamptz, $2::timestamptz)
        ORDER BY r.at, f.match_id
        LIMIT ${BATCH}`, [changedAt, iso(t - LATE_PDF_DAYS * DAY_MS)])
    const out = []
    for (const f of rows) {
      const mark = (notice, delivered = []) => pool.query(
        'UPDATE public.match_final_mails SET reopen_notice = $3, delivered = $4::text[] WHERE match_id = $1 AND closed_at = $2::timestamptz',
        [f.id, f.closed_at_exact, notice, delivered])
      const { rows: officials } = await pool.query(
        `SELECT lower(u.email) AS email, u.raw_user_meta_data->>'mail_lang' AS lang
           FROM public.match_approvals a JOIN auth.users u ON u.id = a.user_id
          WHERE a.match_id = $1 AND a.revoked_reason = 'match_reopened'
            AND a.approved_at <= $2::timestamptz AND a.revoked_at > $2::timestamptz
          ORDER BY a.approved_at, a.id`, [f.id, f.closed_at_exact])
      const to = withLangs(officials)
      if (!to.length) {
        await mark('none')
        continue
      }
      const game = await scheduleOf(f.game_n)
      const vars = {
        teams: game ? `${game.home} – ${game.away}` : `${f.home_name || '?'} – ${f.away_name || '?'}`,
        game: String(f.game_n ?? ''),
        date: zurichDate(f.scheduled_at),
        reason: f.reason || ''
      }
      const done = new Set(f.delivered)
      const r = await deliver('scoresheet_reopened', to, (x) => {
        const key = reachedKey('reopen', f, x.address)
        return done.has(key) ? null : { key, vars }
      }, done, ctx)
      const triesKey = `${f.id}|${f.closed_at_exact}`
      if (to.every((x) => done.has(reachedKey('reopen', f, x.address)))) {
        noticeTries.delete(triesKey)
        await mark('sent')
        out.push('reopen_notice')
        continue
      }
      const tries = (noticeTries.get(triesKey) || 0) + (r.failed ? 1 : 0)
      if (tries >= MAX_TRIES) {
        noticeTries.delete(triesKey)
        log.error?.(`[final-mail] match ${f.id}: the reopen notice did not reach every official after ${tries} tries; given up`)
        await mark('none')
        out.push('failed')
        continue
      }
      if (noticeTries.size >= 1000) noticeTries.clear()
      noticeTries.set(triesKey, tries)
      // the next sweep: held by the budget, or a send failed
      await mark(null, [...done])
      out.push(r.held ? 'deferred' : 'later')
    }
    return out
  }

  /** Mail every due close (one sweep at a time). Never throws. */
  async function sweep () {
    if (running || !mailer?.enabled) return { skipped: true }
    running = true
    try {
      const settings = await readSettings()
      if (!settings.send_final_email || !settings.changed_at) return { skipped: true }
      const ctx = { held: new Set() }
      const out = {}
      const count = (r) => { out[r] = (out[r] || 0) + 1 }
      const seen = []
      while (seen.length < MAX_PER_SWEEP) {
        const rows = await dueCloses(settings.changed_at, seen)
        if (!rows.length) break
        for (const m of rows) {
          seen.push(m.id)
          count(await mailOne(m, ctx))
        }
        if (rows.length < BATCH) break
      }
      for (const r of await reopenNotices(settings.changed_at, ctx)) count(r)
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
   * never stored: the mail is its only copy). Only to a confirmed address
   * (409 OV_EMAIL_UNCONFIRMED; server.js asks for the scorer role first).
   * On its own hourly budget, capped per inbox (lib/mailer.js); the caller's
   * text goes into the body only, never into the subject.
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
      const { rows: [u] } = await pool.query(
        `SELECT u.email, u.raw_user_meta_data->>'mail_lang' AS lang, ${UNCONFIRMED_SQL} AS unconfirmed FROM auth.users u WHERE u.id = $1`, [userId])
      const to = cleanAddress(u?.email)
      if (!to) return fail(409, 'OV_NO_EMAIL', 'Your account has no email address')
      if (u.unconfirmed === true) {
        return fail(409, 'OV_EMAIL_UNCONFIRMED', 'Confirm your email address first: open the link we sent you, or send a new one from your profile')
      }
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
