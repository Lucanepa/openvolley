/**
 * lib/mailer.js — the account emails of lib/auth.js (password reset, email
 * confirmation, "your password was changed"), sent over SMTP with nodemailer.
 *
 * Configuration (deploy/env.example, README "Account emails"):
 *   SMTP_HOST   e.g. smtp.migadu.com            required to send
 *   SMTP_PASS   the mailbox password (secret)   required to send
 *   SMTP_PORT   465 (implicit TLS, default) or 587 (STARTTLS, required)
 *   SMTP_USER   the mailbox, e.g. noreply@openvolley.app
 *   MAIL_FROM   "OpenVolley <noreply@openvolley.app>" (default: OpenVolley <SMTP_USER>)
 *   MANAGER_URL base of the links (default https://manager.openvolley.app)
 *   MAIL_FROM_BEACH   sender of the OpenBeach mails (default: OpenBeach <the
 *                     address of MAIL_FROM, else SMTP_USER>): the same mailbox
 *   MANAGER_URL_BEACH base of the OpenBeach links (default: follows
 *                     MANAGER_URL, see beachManagerBase; for the default
 *                     MANAGER_URL https://manager-beach.openvolley.app)
 * Without SMTP_HOST or SMTP_PASS the mailer is disabled: lib/auth.js then
 * answers reset-password with 503 "temporarily unavailable" and confirms new
 * accounts at sign-up, exactly as before this module existed.
 *
 * TLS: implicit TLS on 465; on any other port STARTTLS is mandatory
 * (requireTLS), so the password never crosses the wire in clear. Certificates
 * are always verified (TLS 1.2+). Pooled connections, bounded timeouts.
 *
 * Brands (MAIL_BRANDS): OpenVolley ('indoor', unchanged) and OpenBeach
 * ('beach'). One login serves both apps, so the OpenBeach reset and
 * password-changed mails say the password is the one of both apps. The brand
 * of a mail comes from the `app` of the request (mailApp: an allowlist,
 * anything else is indoor), and its link host from this brand table, never
 * from a URL the client sends (~/ov-ops/openbeach-separation-tournaments-PLAN.md
 * 1.5). The tokens work on either manager: both use the same backend.
 *
 * Mails: plain text plus a minimal HTML part, in en/de/fr/it. No tracking, no
 * remote images, no links other than the one action link. Recipients are
 * never logged in full (maskEmail), SMTP error texts neither (describeMailError).
 *
 * Volume (per process, fixed one-hour windows):
 *   - two budgets, so sign-ups cannot starve password resets: "account"
 *     (reset, password_changed) and "confirm" (sign-up / resend confirmation);
 *   - per delivered inbox (inboxKey: plus-tags removed, Gmail dots ignored,
 *     googlemail.com = gmail.com) for reset and confirm mails, so one inbox
 *     cannot be flooded through spelling variants of its address.
 * A mail over a limit is dropped (the request still succeeds, so the answer
 * never tells whether a mail went out), logged, and counted in stats(), which
 * the internal /health body shows.
 *
 * Public API:
 *   mailerFromEnv(env, { logger }) -> mailer      (disabled mailer when not configured)
 *   createMailer(options)          -> mailer
 *   disabledMailer(reason)         -> mailer
 *   mailer.enabled / mailer.reason / mailer.managerUrl / mailer.from (OpenVolley's)
 *   mailer.managerUrlFor(app) / mailer.fromFor(app)   per brand ('indoor' | 'beach')
 *   mailer.send(kind, { to, lang, link, app }) -> Promise<{ sent, skipped? }>   kind: reset | confirm | password_changed
 *                                            skipped: 'budget' | 'inbox' | 'disabled'
 *   mailer.stats()                 -> { enabled, budgets, inboxDropped, failed, lastDropAt, ... }
 *   mailer.close()
 *   renderMail(kind, lang, vars) -> { subject, text, html }   vars: { link, app }
 *   mailApp(raw) -> 'indoor' | 'beach'   (the allowlist of a request's `app`)
 *   pickLang(explicit, acceptLanguage) -> 'en' | 'de' | 'fr' | 'it'
 *   authLink(managerUrl, page, token, lang) -> string
 *   maskEmail(email)
 *   inboxKey(email)                -> the delivered inbox of an address (rate-limit key)
 *   describeMailError(err)         -> loggable text of a send error, addresses masked
 */

import nodemailer from 'nodemailer'

export const MAIL_LANGS = Object.freeze(['en', 'de', 'fr', 'it'])
export const MAIL_KINDS = Object.freeze(['reset', 'confirm', 'password_changed'])
export const DEFAULT_MANAGER_URL = 'https://manager.openvolley.app'
export const DEFAULT_FROM_NAME = 'OpenVolley'
export const DEFAULT_MANAGER_URL_BEACH = 'https://manager-beach.openvolley.app'
export const DEFAULT_FROM_NAME_BEACH = 'OpenBeach'
export const MAIL_APPS = Object.freeze(['indoor', 'beach'])

// The brands of the account mails: the name in the text and signature, and
// the default link host and sender name. Fixed here: a client chooses only
// which one (mailApp), never a host.
export const MAIL_BRANDS = Object.freeze({
  indoor: Object.freeze({ app: 'indoor', name: 'OpenVolley', managerUrl: DEFAULT_MANAGER_URL, fromName: DEFAULT_FROM_NAME }),
  beach: Object.freeze({ app: 'beach', name: 'OpenBeach', managerUrl: DEFAULT_MANAGER_URL_BEACH, fromName: DEFAULT_FROM_NAME_BEACH })
})

/** The brand of a request's `app`: 'beach' for exactly that word (any case), 'indoor' for anything else. */
export function mailApp(raw) {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'beach' ? 'beach' : 'indoor'
}

// Outgoing account mails per hour, all recipients together, per budget:
// protects the mailbox's sending quota and reputation from a spread-out flood
// (100 per hour in total, as before the split). "account" carries the reset
// and password-changed mails, "confirm" the confirmation links: a burst of
// sign-ups uses up only the latter (whose holders can resend later).
export const MAIL_BUDGET_OF = Object.freeze({ reset: 'account', password_changed: 'account', confirm: 'confirm' })
export const DEFAULT_BUDGETS = Object.freeze({ account: 50, confirm: 50 })
// Reset + confirmation mails to one delivered inbox per hour. A real user
// needs at most: a confirmation, three resends, one reset. password_changed
// is not counted (only the inbox's holder can cause it, with a reset link).
export const DEFAULT_MAX_PER_INBOX = 5
const INBOX_CAPPED = new Set(['reset', 'confirm'])
const HOUR_MS = 60 * 60 * 1000

/** Normalizes a language tag to one of MAIL_LANGS, or null. de-CH -> de. */
function langOf(tag) {
  if (typeof tag !== 'string') return null
  const base = tag.trim().toLowerCase().split(/[-_]/)[0]
  return MAIL_LANGS.includes(base) ? base : null
}

/**
 * The mail language: the request's explicit `lang` when supported, else the
 * first supported entry of Accept-Language (by q), else English.
 */
export function pickLang(explicit, acceptLanguage) {
  const direct = langOf(explicit)
  if (direct) return direct
  if (typeof acceptLanguage === 'string' && acceptLanguage.length <= 512) {
    const ranked = acceptLanguage.split(',').map((part, i) => {
      const [tag, ...params] = part.trim().split(';')
      const q = params.map(p => /^\s*q=([0-9.]+)\s*$/.exec(p)).find(Boolean)
      return { lang: langOf(tag), q: q ? Number(q[1]) : 1, i }
    }).filter(e => e.lang && e.q > 0)
    ranked.sort((a, b) => b.q - a.q || a.i - b.i)
    if (ranked.length) return ranked[0].lang
  }
  return 'en'
}

/** "an***@example.ch": enough to follow a log line, not enough to harvest. */
export function maskEmail(email) {
  const s = String(email || '')
  const at = s.lastIndexOf('@')
  if (at <= 0) return '***'
  return s.slice(0, Math.min(2, at)) + '***' + s.slice(at)
}

// Providers that deliver every dot variant of a local part to the same inbox.
const DOTLESS_DOMAINS = new Set(['gmail.com'])
const DOMAIN_ALIASES = Object.freeze({ 'googlemail.com': 'gmail.com' })

/**
 * The inbox an address is delivered to, as a rate-limit key: lower case,
 * "+tag" removed, and for Gmail the dots of the local part dropped and
 * googlemail.com read as gmail.com. Not an address to send to.
 */
export function inboxKey(email) {
  const s = String(email || '').trim().toLowerCase()
  const at = s.lastIndexOf('@')
  if (at <= 0) return s
  let local = s.slice(0, at)
  let domain = s.slice(at + 1).replace(/\.+$/, '')
  domain = DOMAIN_ALIASES[domain] || domain
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (DOTLESS_DOMAINS.has(domain)) local = local.replace(/\./g, '') || local
  return `${local}@${domain}`
}

// Anything shaped like an address inside an error text (SMTP replies quote the
// recipient: "550 5.1.1 <name@domain>: Recipient address rejected").
const ADDRESS_IN_TEXT = /[^\s<>()[\]{}"',;:]+@[^\s<>()[\]{}"',;:]+/g

/**
 * The loggable text of a send error: nodemailer's code, the SMTP reply code
 * and the message with every address masked (maskEmail), at most 300 chars.
 */
export function describeMailError(err) {
  const parts = []
  if (err && typeof err === 'object') {
    if (err.code) parts.push(String(err.code).slice(0, 40))
    if (err.responseCode) parts.push(`SMTP ${String(err.responseCode).slice(0, 5)}`)
  }
  const msg = String((err && typeof err === 'object' ? err.message : err) ?? '')
    .replace(ADDRESS_IN_TEXT, (m) => maskEmail(m))
    .replace(/\s+/g, ' ').trim().slice(0, 300)
  if (msg) parts.push(msg)
  return parts.join(' ') || 'unknown error'
}

/** MANAGER_URL/#reset?token=...&lang=de (the token is in the fragment: never sent to a server). */
export function authLink(managerUrl, page, token, lang) {
  const base = String(managerUrl || DEFAULT_MANAGER_URL).replace(/\/+$/, '')
  const q = new URLSearchParams({ token })
  if (lang) q.set('lang', lang)
  return `${base}/#${page}?${q.toString()}`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ---------------------------------------------------------------------------
// Templates. {link} is the one action link. Each entry: subject, lines before
// the link, the button label, lines after it. German is written for
// Switzerland (ss, no ß).
// ---------------------------------------------------------------------------

const T = {
  reset: {
    en: {
      subject: 'Reset your OpenVolley password',
      before: ['Hello,', 'someone asked to reset the password of your OpenVolley account. If that was you, set a new password here. The link works once and expires in 60 minutes.'],
      button: 'Set a new password',
      after: ['If you did not ask for this, ignore this email: your password stays as it is.']
    },
    de: {
      subject: 'OpenVolley-Passwort zurücksetzen',
      before: ['Hallo', 'Jemand möchte das Passwort Ihres OpenVolley-Kontos zurücksetzen. Wenn Sie das waren, legen Sie hier ein neues Passwort fest. Der Link funktioniert einmal und läuft nach 60 Minuten ab.'],
      button: 'Neues Passwort festlegen',
      after: ['Wenn Sie das nicht waren, ignorieren Sie diese E-Mail: Ihr Passwort bleibt unverändert.']
    },
    fr: {
      subject: 'Réinitialiser votre mot de passe OpenVolley',
      before: ['Bonjour,', 'quelqu’un a demandé à réinitialiser le mot de passe de votre compte OpenVolley. Si c’était vous, choisissez un nouveau mot de passe ici. Le lien fonctionne une seule fois et expire dans 60 minutes.'],
      button: 'Choisir un nouveau mot de passe',
      after: ['Si vous n’avez rien demandé, ignorez cet e-mail : votre mot de passe reste inchangé.']
    },
    it: {
      subject: 'Reimposta la password di OpenVolley',
      before: ['Buongiorno,', 'qualcuno ha chiesto di reimpostare la password del suo account OpenVolley. Se è stato lei, scelga qui una nuova password. Il link funziona una sola volta e scade tra 60 minuti.'],
      button: 'Scegliere una nuova password',
      after: ['Se non ha chiesto nulla, ignori questa e-mail: la sua password resta invariata.']
    }
  },
  confirm: {
    en: {
      subject: 'Confirm your email address for OpenVolley',
      before: ['Hello,', 'thank you for creating an OpenVolley account. Please confirm that this email address is yours. The link works once and expires in 24 hours.'],
      button: 'Confirm my email address',
      after: ['If you did not create an account, ignore this email.']
    },
    de: {
      subject: 'E-Mail-Adresse für OpenVolley bestätigen',
      before: ['Hallo', 'Danke, dass Sie ein OpenVolley-Konto erstellt haben. Bitte bestätigen Sie, dass diese E-Mail-Adresse Ihnen gehört. Der Link funktioniert einmal und läuft nach 24 Stunden ab.'],
      button: 'E-Mail-Adresse bestätigen',
      after: ['Wenn Sie kein Konto erstellt haben, ignorieren Sie diese E-Mail.']
    },
    fr: {
      subject: 'Confirmez votre adresse e-mail pour OpenVolley',
      before: ['Bonjour,', 'merci d’avoir créé un compte OpenVolley. Veuillez confirmer que cette adresse e-mail est bien la vôtre. Le lien fonctionne une seule fois et expire dans 24 heures.'],
      button: 'Confirmer mon adresse e-mail',
      after: ['Si vous n’avez pas créé de compte, ignorez cet e-mail.']
    },
    it: {
      subject: 'Confermi il suo indirizzo e-mail per OpenVolley',
      before: ['Buongiorno,', 'grazie per aver creato un account OpenVolley. Confermi che questo indirizzo e-mail è suo. Il link funziona una sola volta e scade tra 24 ore.'],
      button: 'Confermare l’indirizzo e-mail',
      after: ['Se non ha creato un account, ignori questa e-mail.']
    }
  },
  password_changed: {
    en: {
      subject: 'Your OpenVolley password was changed',
      before: ['Hello,', 'the password of your OpenVolley account was just changed with a reset link, and every device was signed out.'],
      button: null,
      after: ['If that was not you, reset your password again right away and tell your club admin.']
    },
    de: {
      subject: 'Ihr OpenVolley-Passwort wurde geändert',
      before: ['Hallo', 'Das Passwort Ihres OpenVolley-Kontos wurde soeben über einen Zurücksetz-Link geändert, und alle Geräte wurden abgemeldet.'],
      button: null,
      after: ['Wenn Sie das nicht waren, setzen Sie Ihr Passwort sofort erneut zurück und informieren Sie den Admin Ihres Vereins.']
    },
    fr: {
      subject: 'Votre mot de passe OpenVolley a été modifié',
      before: ['Bonjour,', 'le mot de passe de votre compte OpenVolley vient d’être modifié avec un lien de réinitialisation, et tous les appareils ont été déconnectés.'],
      button: null,
      after: ['Si ce n’était pas vous, réinitialisez immédiatement votre mot de passe et prévenez l’admin de votre club.']
    },
    it: {
      subject: 'La sua password di OpenVolley è stata modificata',
      before: ['Buongiorno,', 'la password del suo account OpenVolley è appena stata modificata con un link di reimpostazione e tutti i dispositivi sono stati disconnessi.'],
      button: null,
      after: ['Se non è stato lei, reimposti subito la password e avvisi l’admin del suo club.']
    }
  }
}

// OpenBeach: one login for both apps, so a password mail says the password
// is the one of both (plan 1.5 "Reset mail text"). After the main paragraph.
const SHARED_PASSWORD_NOTE = {
  reset: {
    en: 'This changes the password of your account for OpenVolley and OpenBeach.',
    de: 'Damit ändern Sie das Passwort Ihres Kontos für OpenVolley und OpenBeach.',
    fr: 'Cela modifie le mot de passe de votre compte pour OpenVolley et OpenBeach.',
    it: 'Così modifica la password del suo account per OpenVolley e OpenBeach.'
  },
  password_changed: {
    en: 'Your account works for OpenVolley and OpenBeach: the new password is the one of both apps.',
    de: 'Ihr Konto gilt für OpenVolley und OpenBeach: Das neue Passwort gilt für beide Apps.',
    fr: 'Votre compte est valable pour OpenVolley et OpenBeach : le nouveau mot de passe vaut pour les deux applications.',
    it: 'Il suo account vale per OpenVolley e OpenBeach: la nuova password vale per entrambe le app.'
  }
}

/** The template of `kind` in `lang` for a brand: OpenVolley's as written, OpenBeach's with its name and the shared-password note. */
function templateFor(kind, lang, app) {
  const m = T[kind][lang]
  if (app !== 'beach') return m
  const name = MAIL_BRANDS.beach.name
  const swap = (line) => line.replace(/OpenVolley/g, name)
  const note = SHARED_PASSWORD_NOTE[kind]?.[lang]
  const before = m.before.map(swap)
  if (note) before.push(note)
  return { subject: swap(m.subject), before, button: m.button, after: m.after.map(swap) }
}

/** { subject, text, html } of one account mail. vars: { link } (reset, confirm), { app } ('indoor' default, 'beach'). */
export function renderMail(kind, lang, { link, app } = {}) {
  const set = T[kind]
  if (!set) throw new Error(`mailer: unknown mail kind ${kind}`)
  const brand = MAIL_BRANDS[mailApp(app)]
  const m = templateFor(kind, langOf(lang) || 'en', brand.app)
  if (m.button && !link) throw new Error(`mailer: ${kind} needs a link`)
  const textParts = [...m.before]
  if (m.button) textParts.push(link)
  textParts.push(...m.after, `– ${brand.name}`)
  const text = textParts.join('\n\n') + '\n'

  const p = (s) => `<p style="margin:0 0 16px">${escapeHtml(s)}</p>`
  const button = m.button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#e2001a;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${escapeHtml(m.button)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#57534e;word-break:break-all">${escapeHtml(link)}</p>`
    : ''
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;padding:24px;background:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:24px">' +
    m.before.map(p).join('') + button + m.after.map(p).join('') +
    `<p style="margin:24px 0 0;font-size:13px;color:#78716c">${escapeHtml(brand.name)}</p>` +
    '</div></body></html>'
  return { subject: m.subject, text, html }
}

// ---------------------------------------------------------------------------
// Mailers
// ---------------------------------------------------------------------------

/** Fixed one-hour window counter: take() is false once max mails went out in it. */
function hourlyBudget(max, now = Date.now) {
  let windowStart = now()
  let used = 0
  let dropped = 0 // in this window
  let droppedTotal = 0 // since start
  const roll = () => {
    const t = now()
    if (t - windowStart >= HOUR_MS) { windowStart = t; used = 0; dropped = 0 }
  }
  return {
    max,
    take() {
      roll()
      if (used >= max) { dropped++; droppedTotal++; return false }
      used++
      return true
    },
    /** Gives back a mail that did not go out after all (e.g. its inbox cap). */
    refund() { if (used > 0) used-- },
    get used() { roll(); return used },
    snapshot() {
      roll()
      return { max, used, dropped, droppedTotal, exhausted: used >= max, windowStart: new Date(windowStart).toISOString() }
    }
  }
}

/** Per-inbox counters in fixed one-hour windows; entries expire with their window. */
function inboxCounter(max, now = Date.now) {
  const seen = new Map() // inboxKey -> { start, n }
  let lastPrune = now()
  return {
    max,
    /** False once `key` reached max in its window. Counts only when true. */
    take(key) {
      const t = now()
      if (t - lastPrune >= 60 * 1000 || seen.size > 10_000) {
        for (const [k, e] of seen) if (t - e.start >= HOUR_MS) seen.delete(k)
        lastPrune = t
      }
      let e = seen.get(key)
      if (!e || t - e.start >= HOUR_MS) { e = { start: t, n: 0 }; seen.set(key, e) }
      if (e.n >= max) return false
      e.n++
      return true
    },
    get size() { return seen.size }
  }
}

/** "Name <address>" with the address of `from` ("X <a@b>" or a bare "a@b"); '' when it has none. */
export function brandFrom(name, from) {
  const s = String(from || '').trim()
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s)
  const address = m ? m[1] : (/^[^\s<>]+@[^\s<>]+$/.test(s) ? s : '')
  return address ? `${name} <${address}>` : ''
}

/** A link base from the environment: https (http only on localhost), origin + path without a trailing slash; null when not usable. */
function linkBase(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return null
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * The OpenBeach link base when MANAGER_URL_BEACH is unset, from OpenVolley's
 * (`managerUrl`, already a linkBase):
 *   the default manager.openvolley.app  -> manager-beach.openvolley.app
 *   <origin>/<path>/manager.html        -> <origin>/<path>/manager-beach.html (one site serving both pages)
 *   http://localhost:<port> (dev)       -> http://localhost:<port>/manager-beach.html
 *   anything else                       -> OpenVolley's own manager, with a note to log: the
 *                                          tokens work there too (one backend), only the brand
 *                                          of the page is OpenVolley's. Set MANAGER_URL_BEACH.
 * Returns { url, note } (note: null, or a line for the startup log).
 */
export function beachManagerBase(managerUrl) {
  const base = String(managerUrl || DEFAULT_MANAGER_URL).replace(/\/+$/, '')
  if (base === DEFAULT_MANAGER_URL) return { url: DEFAULT_MANAGER_URL_BEACH, note: null }
  let u
  try { u = new URL(base) } catch { return { url: DEFAULT_MANAGER_URL_BEACH, note: null } }
  if (/\/manager\.html$/.test(u.pathname)) {
    return { url: u.origin + u.pathname.replace(/manager\.html$/, 'manager-beach.html'), note: null }
  }
  if (['localhost', '127.0.0.1'].includes(u.hostname) && (u.pathname === '/' || u.pathname === '')) {
    return { url: `${u.origin}/manager-beach.html`, note: null }
  }
  return {
    url: base,
    note: `MANAGER_URL_BEACH is not set and MANAGER_URL (${base}) is not the default: OpenBeach links go to ${base} (OpenVolley's manager; set MANAGER_URL_BEACH to OpenBeach's manager of this backend)`
  }
}

function isUrl(raw) {
  try { return Boolean(new URL(raw)) } catch { return false }
}

export function disabledMailer(reason = 'not configured') {
  return {
    enabled: false,
    reason,
    managerUrl: DEFAULT_MANAGER_URL,
    managerUrlFor: (app) => MAIL_BRANDS[mailApp(app)].managerUrl,
    fromFor: () => null,
    async send() { return { sent: false, skipped: 'disabled' } },
    stats() { return { enabled: false, reason } },
    close() {}
  }
}

/**
 * The transport options for nodemailer: implicit TLS on 465, mandatory
 * STARTTLS otherwise, certificate checks always on. Exported for the tests.
 */
export function transportOptions({ host, port, user, pass, tls = {}, secure }) {
  // secure: implicit TLS; derived from the port unless given (tests run a
  // TLS sink on a random port).
  const implicit = typeof secure === 'boolean' ? secure : port === 465
  return {
    host,
    port,
    secure: implicit,
    requireTLS: !implicit,
    ignoreTLS: false,
    auth: { user, pass },
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    dnsTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { minVersion: 'TLSv1.2', ...tls, rejectUnauthorized: true, servername: host }
  }
}

/**
 * @param {object} o
 * @param {string} o.host, o.user, o.pass, o.from
 * @param {number} o.port
 * @param {string} [o.managerUrl]
 * @param {string} [o.fromBeach]        OpenBeach sender (default: OpenBeach <the address of o.from>)
 * @param {string} [o.managerUrlBeach]  OpenBeach link base (default DEFAULT_MANAGER_URL_BEACH)
 * @param {object} [o.tls]          extra TLS options (tests: { ca }); rejectUnauthorized stays true
 * @param {boolean} [o.secure]      implicit TLS (default: port === 465)
 * @param {object} [o.transport]    a ready nodemailer-like { sendMail, close } (tests)
 * @param {number} [o.maxPerHour]     every budget at once (tests); else o.budgets
 * @param {{account?: number, confirm?: number}} [o.budgets]  per hour, see DEFAULT_BUDGETS
 * @param {number} [o.maxPerInbox]    reset + confirm mails per inbox and hour
 * @param {object} [o.logger]
 */
export function createMailer(o = {}) {
  const log = o.logger || console
  const port = Number(o.port)
  if (!o.transport) {
    if (!o.host || !o.pass || !o.user) throw new Error('createMailer: host, user and pass are required')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('createMailer: invalid port')
  }
  if (!o.from) throw new Error('createMailer: from is required')
  const transport = o.transport || nodemailer.createTransport(transportOptions({ host: o.host, port, user: o.user, pass: o.pass, tls: o.tls, secure: o.secure }))
  const budgetMax = (name) => {
    const v = o.maxPerHour ?? o.budgets?.[name] ?? DEFAULT_BUDGETS[name]
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_BUDGETS[name]
  }
  const budgets = Object.fromEntries(Object.keys(DEFAULT_BUDGETS).map((name) => [name, hourlyBudget(budgetMax(name), o.now)]))
  const perInbox = inboxCounter(Number.isInteger(o.maxPerInbox) && o.maxPerInbox > 0 ? o.maxPerInbox : DEFAULT_MAX_PER_INBOX, o.now)
  const counters = { sent: 0, failed: 0, inboxDropped: 0, lastDropAt: null, lastFailureAt: null }
  const managerUrl = String(o.managerUrl || DEFAULT_MANAGER_URL).replace(/\/+$/, '')
  const brands = {
    indoor: { from: o.from, managerUrl },
    beach: {
      from: o.fromBeach || brandFrom(DEFAULT_FROM_NAME_BEACH, o.from),
      managerUrl: String(o.managerUrlBeach || DEFAULT_MANAGER_URL_BEACH).replace(/\/+$/, '')
    }
  }
  if (!brands.beach.from) throw new Error('createMailer: no OpenBeach sender (fromBeach)')

  async function send(kind, { to, lang, link, app } = {}) {
    if (!MAIL_KINDS.includes(kind)) throw new Error(`mailer: unknown mail kind ${kind}`)
    if (typeof to !== 'string' || !to.includes('@')) throw new Error('mailer: no recipient')
    const budgetName = MAIL_BUDGET_OF[kind]
    const budget = budgets[budgetName]
    if (!budget.take()) {
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] hourly ${budgetName} budget (${budget.max}) used up; ${kind} mail to ${maskEmail(to)} dropped`)
      return { sent: false, skipped: 'budget' }
    }
    if (INBOX_CAPPED.has(kind) && !perInbox.take(inboxKey(to))) {
      budget.refund()
      counters.inboxDropped++
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] ${perInbox.max} mails per hour to one inbox reached; ${kind} mail to ${maskEmail(to)} dropped`)
      return { sent: false, skipped: 'inbox' }
    }
    const brand = mailApp(app)
    const { subject, text, html } = renderMail(kind, lang, { link, app: brand })
    try {
      await transport.sendMail({
        from: brands[brand].from,
        to,
        subject,
        text,
        html,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        disableFileAccess: true,
        disableUrlAccess: true
      })
    } catch (err) {
      counters.failed++
      counters.lastFailureAt = new Date().toISOString()
      throw err
    }
    counters.sent++
    return { sent: true }
  }

  /** Counters for monitoring (no addresses): the internal /health body shows them. */
  function stats() {
    const b = Object.fromEntries(Object.entries(budgets).map(([k, v]) => [k, v.snapshot()]))
    return {
      enabled: true,
      budgets: b,
      exhausted: Object.keys(b).filter((k) => b[k].exhausted),
      maxPerInbox: perInbox.max,
      inboxDropped: counters.inboxDropped,
      sent: counters.sent,
      failed: counters.failed,
      lastDropAt: counters.lastDropAt,
      lastFailureAt: counters.lastFailureAt
    }
  }

  return {
    enabled: true,
    reason: null,
    managerUrl,
    from: o.from,
    managerUrlFor: (app) => brands[mailApp(app)].managerUrl,
    fromFor: (app) => brands[mailApp(app)].from,
    budgets,
    send,
    stats,
    close() { try { transport.close?.() } catch { /* already closed */ } }
  }
}

/**
 * The mailer described by the environment, or a disabled one (with the reason)
 * when SMTP_HOST or SMTP_PASS is missing or the settings are invalid. Never
 * throws and never logs the password.
 */
export function mailerFromEnv(env = process.env, { logger, tls, maxPerHour, budgets, maxPerInbox } = {}) {
  const host = (env.SMTP_HOST || '').trim()
  const pass = env.SMTP_PASS || ''
  if (!host || !pass) return disabledMailer(!host ? 'SMTP_HOST not set' : 'SMTP_PASS not set')
  const user = (env.SMTP_USER || '').trim()
  if (!user) return disabledMailer('SMTP_USER not set')
  const portText = (env.SMTP_PORT || '').trim() || '465'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) return disabledMailer(`SMTP_PORT is not a port number: ${portText.slice(0, 20)}`)
  const from = (env.MAIL_FROM || '').trim() || (user.includes('@') ? `${DEFAULT_FROM_NAME} <${user}>` : '')
  if (!from) return disabledMailer('MAIL_FROM not set (and SMTP_USER is not an address)')
  const managerRaw = (env.MANAGER_URL || '').trim() || DEFAULT_MANAGER_URL
  const managerUrl = linkBase(managerRaw)
  if (!managerUrl) return disabledMailer(isUrl(managerRaw) ? 'MANAGER_URL must be an https URL' : 'MANAGER_URL is not a URL')
  // OpenBeach: the same mailbox under its own name, links to its own manager.
  // A setting that is given but unusable turns the mailer off (as MANAGER_URL
  // does): never a mail with a wrong sender or link host.
  const fromBeach = (env.MAIL_FROM_BEACH || '').trim() || brandFrom(DEFAULT_FROM_NAME_BEACH, from)
  if (!fromBeach || !fromBeach.includes('@')) return disabledMailer('MAIL_FROM_BEACH is not an address')
  const beachSet = (env.MANAGER_URL_BEACH || '').trim()
  let managerUrlBeach
  let beachNote = null
  if (beachSet) {
    managerUrlBeach = linkBase(beachSet)
    if (!managerUrlBeach) return disabledMailer(isUrl(beachSet) ? 'MANAGER_URL_BEACH must be an https URL' : 'MANAGER_URL_BEACH is not a URL')
  } else {
    // Unset: follow MANAGER_URL, so a dev / test / staging backend never
    // mails OpenBeach links to the production manager (which does not know
    // its tokens).
    const derived = beachManagerBase(managerUrl)
    managerUrlBeach = derived.url
    beachNote = derived.note
  }
  try {
    const mailer = createMailer({ host, port, user, pass, from, managerUrl, fromBeach, managerUrlBeach, logger, tls, maxPerHour, budgets, maxPerInbox })
    if (beachNote) mailer.warnings = [beachNote]
    return mailer
  } catch (err) {
    return disabledMailer(err.message)
  }
}
