/**
 * signupNotices — "a new account signed up", to the people who approve it
 * (db/027 notifications, lib/mailer.js kind 'signup').
 *
 * Owner, 2026-11-11: "why i don't get emails when there's a new signup";
 * decisions: the admins AND the approvers of the account's requests; on every
 * sign-up; as a mail and as a notification in the manager.
 *
 * When: once the address is confirmed (lib/auth.js onAccountConfirmed: the
 * confirmation link, or at sign-up when the server confirms at once). An
 * address nobody confirmed tells nobody, so a made-up sign-up sends no mail.
 *
 * Who (the cascade of lib/accountRequests.js):
 *   admins          every sign-up, with all its parts; page accounts/<id>
 *   club managers   sign-ups with a scorer, team manager or club manager part
 *                   of their club; those parts; page myclub/<club id>
 *   team managers   sign-ups with a team manager part of their team; those
 *                   parts; page myteams/<team id>
 * One notice per person (an admin who also manages the club gets the admin's).
 * Never the new account itself. An OpenBeach sign-up asks for nothing: its
 * admins only, in the OpenBeach manager (app 'beach').
 *
 * The mail goes in the recipient's own language (mail_lang of its sign-up),
 * on the mailer's 'notify' budget. A notice row is stored even when the mail
 * is dropped or fails. Without db/027 the mails still go out.
 *
 * Public API:
 *   createSignupNotices({ pool, mailer, logger })
 *     notify(userId)                 -> { recipients, mailed }  (never throws)
 *     list({ userId, app })          -> { status, body }  GET /api/notifications?app=
 *     markRead({ userId, app, body }) -> { status, body } POST /api/notifications/read { ids } | { all: true }
 */
import { invalid, isUuid, ok, unavailable } from './accounts.js'
import { ADMIN_ROLES } from './access.js'
import { mailApp, maskEmail, describeMailError } from './mailer.js'

// No db/025 / db/027 yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])
// Notices kept this long (deleted when the list is read)
export const KEEP_DAYS = 90
// The most notices a list answers
export const LIST_LIMIT = 50
const MAX_READ_IDS = 100

const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const REQUEST_ORDER = ['scorer', 'referee', 'team_manager', 'club_manager']
const byKind = (a, b) => REQUEST_ORDER.indexOf(a.kind) - REQUEST_ORDER.indexOf(b.kind) ||
  String(a.club || '').localeCompare(String(b.club || '')) || String(a.team || '').localeCompare(String(b.team || ''))

/**
 * The recipients of one sign-up: [{ userId, email, lang, admin, target, parts }].
 * `parts`: [{ kind, club_id, club, team_id, team }] of the account (all of
 * them); admins: [{ user_id, email, lang }]; clubManagers / teamManagers:
 * [{ user_id, email, lang, club_id | team_id }]. Pure, for the tests.
 */
export function recipientsOf ({ userId, parts = [], admins = [], clubManagers = [], teamManagers = [] }) {
  const out = new Map()
  const strip = (p) => ({ kind: p.kind, club: p.club ?? null, team: p.team ?? null })
  for (const a of admins) {
    if (a.user_id === userId || !a.email || out.has(a.user_id)) continue
    out.set(a.user_id, { userId: a.user_id, email: a.email, lang: a.lang || null, admin: true, target: `accounts/${userId}`, parts: parts.map(strip).sort(byKind) })
  }
  // a club's managers decide its scorer, team manager and club manager parts
  for (const m of clubManagers) {
    if (m.user_id === userId || !m.email || out.has(m.user_id)) continue
    const mine = parts.filter((p) => p.club_id === m.club_id && p.kind !== 'referee')
    if (!mine.length) continue
    out.set(m.user_id, { userId: m.user_id, email: m.email, lang: m.lang || null, admin: false, target: `myclub/${m.club_id}`, parts: mine.map(strip).sort(byKind) })
  }
  // a team's managers its team manager parts
  for (const m of teamManagers) {
    if (m.user_id === userId || !m.email || out.has(m.user_id)) continue
    const mine = parts.filter((p) => p.team_id === m.team_id && p.kind === 'team_manager')
    if (!mine.length) continue
    out.set(m.user_id, { userId: m.user_id, email: m.email, lang: m.lang || null, admin: false, target: `myteams/${m.team_id}`, parts: mine.map(strip).sort(byKind) })
  }
  return [...out.values()]
}

export function createSignupNotices ({ pool, mailer = null, logger = console } = {}) {
  const log = logger

  async function partsOf (userId) {
    try {
      const { rows } = await pool.query(
        `SELECT r.kind, r.club_id, c.name AS club, r.team_id, ct.team_name AS team
           FROM public.account_requests r
           LEFT JOIN public.clubs c ON c.id = r.club_id
           LEFT JOIN public.club_teams ct ON ct.id = r.team_id
          WHERE r.user_id = $1`, [userId])
      return rows
    } catch (err) {
      if (MISSING.has(err?.code)) return []
      throw err
    }
  }

  async function managersOf (table, column, ids) {
    if (!ids.length) return []
    try {
      const { rows } = await pool.query(
        `SELECT m.user_id, m.${column}, u.email, u.raw_user_meta_data->>'mail_lang' AS lang
           FROM public.${table} m JOIN auth.users u ON u.id = m.user_id
          WHERE m.${column} = ANY($1::uuid[])
          ORDER BY m.added_at, m.user_id`, [ids])
      return rows
    } catch (err) {
      if (MISSING.has(err?.code)) return []
      throw err
    }
  }

  /** The signed-up account: its name, address and the app it signed up in. */
  async function accountOf (userId) {
    let rows
    try {
      ({ rows } = await pool.query(
        `SELECT u.email,
                nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS name,
                (SELECT m.app FROM auth.app_memberships m WHERE m.user_id = u.id AND m.joined_via = 'signup' LIMIT 1) AS app
           FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id
          WHERE u.id = $1`, [userId]))
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
      // no db/012: the account counts as indoor
      ;({ rows } = await pool.query(
        `SELECT u.email, nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS name, NULL AS app
           FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id WHERE u.id = $1`, [userId]))
    }
    return rows[0] || null
  }

  async function store (rows) {
    if (!rows.length) return 0
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO public.notifications (user_id, kind, app, subject_user_id, target, details)
         SELECT x.u, 'signup', x.a, x.s, x.t, x.d
           FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::jsonb[]) AS x(u, a, s, t, d)
         ON CONFLICT (user_id, kind, subject_user_id) DO NOTHING`,
        [rows.map((r) => r.userId), rows.map((r) => r.app), rows.map((r) => r.subject), rows.map((r) => r.target), rows.map((r) => JSON.stringify({ parts: r.parts }))])
      return rowCount
    } catch (err) {
      if (MISSING.has(err?.code)) {
        log.warn?.('[notices] db/027 is not applied: the sign-up notices were mailed, not stored')
        return null
      }
      throw err
    }
  }

  /**
   * Tell the admins and approvers that `userId` signed up (and confirmed its
   * address). Stores the notices first: a second call for the same account
   * (a confirmation link opened twice) finds them and mails nobody again.
   */
  async function notify (userId) {
    if (!isUuid(userId)) return { recipients: 0, mailed: 0 }
    try {
      const account = await accountOf(userId)
      if (!account) return { recipients: 0, mailed: 0 }
      const app = mailApp(account.app)
      const parts = app === 'beach' ? [] : await partsOf(userId)
      const { rows: admins } = await pool.query(
        `SELECT p.user_id, u.email, u.raw_user_meta_data->>'mail_lang' AS lang
           FROM public.profiles p JOIN auth.users u ON u.id = p.user_id
          WHERE p.roles && $1::text[]
          ORDER BY u.created_at, p.user_id`, [[...ADMIN_ROLES]])
      const clubIds = [...new Set(parts.filter((p) => p.kind !== 'referee').map((p) => p.club_id).filter(Boolean))]
      const teamIds = [...new Set(parts.filter((p) => p.kind === 'team_manager').map((p) => p.team_id).filter(Boolean))]
      const clubManagers = await managersOf('club_managers', 'club_id', clubIds)
      const teamManagers = await managersOf('team_managers', 'team_id', teamIds)
      const recipients = recipientsOf({ userId, parts, admins, clubManagers, teamManagers })
      if (!recipients.length) return { recipients: 0, mailed: 0 }
      const stored = await store(recipients.map((r) => ({ ...r, app, subject: userId })))
      // all were stored before: this sign-up was told already
      if (stored === 0) return { recipients: recipients.length, mailed: 0 }
      let mailed = 0
      if (mailer?.enabled) {
        const base = typeof mailer.managerUrlFor === 'function' ? mailer.managerUrlFor(app) : mailer.managerUrl
        for (const r of recipients) {
          try {
            const res = await mailer.send('signup', {
              to: r.email,
              lang: r.lang,
              app,
              link: `${String(base || '').replace(/\/+$/, '')}/#${r.target}`,
              vars: { name: account.name || '', email: account.email, admin: r.admin, parts: r.parts }
            })
            if (res?.sent) mailed++
          } catch (err) {
            log.error?.(`[notices] sign-up mail to ${maskEmail(r.email)} failed: ${describeMailError(err)}`)
          }
        }
      }
      log.log?.(`[notices] sign-up ${userId.slice(0, 8)}: ${recipients.length} notified, ${mailed} mailed`)
      return { recipients: recipients.length, mailed }
    } catch (err) {
      log.error?.(`[notices] sign-up notice failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return { recipients: 0, mailed: 0 }
    }
  }

  /**
   * GET /api/notifications?app=indoor|beach: the account's latest notices of
   * that manager, newest first, with the signed-up account's name and address
   * read live, and whether its requests are still open.
   * { notifications: [{ id, kind, created_at, read, target, user, parts, open }], unread }
   */
  async function list ({ userId, app } = {}) {
    if (!isUuid(userId)) return ok({ notifications: [], unread: 0 })
    const a = mailApp(app)
    try {
      await pool.query(`DELETE FROM public.notifications WHERE user_id = $1 AND created_at < now() - interval '${KEEP_DAYS} days'`, [userId])
      const { rows } = await pool.query(
        `SELECT n.id, n.kind, n.created_at, n.read_at, n.target, n.details,
                n.subject_user_id, u.email AS subject_email,
                nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS subject_name,
                EXISTS (SELECT 1 FROM public.account_requests r WHERE r.user_id = n.subject_user_id) AS open
           FROM public.notifications n
           LEFT JOIN auth.users u ON u.id = n.subject_user_id
           LEFT JOIN public.profiles p ON p.user_id = n.subject_user_id
          WHERE n.user_id = $1 AND n.app = $2
          ORDER BY n.created_at DESC, n.id
          LIMIT ${LIST_LIMIT}`, [userId, a])
      const { rows: [c] } = await pool.query(
        'SELECT count(*)::int AS n FROM public.notifications WHERE user_id = $1 AND app = $2 AND read_at IS NULL', [userId, a])
      return ok({
        notifications: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          created_at: iso(r.created_at),
          read: r.read_at != null,
          target: r.target,
          user: r.subject_user_id ? { id: r.subject_user_id, email: r.subject_email ?? null, name: r.subject_name ?? null } : null,
          parts: Array.isArray(r.details?.parts) ? r.details.parts : [],
          open: r.open === true
        })),
        unread: c?.n ?? 0
      })
    } catch (err) {
      // no db/027 (or db/025): no notices
      if (MISSING.has(err?.code)) return ok({ notifications: [], unread: 0 })
      log.error?.(`[notices] list failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /** POST /api/notifications/read { ids: [id] } | { all: true }: marks the account's own notices read. { unread } */
  async function markRead ({ userId, app, body } = {}) {
    if (!isUuid(userId)) return ok({ unread: 0 })
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const a = mailApp(app ?? body.app)
    const all = body.all === true
    const ids = body.ids ?? []
    if (!all) {
      if (!Array.isArray(ids) || ids.length === 0) return invalid('ids: a list of notification ids, or all: true')
      if (ids.length > MAX_READ_IDS) return invalid(`ids: at most ${MAX_READ_IDS}`)
      if (!ids.every(isUuid)) return invalid('ids: notification ids')
    }
    try {
      if (all) {
        await pool.query('UPDATE public.notifications SET read_at = now() WHERE user_id = $1 AND app = $2 AND read_at IS NULL', [userId, a])
      } else {
        await pool.query('UPDATE public.notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
          [userId, ids.map((x) => x.toLowerCase())])
      }
      const { rows: [c] } = await pool.query(
        'SELECT count(*)::int AS n FROM public.notifications WHERE user_id = $1 AND app = $2 AND read_at IS NULL', [userId, a])
      return ok({ unread: c?.n ?? 0 })
    } catch (err) {
      if (MISSING.has(err?.code)) return ok({ unread: 0 })
      log.error?.(`[notices] read failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  return { notify, list, markRead }
}
