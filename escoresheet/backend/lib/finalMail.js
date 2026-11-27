/**
 * finalMail — the final scoresheet by email (db/021 + db/040; owner decisions
 * 2026-10-29, ~/ov-ops/club-manager-home-email-PLAN.md step 4).
 *
 *   getSettings()                        { send_final_email, changed_at }
 *   setSettings({ actorId, body })       { send_final_email } (admins and competition managers;
 *                                        lib/manageApi.js checks), audited
 *   sweep()                              mails the closes that are due (server.js, every minute)
 *   status({ matchId })                  an admin's look at one close: its mail state, how many
 *                                        addresses (a count, never one) and whether the PDF is there
 *   sendNow({ actorId, matchId })        an admin's "Send the final mail now" of one close
 *   testMail({ userId, body, lang })     a test match's PDF to its scorer only, never stored
 *
 * Official matches: once an indoor, non-test match with a game number is
 * closed (closed_at) and DELAY_MS have passed, its mail goes once to:
 *   - the scorer: the account that closed the match;
 *   - for a game of the imported schedule (svrz_games) only, the addresses
 *     typed in the match setup (officials[].email, the first 1st and the
 *     first 2nd referee) and the coaches: the contact address of the club of
 *     each of the schedule's two teams (db/018 club_teams -> the club ->
 *     db/020 clubs.contact_email). Never a club the match's typed team names
 *     name; the mail then carries the schedule's team names;
 *   - every official match: each team's contact address typed in the match
 *     setup or Edit match info (officials[] { role: 'team contact', team,
 *     email }; owner 2026-11-15, "like with the referees").
 * A match an admin released (release-game: official_game_exempt with
 * released_at, db/040) is not mailed. One mail per address (nobody sees the
 * others), at most MAX_RECIPIENTS. An account's mail is in the language picked
 * at its sign-up (user metadata mail_lang, lib/auth.js); a typed address or a
 * club's contact in English (FINAL_MAIL_LANG overrides). Only while the
 * switch is on, and only matches closed after it was turned on (never the
 * backlog). "Turned on" is the last change from off to on: saving the switch
 * again, or off and on, never drops a close already on its way (SEC-12).
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
 * A match reopened and closed again is mailed again, as "corrected". (The
 * referees' approval accounts, which also got the mail and a reopen notice,
 * went with approval with a PIN, removed 27.11.2026: a referee gets the mail
 * only at the address typed in the match setup.)
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
 * An admin can send the mail of a closed official match now (sendNow, owner
 * 2026-11-15: the switch mails only closes after it was turned on, so the
 * matches closed before it never got theirs). It is mailOne without the wait
 * for the PDF: the same recipients, the approval's PDF if it is there, else
 * the mail without it (saying that it follows), whatever the switch and
 * whenever the match closed. A close already mailed is mailed again to
 * everyone (a resend, so marked in the audit); one whose round is still open
 * (pending, deferred) is finished. Test, beach, numberless and released
 * matches are refused as the sweep leaves them out. The row in
 * match_final_mails is the sweep's, so the sweep does not mail it again; what
 * the manual send leaves to do (the PDF that follows, a deferred round) the
 * sweep finishes while the switch is on, also for a close before the switch
 * (the audit entry match.final_mail_manual marks it, up to LATE_PDF_DAYS).
 *
 * Addresses are never logged or stored (match_final_mails counts them;
 * `delivered` holds hashes of round, match, close and address while a round
 * is open); the audit entry (match.final_mail) names how many went out.
 *
 * Technical remarks (owner 2026-11-22; frontend domain/technicalRemarks.js):
 * a match of that remarks model (match_info.remarks_model >= 2) keeps them
 * off its scoresheet, so the mail's text lists them (technicalRemarkLines):
 * every entry of its correction log (manual_changes, the sentence the app
 * wrote) and every event line written as one (payload.remarkTo 'technical',
 * payload.autoRemark; an injury substitution with a legal substitute, a
 * bench injury, in the rules' words), oldest first, with the time in Zurich.
 * Plain text, the dates of a date-of-birth correction taken out, at most
 * MAX_TECHNICAL_LINES. An older match prints them on its sheet: none listed.
 *
 * Typed addresses (owner decision 4 on SEC-11, audit 26.11): an address that
 * comes only from the match setup (a typed referee or team contact address)
 * and is neither an account of the close (the scorer), a
 * confirmed active account, nor a club's contact gets the official mail and
 * the PDF with a fixed text: no technical remarks (the scorer's free text),
 * the schedule's team names (a game outside the schedule: the typed names
 * without anything that reads as a link or an address) and the result only
 * as a score. The accounts and the clubs' contacts get it as before. The
 * sweep mails at most MAX_TYPED_PER_CLOSER_DAY typed addresses per closing
 * account (closed_by, else the creator) and day; the rest of a close wait:
 * the others get the mail at once, the close's round stays open (deferred)
 * until the closing account's day ends, and the next sweep after it mails
 * them, within that day's cap again, up to LATE_PDF_DAYS after the close
 * (2611 review, SR-2: they were left out of the close for good). The audit
 * entry comes when the round ends. An admin's closes and an admin's Send now
 * are not capped.
 */

import { createHash } from 'node:crypto'
import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { ADMIN_ROLES } from './access.js'
import { MAIL_BUDGET_OF, pickLang, withoutLinks } from './mailer.js'
import { connectClient } from './pgClient.js'
import { EMAIL_RE } from './emailAddress.js'
import { redactRemarkDobs } from './publicColumns.js'

export const DELAY_MS = 2 * 60 * 1000
// No PDF of the approval this long after the close: mailed without it
export const PDF_GRACE_MS = 2 * 60 * 60 * 1000
/** How long a close's mail waits for the server's vector copy of the sheet (then it takes the newest PDF there is). */
export const VECTOR_HOLD_MS = 25 * 60 * 1000
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
// Typed addresses (see the header) one closing account's closes mail per day
// in the sweep: a club's busiest home day is about 10 games of 4 typed addresses
export const MAX_TYPED_PER_CLOSER_DAY = 40
// Technical remarks in a final mail: at most this many lines (and one "+n"
// line) of at most this many characters (the mail's list takes 40 lines of
// 200 characters, lib/mailer.js cleanVar)
export const MAX_TECHNICAL_LINES = 39
const MAX_TECHNICAL_CHARS = 190
// The remarks model whose technical remarks stay off the scoresheet (frontend domain/technicalRemarks.js REMARKS_MODEL)
const TECHNICAL_REMARKS_MODEL = 2
const BATCH = 20
const MAX_PER_SWEEP = 200
export const TEST_PDF_MAX_BYTES = 5 * 1024 * 1024
// The largest attachment a final mail carries (mail servers refuse bigger)
export const MAIL_PDF_MAX_BYTES = 10 * 1024 * 1024
// one strict address (lib/emailAddress.js)
// An address without an account (a typed referee address, a club's contact):
// who reads it is not known, so English, the app's binding language (owner,
// 2026-10-29; FINAL_MAIL_LANG overrides, e.g. de)
const DEFAULT_LANG = 'en'
// An address is unconfirmed when the users table tracks confirmation and it is NULL
const UNCONFIRMED_SQL = `((to_jsonb(u) ? 'email_confirmed_at') AND (to_jsonb(u) ->> 'email_confirmed_at') IS NULL)`
// A deactivated account (db/027 banned_until) is told nothing (as lib/signupNotices.js)
const ACTIVE_SQL = `coalesce((to_jsonb(u) ->> 'banned_until')::timestamptz <= now(), true)`

// One close of a match as the mail reads it (dueCloses, closeOf): the match,
// its row in match_final_mails, whether an earlier close was mailed
// (corrected) and the last admin reopen before it
const CLOSE_COLUMNS = `m.id, m.external_id, m.game_n, m.closed_at, m.closed_at::text AS closed_at_exact, m.closed_by, m.created_by, m.scheduled_at, m.updated_at, m.created_at,
              m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name, m.match_info->>'league' AS league,
              m.officials, to_jsonb(m) ->> 'final_score' AS final_score,
              m.manual_changes, m.match_info->>'remarks_model' AS remarks_model,
              f.outcome, coalesce(f.attempts, 0) AS attempts, coalesce(f.delivered, '{}') AS delivered, f.recipients AS mailed,
              EXISTS (SELECT 1 FROM public.match_final_mails p WHERE p.match_id = m.id AND p.closed_at < m.closed_at AND p.recipients > 0) AS corrected,
              (SELECT max(a.at) FROM public.audit_log a WHERE a.action = 'match.reopen' AND a.match_id = m.id AND a.at <= m.closed_at) AS reopened_at`
const CLOSE_FROM = `FROM public.matches m
         LEFT JOIN public.match_final_mails f ON f.match_id = m.id AND f.closed_at = m.closed_at`
// An official match the mail is for: indoor, not a test, a game number, not released
const OFFICIAL_SQL = `m.test IS NOT TRUE AND (m.sport_type IS NOT DISTINCT FROM 'beach') IS NOT TRUE
          AND m.game_n > 0
          AND NOT (m.official_game_exempt AND m.released_at IS NOT NULL)`
// The outcomes of a round still open: a manual send finishes it (no resend)
const OPEN_ROUND = ['pending', 'deferred']

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

/** HH:MM in Zurich of a date-like value; '' when there is none. */
function zurichClock (v) {
  const d = v instanceof Date ? v : new Date(v)
  if (!v || Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}

/**
 * The technical remarks a final mail lists (see the header): [] for a match
 * of an older remarks model. `manualChanges`: the match's manual_changes;
 * `eventLines`: [{ ts, line }] of its live events written as technical remarks.
 * Pure; never throws.
 */
export function technicalRemarkLines ({ remarksModel, manualChanges, eventLines } = {}) {
  if (!(Number(remarksModel) >= TECHNICAL_REMARKS_MODEL)) return []
  const items = []
  let order = 0
  const push = (ts, raw) => {
    if (typeof raw !== 'string') return
    const text = redactRemarkDobs(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_TECHNICAL_CHARS)
    if (!text) return
    const ms = Date.parse(ts)
    items.push({ ms: Number.isFinite(ms) ? ms : null, ts, text, order: order++ })
  }
  for (const c of Array.isArray(manualChanges) ? manualChanges : []) {
    if (!c || typeof c !== 'object') continue
    push(c.ts, typeof c.text === 'string' && c.text.trim() ? c.text : c.description)
  }
  for (const e of Array.isArray(eventLines) ? eventLines : []) push(e?.ts, e?.line)
  items.sort((a, b) => {
    if (a.ms !== null && b.ms !== null && a.ms !== b.ms) return a.ms - b.ms
    if ((a.ms === null) !== (b.ms === null)) return a.ms === null ? 1 : -1
    return a.order - b.order
  })
  const lines = items.map((x) => {
    const clock = zurichClock(x.ts)
    return clock ? `${clock} ${x.text}` : x.text
  })
  if (lines.length <= MAX_TECHNICAL_LINES) return lines
  return [...lines.slice(0, MAX_TECHNICAL_LINES), `… (+${lines.length - MAX_TECHNICAL_LINES})`]
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

/** The teams' contact addresses typed in the match setup or Edit match info (officials JSON: role 'team contact'). */
export function teamContactAddresses (officials) {
  const list = Array.isArray(officials) ? officials : []
  return ['home', 'away']
    .map((team) => list.find((o) => o && String(o.role || '').toLowerCase() === 'team contact' && o.team === team)?.email)
    .filter((e) => typeof e === 'string' && e.trim())
}

/** The referees' addresses typed in the match setup (officials JSON): the first 1st and the first 2nd referee. */
export function refereeAddresses (officials) {
  const list = Array.isArray(officials) ? officials : []
  return ['1st referee', '2nd referee'].map((role) => list.find((o) => o && o.role === role)?.email).filter(Boolean)
}

/**
 * A match's typed team name as a typed address's mail shows it (see the
 * header): one line, no control or bidi characters, nothing that reads as a
 * link or an address, at most 80 characters. Pure.
 */
export function linkFreeText (raw, max = 80) {
  return withoutLinks(raw).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** A final score as a typed address's mail shows it ("3-1", "3:1"); '' for anything else. */
export function plainResult (raw) {
  const s = String(raw ?? '').trim()
  return /^[0-9]{1,2} ?[-:] ?[0-9]{1,2}$/.test(s) ? s : ''
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

  /**
   * PUT /api/settings { send_final_email }. changed_at is when the switch was
   * turned on: it moves only when it goes from off to on (SEC-12). Saving the
   * same value again (a stale tab) or turning it off leaves it, so the closes
   * after it that are still on their way (waiting for the PDF, deferred, the
   * PDF to follow) are not left out by a later save.
   */
  async function setSettings ({ actorId, body } = {}) {
    if (!body || typeof body.send_final_email !== 'boolean') return invalid('send_final_email: true or false')
    const client = await connectClient(pool, log)
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.app_settings (id, send_final_email, changed_by, changed_at) VALUES (true, $1, $2, CASE WHEN $1 THEN now() END)
         ON CONFLICT (id) DO UPDATE SET send_final_email = EXCLUDED.send_final_email, changed_by = EXCLUDED.changed_by,
           changed_at = CASE WHEN EXCLUDED.send_final_email AND (app_settings.send_final_email IS NOT TRUE OR app_settings.changed_at IS NULL)
                             THEN now() ELSE app_settings.changed_at END`,
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

  /**
   * The addresses of one close (see the header), with the accounts'
   * languages: [{ address, lang, typed }]. typed: an address of the match
   * setup only, of no account (the header's typed addresses). `game`: scheduleOf.
   */
  async function recipientsOf (m, game) {
    const { rows: accounts } = await pool.query(
      `SELECT lower(u.email) AS email, u.raw_user_meta_data->>'mail_lang' AS lang FROM auth.users u
        WHERE u.id = $1`,
      [isUuid(m.closed_by) ? m.closed_by : null])
    let others = []
    let clubContacts = []
    const typedRaw = []
    if (game) {
      // the clubs of the schedule's two teams: the club each team name is
      // recorded for (a team plays for one club, db/018), by its id
      const { rows: clubs } = await pool.query(
        `SELECT c.contact_email AS email FROM public.clubs c
          WHERE c.contact_email IS NOT NULL
            AND c.id IN (SELECT ct.club_id FROM public.club_teams ct WHERE lower(btrim(ct.team_name)) = ANY($1::text[]))
          ORDER BY c.id`, [[game.home, game.away].map((n) => n.toLowerCase())])
      clubContacts = clubs.map((r) => r.email)
      typedRaw.push(...refereeAddresses(m.officials))
      others = [...refereeAddresses(m.officials), ...clubContacts]
    }
    // the teams' own contacts: every official match (not only schedule games)
    typedRaw.push(...teamContactAddresses(m.officials))
    others = [...others, ...teamContactAddresses(m.officials)]
    const to = withLangs(accounts, others)
    // typed: only from the match setup, and no account of the close nor a club's contact
    const known = new Set(recipientList([...accounts.map((r) => r.email), ...clubContacts]))
    const typed = new Set(recipientList(typedRaw).filter((a) => !known.has(a) && to.some((x) => x.address === a)))
    if (typed.size) {
      // a confirmed, active account's address is no stranger's (SEC-11)
      const { rows } = await pool.query(
        `SELECT lower(u.email) AS email FROM auth.users u
          WHERE lower(u.email) = ANY($1::text[]) AND NOT ${UNCONFIRMED_SQL} AND ${ACTIVE_SQL}
            AND (to_jsonb(u) ->> 'deleted_at') IS NULL`, [[...typed]])
      for (const r of rows) typed.delete(r.email)
    }
    return to.map((x) => ({ ...x, typed: typed.has(x.address) }))
  }

  // Typed addresses mailed per closing account in the sweep (MAX_TYPED_PER_CLOSER_DAY): id -> { start, n }
  const typedSent = new Map()
  const typedUsed = (key) => {
    const e = typedSent.get(key)
    return e && now() - e.start < DAY_MS ? e.n : 0
  }
  // when the closing account's day of typed addresses ends (now, when none is counted)
  const typedResetAt = (key) => {
    const e = typedSent.get(key)
    return e && now() - e.start < DAY_MS ? e.start + DAY_MS : now()
  }
  function useTyped (key, n) {
    if (!n) return
    const t = now()
    if (typedSent.size >= 10_000) for (const [k, e] of typedSent) if (t - e.start >= DAY_MS) typedSent.delete(k)
    const e = typedSent.get(key)
    if (e && t - e.start < DAY_MS) e.n += n
    else typedSent.set(key, { start: t, n })
  }

  /**
   * The sweep's cap on typed addresses (see the header): `to` without the
   * typed addresses over the closing account's daily allowance that this
   * close has not reached yet ({ to, capped, closer, retryAt }: retryAt, when
   * the held ones may go, the end of the closing account's day). An admin's
   * close is not capped.
   */
  async function withinTypedCap (m, to, reachedBefore) {
    const fresh = to.filter((x) => x.typed && !reachedBefore(x))
    const closer = isUuid(m.closed_by) ? m.closed_by : isUuid(m.created_by) ? m.created_by : `match:${m.id}`
    if (!fresh.length) return { to, capped: 0, closer }
    const left = Math.max(0, MAX_TYPED_PER_CLOSER_DAY - typedUsed(closer))
    if (fresh.length <= left) return { to, capped: 0, closer }
    if (isUuid(closer)) {
      const { rows: [p] } = await pool.query('SELECT p.roles && $2::text[] AS admin FROM public.profiles p WHERE p.user_id = $1 LIMIT 1', [closer, [...ADMIN_ROLES]])
      if (p?.admin === true) return { to, capped: 0, closer }
    }
    const hold = new Set(fresh.slice(left).map((x) => x.address))
    return { to: to.filter((x) => !hold.has(x.address)), capped: hold.size, closer, retryAt: typedResetAt(closer) }
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

  /** A close's technical remarks (technicalRemarkLines); [] when they cannot be read (the mail goes without them). */
  async function technicalOf (m) {
    if (!(Number(m.remarks_model) >= TECHNICAL_REMARKS_MODEL)) return []
    try {
      const { rows } = await pool.query(
        `SELECT e.ts, e.payload->>'autoRemark' AS line FROM public.events e
          WHERE e.match_id = $1 AND e.voided_at IS NULL AND e.payload->>'remarkTo' = 'technical'
          ORDER BY e.set_index, e.seq LIMIT 500`, [m.id])
      return technicalRemarkLines({ remarksModel: m.remarks_model, manualChanges: m.manual_changes, eventLines: rows })
    } catch (err) {
      log.warn?.(`[final-mail] match ${m.id}: its technical remarks could not be read: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
      return technicalRemarkLines({ remarksModel: m.remarks_model, manualChanges: m.manual_changes, eventLines: [] })
    }
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

  /**
   * One due close: mailed (with or without the PDF), recorded, or left for a
   * later sweep. `manual` (sendNow): no wait for the PDF, and no audit entry
   * of its own (sendNow writes match.final_mail_manual); `info` gets what went
   * out ({ recipients, reached, pdf }, counts only).
   */
  async function mailOne (m, ctx, { manual = false, info = {} } = {}) {
    const t = now()
    const late = m.outcome === 'sent_no_pdf' // mailed without the PDF: the PDF is what is still to go
    // The server's vector copy of the sheet is on its way (lib/scoresheets.js
    // queueVectorCopy, field-spec 17.20): the mail carries it, not the device's
    // picture of the sheet. At most VECTOR_HOLD_MS after the close.
    if (!manual && !late && typeof scoresheets.vectorPending === 'function' && scoresheets.vectorPending(m.id) &&
        t - new Date(m.closed_at).getTime() < VECTOR_HOLD_MS) {
      await save(m, { outcome: m.outcome || 'pending', attempts: m.attempts, delivered: m.delivered, nextTryAt: t + RECHECK_MS })
      return 'later'
    }
    const pdf = await approvalPdf(m)
    info.pdf = !!pdf
    if (!pdf && (late || (!manual && t - new Date(m.closed_at).getTime() < PDF_GRACE_MS))) {
      await save(m, { outcome: m.outcome || 'pending', attempts: m.attempts, delivered: m.delivered, nextTryAt: t + (late ? LATE_RECHECK_MS : RECHECK_MS) })
      return 'later'
    }
    const game = await scheduleOf(m.game_n)
    // Each address gets the mail with the PDF once ('pdf'); while there is
    // none, the mail without it once ('nopdf'), and then the PDF on its own
    const done = new Set(m.delivered)
    const has = (round, x) => done.has(reachedKey(round, m, x.address))
    const reachedOne = (x) => has('pdf', x) || has('nopdf', x)
    let to = await recipientsOf(m, game)
    // the sweep: typed addresses within the closing account's daily cap (SEC-11)
    const cap = manual ? { to, capped: 0, closer: null } : await withinTypedCap(m, to, reachedOne)
    to = cap.to
    // held ones wait for the closing account's next day (SR-2), up to LATE_PDF_DAYS after the close
    const holding = cap.capped > 0 && t - new Date(m.closed_at).getTime() < LATE_PDF_DAYS * DAY_MS
    const holdUntil = holding ? Math.max(cap.retryAt ?? t, t + DEFER_MS) : null
    if (cap.capped) log.warn?.(`[final-mail] match ${m.id}: ${cap.capped} typed address(es) ${holding ? `held until ${new Date(holdUntil).toISOString()}` : 'left out'}, the closing account's ${MAX_TYPED_PER_CLOSER_DAY} a day are used up`)
    info.recipients = to.length
    info.reached = 0
    if (!to.length) {
      if (holding) {
        await save(m, { outcome: 'deferred', recipients: m.mailed ?? 0, attempts: m.attempts, delivered: m.delivered, nextTryAt: holdUntil })
        return 'deferred'
      }
      await save(m, { outcome: 'no_recipients', recipients: 0 })
      return 'no_recipients'
    }
    const vars = {
      teams: game ? `${game.home} – ${game.away}` : `${m.home_name || '?'} – ${m.away_name || '?'}`,
      game: String(m.game_n),
      date: zurichDate(m.scheduled_at || m.closed_at),
      result: m.final_score || '',
      corrected: m.corrected === true,
      pdf: !!pdf,
      // a list of one-line texts (lib/mailer.js cleanVar)
      technical: (await technicalOf(m)).map((line) => ({ line }))
    }
    // A typed address (see the header): the fixed text, none of the scorer's own
    const typedVars = {
      ...vars,
      teams: game ? vars.teams : `${linkFreeText(m.home_name) || '?'} – ${linkFreeText(m.away_name) || '?'}`,
      result: plainResult(m.final_score),
      technical: []
    }
    const typedBefore = new Set(to.filter((x) => x.typed && reachedOne(x)).map((x) => x.address))
    const r = await deliver('scoresheet', to, (x) => {
      if (has('pdf', x) || (!pdf && has('nopdf', x))) return null
      const v = x.typed ? typedVars : vars
      return pdf
        ? { key: reachedKey('pdf', m, x.address), vars: { ...v, late: has('nopdf', x) }, attachments: [{ filename: pdf.filename, content: pdf.data }] }
        : { key: reachedKey('nopdf', m, x.address), vars: v }
    }, done, ctx)
    if (!manual) useTyped(cap.closer, to.filter((x) => x.typed && reachedOne(x) && !typedBefore.has(x.address)).length)
    const reached = to.filter(reachedOne).length
    info.reached = reached
    const recipients = late ? Math.max(m.mailed ?? 0, reached) : reached
    const auditMail = (details) => manual ? null : audit(pool, { actorId: null, action: 'match.final_mail', matchId: m.id, details: { ...details, corrected: m.corrected === true, game_n: m.game_n ?? null, ...(cap.capped ? { capped: cap.capped } : {}) } })
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
      if (holding) {
        // everyone within the cap has it; the round stays open for the held ones
        await save(m, { outcome: 'deferred', recipients, attempts: m.attempts, delivered: [...done], nextTryAt: holdUntil })
        return 'deferred'
      }
      await save(m, { outcome: 'sent', recipients })
      await auditMail({ recipients: to.length, pdf: true, ...(late ? { late_pdf: true } : {}) })
      return 'sent'
    }
    await save(m, { outcome: 'sent_no_pdf', recipients, delivered: [...done], nextTryAt: t + LATE_RECHECK_MS })
    await auditMail({ recipients, pdf: false })
    await tellNoPdf(m, vars, ctx)
    return 'sent_no_pdf'
  }

  /**
   * The closes due now, the longest due first, without the matches `seen`.
   * Only a close the sweep has not started (no match_final_mails row) must
   * be after the switch was turned on (never the backlog); one already on
   * its way (waiting for the PDF, deferred, the PDF to follow) is finished
   * whatever the switch did since, up to LATE_PDF_DAYS (SEC-12).
   */
  async function dueCloses (changedAt, seen) {
    const t = now()
    const { rows } = await pool.query(
      `SELECT ${CLOSE_COLUMNS}
         ${CLOSE_FROM}
        WHERE m.closed_at IS NOT NULL
          AND m.closed_at <= $3::timestamptz
          AND ((f.match_id IS NULL AND m.closed_at >= greatest($1::timestamptz, $2::timestamptz))
               OR (f.match_id IS NOT NULL AND m.closed_at >= $2::timestamptz)
               -- a close an admin mailed by hand (sendNow): finished whenever it closed
               OR (f.match_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.audit_log a
                    WHERE a.action = 'match.final_mail_manual' AND a.match_id = m.id AND a.at >= m.closed_at AND a.at >= $2::timestamptz)))
          AND ${OFFICIAL_SQL}
          AND ((f.match_id IS NULL AND m.closed_at >= $4::timestamptz)
               OR (f.outcome IN ('pending', 'deferred', 'sent_no_pdf') AND f.next_try_at <= $5::timestamptz))
          AND m.id <> ALL($6::uuid[])
        ORDER BY coalesce(f.next_try_at, m.closed_at), m.id
        LIMIT ${BATCH}`,
      [changedAt, iso(t - LATE_PDF_DAYS * DAY_MS), iso(t - DELAY_MS), iso(t - LOOKBACK_MS), iso(t), seen])
    return rows
  }

  /** One match's current close as dueCloses reads it, with why the mail would leave it out; null: no such match. */
  async function closeOf (matchId) {
    const { rows: [m] } = await pool.query(
      `SELECT ${CLOSE_COLUMNS}, f.at AS mail_at, m.test IS TRUE AS is_test,
              (m.sport_type IS NOT DISTINCT FROM 'beach') AS is_beach,
              coalesce(m.official_game_exempt AND m.released_at IS NOT NULL, false) AS is_released,
              (SELECT max(a.at) FROM public.audit_log a
                WHERE a.match_id = m.id AND a.at >= m.closed_at
                  AND (a.action = 'match.final_mail' OR (a.action = 'match.final_mail_manual' AND a.details->>'outcome' IN ('sent', 'sent_no_pdf')))) AS sent_at
         ${CLOSE_FROM}
        WHERE m.id = $1`, [matchId])
    return m || null
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
      return out
    } catch (err) {
      log.error?.(`[final-mail] sweep failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return { error: true }
    } finally {
      running = false
    }
  }

  /** Why the mail leaves a close out (the sweep's rule, OFFICIAL_SQL), or null. */
  function refusalOf (m) {
    if (!m.closed_at) return fail(409, 'OV_NOT_CLOSED', 'This match is not closed')
    const reason = m.is_test ? 'test' : m.is_beach ? 'beach' : !(Number(m.game_n) > 0) ? 'no_game_number' : m.is_released ? 'released' : null
    return reason ? fail(409, 'OV_FINAL_MAIL_REFUSED', 'The final mail is only for official matches', { reason }) : null
  }

  /** What the console shows of a close's mail (match_final_mails; counts only). */
  const stateOf = (m) => ({
    outcome: m.outcome ?? null,
    recipients: m.mailed ?? 0,
    sent_at: iso(m.sent_at),
    updated_at: iso(m.mail_at)
  })

  /**
   * GET /api/admin/matches/:id/final-mail (admins): the mail of the match's
   * latest close: its state, and what "Send now" would send: how many
   * addresses (never one) and whether the approval's PDF is there.
   */
  async function status ({ matchId } = {}) {
    if (!isUuid(matchId)) return notFound()
    try {
      const m = await closeOf(matchId)
      if (!m) return notFound()
      const settings = await readSettings()
      const base = { mail: mailer?.enabled === true, switch_on: settings.send_final_email, closed_at: iso(m.closed_at), state: stateOf(m) }
      const refused = refusalOf(m)
      if (refused) return ok({ ...base, sendable: false, reason: refused.body.error.details?.reason || 'not_closed', recipients: 0, pdf: false })
      const to = await recipientsOf(m, await scheduleOf(m.game_n))
      const pdf = await approvalPdf(m)
      return ok({ ...base, sendable: true, reason: null, recipients: to.length, pdf: !!pdf, resend: (m.mailed ?? 0) > 0 && !OPEN_ROUND.includes(m.outcome) })
    } catch (err) {
      log.error?.(`[final-mail] status failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /**
   * POST /api/admin/matches/:id/final-mail (admins): the mail of the match's
   * latest close now (see the header): mailOne without the wait for the PDF,
   * whatever the switch. Audited match.final_mail_manual (counts, never an
   * address). { outcome, recipients, reached, pdf, resend }
   */
  async function sendNow ({ actorId, matchId } = {}) {
    if (!isUuid(matchId)) return notFound()
    if (!mailer?.enabled) return fail(503, 'OV_MAIL_UNAVAILABLE', 'Email is not available on this server')
    // one at a time with the sweep: nobody mailed twice by two rounds at once
    if (running) return fail(409, 'OV_FINAL_MAIL_BUSY', 'The mails are being sent, try again in a moment')
    running = true
    try {
      const m = await closeOf(matchId)
      if (!m) return notFound()
      const refused = refusalOf(m)
      if (refused) return refused
      // a round still open is finished; any other (a close already mailed, given up, or never) starts again for everyone
      const resend = (m.mailed ?? 0) > 0 && !OPEN_ROUND.includes(m.outcome)
      const close = OPEN_ROUND.includes(m.outcome) ? m : { ...m, outcome: null, attempts: 0, delivered: [] }
      const info = {}
      const outcome = await mailOne(close, { held: new Set() }, { manual: true, info })
      await audit(pool, {
        actorId,
        action: 'match.final_mail_manual',
        matchId: m.id,
        details: { outcome, recipients: info.recipients ?? 0, reached: info.reached ?? 0, pdf: info.pdf === true, resend, corrected: m.corrected === true, game_n: m.game_n ?? null }
      })
      const after = await closeOf(matchId)
      return ok({ outcome, recipients: info.recipients ?? 0, reached: info.reached ?? 0, pdf: info.pdf === true, resend, state: stateOf(after || m) })
    } catch (err) {
      log.error?.(`[final-mail] manual send failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
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

  return { enabled: mailer?.enabled === true, getSettings, setSettings, sweep, testMail, status, sendNow }
}
