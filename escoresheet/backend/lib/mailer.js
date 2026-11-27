/**
 * lib/mailer.js — the account emails of lib/auth.js (password reset, email
 * confirmation, "your password was changed"), sent over SMTP with nodemailer.
 * The same mailbox sends the mails a signed-in user asks for to its own
 * address (sendUser: the game PIN and the match information, server.js POST
 * /api/match/send-pin and /send-info).
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
 * Amazon SES instead of SMTP (a Region without an SMTP endpoint, e.g. Europe
 * (Zurich)): SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, all three.
 * The mails then go through the SES v2 HTTPS API (sesTransport: nodemailer
 * still builds the message; the request is signed here, no SDK), and SMTP_*
 * is the support form's account only (lib/contact.js).
 * Without SMTP_HOST or SMTP_PASS (and without that SES account) the mailer is disabled: lib/auth.js then
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
 * 1.5). The tokens work on either manager: both use the same backend. The
 * other kinds are OpenVolley's only (mailBrandOf).
 *
 * Mails: plain text plus a minimal HTML part, in en/de/fr/it. No tracking, no
 * remote images, no links other than the one action link. Recipients are
 * never logged in full (maskEmail), SMTP error texts neither (describeMailError).
 *
 * Volume (per process, fixed one-hour windows):
 *   - two budgets, so sign-ups cannot starve password resets: "account"
 *     (reset, password_changed) and "confirm" (sign-up / resend confirmation);
 *     the final scoresheets ("scoresheet") and the test scoresheets
 *     ("scoresheet_test") have their own, so test mails cannot starve the
 *     real ones; so have the mails users ask for to their own address
 *     ("user", sendUser); budgetsFromEnv reads the operator's sizes (BUDGET_ENV);
 *   - per delivered inbox (inboxKey: plus-tags removed, Gmail dots ignored,
 *     googlemail.com = gmail.com) for reset and confirm mails, so one inbox
 *     cannot be flooded through spelling variants of its address; sendUser
 *     counts its own mails per inbox apart from those, so asking for a game
 *     PIN never uses up the inbox's password resets;
 *   mailName(raw): a self-chosen person name as a mail shows it.
 * A mail over a limit is dropped (the request still succeeds, so the answer
 * never tells whether a mail went out), logged, and counted in stats(), which
 * the internal /health body shows. sendUser leaves the answer to its caller:
 * its address is the caller's own, so server.js says 429 rather than "sent".
 *
 * Public API:
 *   mailerFromEnv(env, { logger }) -> mailer      (disabled mailer when not configured)
 *   createMailer(options)          -> mailer
 *   disabledMailer(reason)         -> mailer
 *   mailer.enabled / mailer.reason / mailer.managerUrl / mailer.from (OpenVolley's)
 *   mailer.managerUrlFor(app) / mailer.fromFor(app)   per brand ('indoor' | 'beach')
 *   mailer.send(kind, { to, lang, link, app, vars, attachments }) -> Promise<{ sent, skipped? }>
 *                                            kind: reset | confirm | password_changed | sign_in_attempts
 *                                            | scoresheet | scoresheet_test (the final scoresheet, lib/finalMail.js:
 *                                            attachments [{ filename, content: Buffer }], PDFs only)
 *                                            | scoresheet_no_pdf (its notice) (vars: see T)
 *                                            skipped: 'budget' | 'inbox' | 'disabled'
 *   mailer.sendOps({ to, subject, text, html }) -> Promise<{ sent, skipped? }>   a mail to the operator
 *                                            (lib/errorAlerts.js), rendered by the caller; own budget OPS_PER_HOUR
 *   mailer.sendUser({ to, subject, text }) -> Promise<{ sent, skipped? }>   a mail a signed-in user asks
 *                                            for to its own address (server.js send-pin, send-info), rendered
 *                                            by the caller, plain text; budget "user", capped per inbox
 *                                            skipped: 'budget' | 'inbox' | 'disabled'
 *   mailer.stats()                 -> { enabled, budgets, inboxDropped, failed, lastDropAt, ... }
 *   budgetsFromEnv(env)            -> { budgets, warnings }  the hourly budgets the environment sets (BUDGET_ENV)
 *   mailer.close()
 *   renderMail(kind, lang, { link, app, vars }) -> { subject, text, html }
 *   mailApp(raw) -> 'indoor' | 'beach'   (the allowlist of a request's `app`)
 *   pickLang(explicit, acceptLanguage) -> 'en' | 'de' | 'fr' | 'it'
 *   authLink(managerUrl, page, token, lang) -> string
 *   maskEmail(email)
 *   inboxKey(email)                -> the delivered inbox of an address (rate-limit key)
 *   describeMailError(err)         -> loggable text of a send error, addresses masked
 *   mailErrorReason(err)           -> a value-free word for a send error ('timeout', EAUTH, ..., 'error')
 */

import { createHash, createHmac } from 'node:crypto'
import nodemailer from 'nodemailer'
import { legalUrl } from './legalLinks.js'

export const MAIL_LANGS = Object.freeze(['en', 'de', 'fr', 'it'])
export const MAIL_KINDS = Object.freeze(['reset', 'confirm', 'password_changed', 'passkey_added', 'email_changed', 'sign_in_attempts', 'scoresheet', 'scoresheet_test', 'scoresheet_no_pdf', 'signup', 'club_manager_invite', 'team_manager_proposal'])
export const DEFAULT_MANAGER_URL = 'https://manager.openvolley.app'
export const DEFAULT_FROM_NAME = 'OpenVolley'
export const DEFAULT_MANAGER_URL_BEACH = 'https://manager-beach.openvolley.app'
export const DEFAULT_FROM_NAME_BEACH = 'OpenBeach'
export const MAIL_APPS = Object.freeze(['indoor', 'beach'])
// The operator's own mails per hour (sendOps: the error digests, at most 6 an hour by themselves)
export const OPS_PER_HOUR = 20

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

// The account mails come in both brands.
// The sign-up notice (lib/signupNotices.js) takes the brand of the app the
// account signed up in.
const BRANDED_KINDS = new Set(['reset', 'confirm', 'password_changed', 'passkey_added', 'email_changed', 'sign_in_attempts', 'signup'])

/** The brand of one mail: mailApp(app) for the account mails, 'indoor' for the others. */
export function mailBrandOf(kind, app) {
  return BRANDED_KINDS.has(kind) ? mailApp(app) : 'indoor'
}

// Outgoing account mails per hour, all recipients together, per budget:
// protects the mailbox's sending quota and reputation from a spread-out flood
// (100 per hour in total, as before the split). "account" carries the reset
// and password-changed mails, "confirm" the confirmation links: a burst of
// sign-ups uses up only the latter (whose holders can resend later).
// The "someone keeps trying your
// password" notices (sign_in_attempts, lib/auth.js tellOfAttempts), which a
// guesser causes for any address it knows, have their own "sign_in" too, so
// they never use up the reset mails' (2611 review,
// SIGNIN-NOTICE-SHARES-RESET-BUDGET). "signup" carries the
// sign-up notices to admins and approvers (lib/signupNotices.js), "notify"
// the club-manager invitations, the team-manager proposals and the final
// mail's notice (a missing PDF): none can starve the
// account mails. email_changed (a changed login address) is an account mail too.
// "user" carries the mails a signed-in user asks for to its own address
// (sendUser: the game PIN, the match information), which have no kind.
export const MAIL_BUDGET_OF = Object.freeze({ reset: 'account', password_changed: 'account', passkey_added: 'account', email_changed: 'account', sign_in_attempts: 'sign_in', confirm: 'confirm', scoresheet: 'scoresheet', scoresheet_test: 'scoresheet_test', scoresheet_no_pdf: 'notify', signup: 'signup', club_manager_invite: 'notify', team_manager_proposal: 'notify' })
// scoresheet: a busy match day (a dozen recipients a game) must not starve
// the account mails, nor be starved by them; scoresheet_test: test mails
// (any scorer, any time) must not use up the final scoresheets' budget
export const DEFAULT_BUDGETS = Object.freeze({ account: 50, confirm: 150, notify: 100, signup: 100, sign_in: 50, scoresheet: 300, scoresheet_test: 50, user: 100 })
// The budgets an operator sizes (deploy/env.example), each by its variable:
// a whole number above 0 per hour; anything else keeps the default, with a
// warning at startup. A size given to createMailer wins (tests).
export const BUDGET_ENV = Object.freeze({ account: 'MAIL_BUDGET_ACCOUNT', confirm: 'MAIL_BUDGET_CONFIRM', notify: 'MAIL_BUDGET_NOTIFY', signup: 'MAIL_BUDGET_SIGNUP', sign_in: 'MAIL_BUDGET_SIGN_IN', scoresheet: 'MAIL_BUDGET_FINAL', scoresheet_test: 'MAIL_BUDGET_TEST', user: 'MAIL_BUDGET_USER' })

/** The hourly budgets the environment sets (BUDGET_ENV): { budgets: { name: n }, warnings: [line] }. */
export function budgetsFromEnv(env = process.env) {
  const budgets = {}
  const warnings = []
  for (const [name, key] of Object.entries(BUDGET_ENV)) {
    const raw = String(env?.[key] ?? '').trim()
    if (!raw) continue
    if (/^\d{1,7}$/.test(raw) && Number(raw) > 0) budgets[name] = Number(raw)
    else warnings.push(`${key} is not a whole number above 0 (${raw.slice(0, 20)}): ${DEFAULT_BUDGETS[name]} per hour, the default`)
  }
  return { budgets, warnings }
}

// Reset + confirmation mails to one delivered inbox per hour. A real user
// needs at most: a confirmation, three resends, one reset. password_changed
// is not counted (only the inbox's holder can cause it, with a reset link).
export const DEFAULT_MAX_PER_INBOX = 5
// scoresheet_test: a scorer mails its own test scoresheets, never a flood.
// The final scoresheet is not capped: a club's contact gets every game of a
// tournament day.
// club_manager_invite: an admin types the address, so one inbox is capped like a confirmation
// (sendUser: its own count per inbox, the same maximum)
const INBOX_CAPPED = new Set(['reset', 'confirm', 'scoresheet_test', 'club_manager_invite'])
// Kinds with a per-inbox hourly cap of their own (a counter per kind, not the
// one above), so one inbox cannot use up their budget (SEC-32). None since
// the approval notices went (approval with a PIN removed 27.11.2026).
export const KIND_INBOX_MAX = Object.freeze({})
const ATTACHING = new Set(['scoresheet', 'scoresheet_test'])
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
    if (err.responseCode) parts.push(`${err.code === 'ESES' ? 'HTTP' : 'SMTP'} ${String(err.responseCode).slice(0, 5)}`)
  }
  const msg = String((err && typeof err === 'object' ? err.message : err) ?? '')
    .replace(ADDRESS_IN_TEXT, (m) => maskEmail(m))
    .replace(/\s+/g, ' ').trim().slice(0, 300)
  if (msg) parts.push(msg)
  return parts.join(' ') || 'unknown error'
}

/**
 * A value-free word for a failed send, for a log line that may name neither
 * the recipient nor anything the mail holds (server.js send-pin, send-info):
 * 'timeout' (an aborted request, nodemailer's ETIMEDOUT), nodemailer's code
 * (EAUTH, ECONNECTION, EENVELOPE, ...) with the SMTP reply code when there is
 * one (EENVELOPE/550), else 'error'. Never the message: an SMTP rejection or
 * a provider's answer quotes the address.
 */
export function mailErrorReason(err) {
  if (err?.name === 'AbortError' || err?.code === 'ETIMEDOUT') return 'timeout'
  const code = typeof err?.code === 'string' && /^E[A-Z]{2,20}$/.test(err.code) ? err.code : ''
  if (!code) return 'error'
  const reply = /^[245]\d\d$/.test(String(err.responseCode ?? '')) ? `/${err.responseCode}` : ''
  return code + reply
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

// The dots a link can be written with (full stop, ideographic and fullwidth ones, one dot leader)
const LINK_DOT = '[.\\u3002\\uff0e\\uff61\\u2024]'
const LINKISH = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, // a scheme
  /\S*[@\uff20]\S*/g, // an address
  new RegExp(`\\bwww${LINK_DOT}\\S*`, 'giu'),
  new RegExp(`\\S+${LINK_DOT}\\p{L}{2,}\\S*`, 'gu') // a dotted host
]

/**
 * Text without control or bidi characters and without anything that reads as
 * a link or an address (LINKISH), each replaced by a space. Not trimmed.
 */
export function withoutLinks(raw) {
  let s = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ')
  for (const re of LINKISH) s = s.replace(re, ' ')
  return s
}

/**
 * A self-chosen person name as a mail shows it (SEC-34, audit 26.11: the
 * sign-up notices, a team manager's proposal):
 * without anything that reads as a link or an address (a scheme, www., a
 * dotted host, also with another dot), then letters, spaces, hyphens and
 * apostrophes only (anything else becomes a space: no number or sentence
 * punctuation), at most 60 characters. '' when nothing is left.
 */
export function mailName(raw, max = 60) {
  return withoutLinks(raw)
    .replace(/[^\p{L}\p{M} '\u2019-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s'\u2019-]+|[\s'\u2019-]+$/g, '')
    .slice(0, max).trim()
}

/** A template value: text on one line (no header or line injection), at most 200 chars. */
const cleanText = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
// A list (the sign-up notice's parts): at most 40 items, each a flat object of texts
const cleanVar = (v) => (typeof v === 'boolean'
  ? v
  : Array.isArray(v)
    ? v.slice(0, 40).map((x) => Object.fromEntries(Object.entries(x && typeof x === 'object' ? x : {}).map(([k, y]) => [k, cleanText(y)])))
    : cleanText(v))

// The sign-up notice: who signed up, and what it asks for, in the mail's language
const SIGNUP_KINDS = Object.freeze({
  en: { scorer: 'Scorer', referee: 'Referee', team_manager: 'Team manager / coach', club_manager: 'Club manager', asks: 'Asks for:', none: 'It asks for no role yet: give it one, or delete the account, under Accounts.' },
  de: { scorer: 'Schreiber', referee: 'Schiedsrichter', team_manager: 'Teamverantwortliche/r / Trainer', club_manager: 'Vereinsverantwortliche/r', asks: 'Anfrage:', none: 'Das Konto fragt noch nach keiner Rolle: gib ihm unter Konten eine, oder lösche es.' },
  fr: { scorer: 'Marqueur', referee: 'Arbitre', team_manager: 'Responsable d’équipe / coach', club_manager: 'Responsable du club', asks: 'Demande :', none: 'Le compte ne demande encore aucun rôle : donne-lui-en un, ou supprime-le, sous Comptes.' },
  it: { scorer: 'Segnapunti', referee: 'Arbitro', team_manager: 'Responsabile della squadra / allenatore', club_manager: 'Responsabile della società', asks: 'Richiesta:', none: 'L’account non chiede ancora nessun ruolo: dagliene uno, o eliminalo, in Account.' }
})
// The self-chosen name: letters, spaces, hyphens and apostrophes only (mailName, SEC-34)
const signupWho = (v) => (mailName(v.name) ? `${mailName(v.name)} (${v.email})` : v.email)
function signupParts(v, lang) {
  const L = SIGNUP_KINDS[lang]
  const parts = Array.isArray(v.parts) ? v.parts : []
  if (!parts.length) return [L.none]
  return [L.asks, ...parts.map((p) => {
    const kind = L[p.kind] || p.kind
    const where = p.kind === 'team_manager' ? [p.team, p.club && `(${p.club})`].filter(Boolean).join(' ') : p.club
    return `• ${where ? `${kind} · ${where}` : kind}`
  })]
}

/** A final mail's technical remarks (lib/finalMail.js technicalRemarkLines): a heading and one paragraph of lines. */
const technicalSection = (v, heading) => (Array.isArray(v?.technical) && v.technical.length
  ? [heading, v.technical.map((l) => `- ${l?.line ?? ''}`).join('\n')]
  : [])

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
      before: ['Hallo', 'Jemand möchte das Passwort deines OpenVolley-Kontos zurücksetzen. Wenn du das warst, lege hier ein neues Passwort fest. Der Link funktioniert einmal und läuft nach 60 Minuten ab.'],
      button: 'Neues Passwort festlegen',
      after: ['Wenn du das nicht warst, ignoriere diese E-Mail: Dein Passwort bleibt unverändert.']
    },
    fr: {
      subject: 'Réinitialiser ton mot de passe OpenVolley',
      before: ['Bonjour,', 'quelqu’un a demandé à réinitialiser le mot de passe de ton compte OpenVolley. Si c’était toi, choisis un nouveau mot de passe ici. Le lien fonctionne une seule fois et expire dans 60 minutes.'],
      button: 'Choisir un nouveau mot de passe',
      after: ['Si tu n’as rien demandé, ignore cet e-mail : ton mot de passe reste inchangé.']
    },
    it: {
      subject: 'Reimposta la password di OpenVolley',
      before: ['Buongiorno,', 'qualcuno ha chiesto di reimpostare la password del tuo account OpenVolley. Se sei stato tu, scegli qui una nuova password. Il link funziona una sola volta e scade tra 60 minuti.'],
      button: 'Scegliere una nuova password',
      after: ['Se non hai chiesto nulla, ignora questa e-mail: la tua password resta invariata.']
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
      before: ['Hallo', 'Danke, dass du ein OpenVolley-Konto erstellt hast. Bitte bestätige, dass diese E-Mail-Adresse dir gehört. Der Link funktioniert einmal und läuft nach 24 Stunden ab.'],
      button: 'E-Mail-Adresse bestätigen',
      after: ['Wenn du kein Konto erstellt hast, ignoriere diese E-Mail.']
    },
    fr: {
      subject: 'Confirme ton adresse e-mail pour OpenVolley',
      before: ['Bonjour,', 'merci d’avoir créé un compte OpenVolley. Confirme que cette adresse e-mail est bien la tienne. Le lien fonctionne une seule fois et expire dans 24 heures.'],
      button: 'Confirmer mon adresse e-mail',
      after: ['Si tu n’as pas créé de compte, ignore cet e-mail.']
    },
    it: {
      subject: 'Conferma il tuo indirizzo e-mail per OpenVolley',
      before: ['Buongiorno,', 'grazie per aver creato un account OpenVolley. Conferma che questo indirizzo e-mail è tuo. Il link funziona una sola volta e scade tra 24 ore.'],
      button: 'Confermare l’indirizzo e-mail',
      after: ['Se non hai creato un account, ignora questa e-mail.']
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
      subject: 'Dein OpenVolley-Passwort wurde geändert',
      before: ['Hallo', 'Das Passwort deines OpenVolley-Kontos wurde soeben über einen Zurücksetz-Link geändert, und alle Geräte wurden abgemeldet.'],
      button: null,
      after: ['Wenn du das nicht warst, setze dein Passwort sofort erneut zurück und informiere den Admin deines Vereins.']
    },
    fr: {
      subject: 'Ton mot de passe OpenVolley a été modifié',
      before: ['Bonjour,', 'le mot de passe de ton compte OpenVolley vient d’être modifié avec un lien de réinitialisation, et tous les appareils ont été déconnectés.'],
      button: null,
      after: ['Si ce n’était pas toi, réinitialise immédiatement ton mot de passe et préviens l’admin de ton club.']
    },
    it: {
      subject: 'La tua password di OpenVolley è stata modificata',
      before: ['Buongiorno,', 'la password del tuo account OpenVolley è appena stata modificata con un link di reimpostazione e tutti i dispositivi sono stati disconnessi.'],
      button: null,
      after: ['Se non sei stato tu, reimposta subito la password e avvisa l’admin del tuo club.']
    }
  },
  // An admin moved the account to another address (lib/accounts.js
  // updateProfile): sent to the old one. Links nothing, like the notices above.
  email_changed: {
    en: {
      subject: 'The email address of your OpenVolley account was changed',
      before: ['Hello,', 'an admin just changed the email address of your OpenVolley account. It is no longer this address, and every device was signed out.'],
      button: null,
      after: ['If you did not ask for this, tell your club admin right away.']
    },
    de: {
      subject: 'Die E-Mail-Adresse deines OpenVolley-Kontos wurde geändert',
      before: ['Hallo', 'Ein Admin hat soeben die E-Mail-Adresse deines OpenVolley-Kontos geändert. Es ist nicht mehr diese Adresse, und alle Geräte wurden abgemeldet.'],
      button: null,
      after: ['Wenn du das nicht verlangt hast, informiere sofort den Admin deines Vereins.']
    },
    fr: {
      subject: 'L’adresse e-mail de ton compte OpenVolley a été modifiée',
      before: ['Bonjour,', 'un admin vient de modifier l’adresse e-mail de ton compte OpenVolley. Ce n’est plus cette adresse, et tous les appareils ont été déconnectés.'],
      button: null,
      after: ['Si tu ne l’as pas demandé, préviens immédiatement l’admin de ton club.']
    },
    it: {
      subject: 'L’indirizzo e-mail del tuo account OpenVolley è stato modificato',
      before: ['Buongiorno,', 'un admin ha appena modificato l’indirizzo e-mail del tuo account OpenVolley. Non è più questo indirizzo e tutti i dispositivi sono stati disconnessi.'],
      button: null,
      after: ['Se non l’hai chiesto tu, avvisa subito l’admin del tuo club.']
    }
  },
  // A passkey was added (lib/auth.js passkeyRegister). vars: device ("iPhone ·
  // Safari"). Like the password notice it links nothing: the way out is in
  // the app, and a genuine mail can be told by that.
  passkey_added: {
    en: (v) => ({
      subject: 'A passkey was added to your OpenVolley account',
      before: ['Hello,', `a passkey (sign-in with your fingerprint, face or device PIN) was just added to your OpenVolley account, on: ${v.device}.`],
      button: null,
      after: ['If that was not you, remove it under Profile → Passkeys, reset your password right away (that removes every passkey) and tell your club admin.']
    }),
    de: (v) => ({
      subject: 'Deinem OpenVolley-Konto wurde ein Passkey hinzugefügt',
      before: ['Hallo', `Deinem OpenVolley-Konto wurde soeben ein Passkey (Anmeldung mit Fingerabdruck, Gesicht oder Geräte-PIN) hinzugefügt, auf: ${v.device}.`],
      button: null,
      after: ['Wenn du das nicht warst, entferne ihn unter Profil → Passkeys, setze dein Passwort sofort zurück (das entfernt alle Passkeys) und informiere den Admin deines Vereins.']
    }),
    fr: (v) => ({
      subject: 'Une clé d’accès a été ajoutée à ton compte OpenVolley',
      before: ['Bonjour,', `une clé d’accès (connexion par empreinte digitale, visage ou code de l’appareil) vient d’être ajoutée à ton compte OpenVolley, sur : ${v.device}.`],
      button: null,
      after: ['Si ce n’était pas toi, supprime-la sous Profil → Clés d’accès, réinitialise immédiatement ton mot de passe (cela supprime toutes les clés d’accès) et préviens l’admin de ton club.']
    }),
    it: (v) => ({
      subject: 'Al tuo account OpenVolley è stata aggiunta una passkey',
      before: ['Buongiorno,', `al tuo account OpenVolley è appena stata aggiunta una passkey (accesso con impronta, volto o PIN del dispositivo), su: ${v.device}.`],
      button: null,
      after: ['Se non sei stato tu, rimuovila in Profilo → Passkey, reimposta subito la password (così vengono rimosse tutte le passkey) e avvisa l’admin del tuo club.']
    })
  },
  // Many wrong passwords for one account (lib/auth.js, db/057, audit 2611
  // SEC-13), once per 24-hour window. vars: count. Links nothing, like the
  // password notice: the way out is in the app.
  sign_in_attempts: {
    en: (v) => ({
      subject: 'Many wrong passwords for your OpenVolley account',
      before: ['Hello,', `a wrong password was typed for your OpenVolley account ${v.count} times in the last 24 hours. For now, sign-ins from devices and networks that never signed in to it are slowed down; your devices that are signed in stay signed in.`],
      button: null,
      after: ['If that was not you, someone may be trying to guess your password. If it is short or you use it elsewhere too, change it now (Profile → Change password, or "Forgot password?" when you sign in) and tell your club admin.']
    }),
    de: (v) => ({
      subject: 'Viele falsche Passwörter für dein OpenVolley-Konto',
      before: ['Hallo', `Für dein OpenVolley-Konto wurde in den letzten 24 Stunden ${v.count}-mal ein falsches Passwort eingegeben. Anmeldungen von Geräten und Netzwerken, die sich noch nie angemeldet haben, werden vorerst gebremst; deine angemeldeten Geräte bleiben angemeldet.`],
      button: null,
      after: ['Wenn du das nicht warst, versucht vielleicht jemand, dein Passwort zu erraten. Ist es kurz oder verwendest du es auch anderswo, ändere es jetzt (Profil → Passwort ändern, oder «Passwort vergessen?» bei der Anmeldung) und informiere den Admin deines Vereins.']
    }),
    fr: (v) => ({
      subject: 'Beaucoup de mots de passe erronés pour ton compte OpenVolley',
      before: ['Bonjour,', `un mot de passe erroné a été saisi ${v.count} fois pour ton compte OpenVolley au cours des dernières 24 heures. Pour l’instant, les connexions depuis des appareils et des réseaux qui ne s’y sont jamais connectés sont ralenties ; tes appareils connectés restent connectés.`],
      button: null,
      after: ['Si ce n’était pas toi, quelqu’un essaie peut-être de deviner ton mot de passe. S’il est court ou que tu l’utilises aussi ailleurs, change-le maintenant (Profil → Changer le mot de passe, ou « Mot de passe oublié ? » à la connexion) et préviens l’admin de ton club.']
    }),
    it: (v) => ({
      subject: 'Molte password errate per il tuo account OpenVolley',
      before: ['Buongiorno,', `per il tuo account OpenVolley è stata digitata una password errata ${v.count} volte nelle ultime 24 ore. Per ora gli accessi da dispositivi e reti che non vi hanno mai effettuato l’accesso sono rallentati; i tuoi dispositivi connessi restano connessi.`],
      button: null,
      after: ['Se non sei stato tu, forse qualcuno sta cercando di indovinare la tua password. Se è corta o la usi anche altrove, cambiala subito (Profilo → Cambia password, oppure «Password dimenticata?» all’accesso) e avvisa l’admin del tuo club.']
    })
  },
  // A new account confirmed its address (lib/signupNotices.js), to the admins
  // and the approvers of its requests. vars: name, email, parts [{ kind, club,
  // team }] (the parts this recipient decides; admins: all), admin (true for
  // an admin). The link opens the manager page of the account or the club or
  // team.
  signup: {
    en: (v) => ({
      subject: `New OpenVolley sign-up`,
      before: ['Hello,', `${signupWho(v)} just created an OpenVolley account and confirmed the email address.`,
        ...signupParts(v, 'en')],
      button: 'Open in the manager',
      after: [v.admin
        ? 'You get this mail as an admin of OpenVolley. Nothing is granted until someone approves it.'
        : 'You get this mail because you approve these requests for your club or team. Nothing is granted until someone approves it.']
    }),
    de: (v) => ({
      subject: `Neue OpenVolley-Registrierung`,
      before: ['Hallo', `${signupWho(v)} hat soeben ein OpenVolley-Konto erstellt und die E-Mail-Adresse bestätigt.`,
        ...signupParts(v, 'de')],
      button: 'Im Manager öffnen',
      after: [v.admin
        ? 'Du erhältst diese E-Mail als Admin von OpenVolley. Erst eine Freigabe gibt dem Konto Rechte.'
        : 'Du erhältst diese E-Mail, weil du diese Anfragen für deinen Verein oder dein Team freigibst. Erst eine Freigabe gibt dem Konto Rechte.']
    }),
    fr: (v) => ({
      subject: `Nouvelle inscription OpenVolley`,
      before: ['Bonjour,', `${signupWho(v)} vient de créer un compte OpenVolley et a confirmé son adresse e-mail.`,
        ...signupParts(v, 'fr')],
      button: 'Ouvrir dans le manager',
      after: [v.admin
        ? 'Tu reçois cet e-mail en tant qu’admin d’OpenVolley. Rien n’est accordé avant une approbation.'
        : 'Tu reçois cet e-mail parce que tu approuves ces demandes pour ton club ou ton équipe. Rien n’est accordé avant une approbation.']
    }),
    it: (v) => ({
      subject: `Nuova registrazione OpenVolley`,
      before: ['Buongiorno,', `${signupWho(v)} ha appena creato un account OpenVolley e confermato l’indirizzo e-mail.`,
        ...signupParts(v, 'it')],
      button: 'Aprire nel manager',
      after: [v.admin
        ? 'Ricevi questa e-mail come admin di OpenVolley. Nulla viene concesso prima di un’approvazione.'
        : 'Ricevi questa e-mail perché approvi queste richieste per la tua società o squadra. Nulla viene concesso prima di un’approvazione.']
    })
  },
  // A team manager proposed someone as team manager of its team (db/036,
  // lib/signupNotices.js proposal), to the club's managers (or the admins of a
  // club without managers). vars: name, email (the account), team, club,
  // proposer (may be ''), admin. The link opens My club (admins: the account).
  team_manager_proposal: {
    en: (v) => ({
      subject: `Confirm a team manager`,
      before: ['Hello,', `${mailName(v.proposer) || 'A team manager'} proposes ${signupWho(v)} as team manager of ${v.team} (${v.club}).`,
        'The account gets the team only when a manager of the club or an admin approves the request.'],
      button: 'Open in the manager',
      after: [v.admin
        ? 'You get this mail as an admin of OpenVolley: the club has no club manager.'
        : 'You get this mail as a manager of the club. Nothing is granted until it is approved.']
    }),
    de: (v) => ({
      subject: `Teamverantwortliche/n bestätigen`,
      before: ['Hallo', `${mailName(v.proposer) || 'Ein/e Teamverantwortliche/r'} schlägt ${signupWho(v)} als Teamverantwortliche/n von ${v.team} (${v.club}) vor.`,
        'Das Konto bekommt das Team erst, wenn eine vereinsverantwortliche Person oder ein Admin die Anfrage freigibt.'],
      button: 'Im Manager öffnen',
      after: [v.admin
        ? 'Du erhältst diese E-Mail als Admin von OpenVolley: Der Verein hat keine Vereinsverantwortlichen.'
        : 'Du erhältst diese E-Mail als Vereinsverantwortliche/r. Erst eine Freigabe gibt dem Konto Rechte.']
    }),
    fr: (v) => ({
      subject: `Confirmer un responsable d’équipe`,
      before: ['Bonjour,', `${mailName(v.proposer) || 'Un responsable d’équipe'} propose ${signupWho(v)} comme responsable d’équipe de ${v.team} (${v.club}).`,
        'Le compte ne reçoit l’équipe qu’après l’approbation de la demande par un responsable du club ou un admin.'],
      button: 'Ouvrir dans le manager',
      after: [v.admin
        ? 'Tu reçois cet e-mail en tant qu’admin d’OpenVolley : le club n’a pas de responsable.'
        : 'Tu reçois cet e-mail en tant que responsable du club. Rien n’est accordé avant une approbation.']
    }),
    it: (v) => ({
      subject: `Confermare un responsabile della squadra`,
      before: ['Buongiorno,', `${mailName(v.proposer) || 'Un responsabile della squadra'} propone ${signupWho(v)} come responsabile della squadra ${v.team} (${v.club}).`,
        'L’account riceve la squadra solo dopo che un responsabile della società o un admin ha approvato la richiesta.'],
      button: 'Aprire nel manager',
      after: [v.admin
        ? 'Ricevi questa e-mail come admin di OpenVolley: la società non ha responsabili.'
        : 'Ricevi questa e-mail come responsabile della società. Nulla viene concesso prima di un’approvazione.']
    })
  },
  // A club manager link (lib/clubs.js inviteManager, db/029), to someone an
  // admin named who is not linked to the club yet. vars: club, inviter (may
  // be ''), days. The link opens the manager: sign in or create an account.
  club_manager_invite: {
    en: (v) => ({
      subject: `You are invited to manage ${v.club} on OpenVolley`,
      before: ['Hello,', `${v.inviter || 'An OpenVolley admin'} invites you to be a club manager of ${v.club} on OpenVolley: you make the club's invite codes, approve its sign-ups and look after its members and teams.`,
        `Open the link, then sign in or create an account. The link works once and expires in ${v.days} days.`],
      button: 'Become club manager',
      after: ['If you did not expect this, ignore this email: nothing changes.']
    }),
    de: (v) => ({
      subject: `Einladung: ${v.club} auf OpenVolley verwalten`,
      before: ['Hallo', `${v.inviter || 'Ein OpenVolley-Admin'} lädt dich ein, ${v.club} auf OpenVolley als Vereinsverantwortliche/r zu verwalten: Du erstellst die Einladungscodes des Vereins, gibst seine Registrierungen frei und betreust seine Mitglieder und Teams.`,
        `Öffne den Link und melde dich an oder erstelle ein Konto. Der Link funktioniert einmal und läuft nach ${v.days} Tagen ab.`],
      button: 'Vereinsverantwortliche/r werden',
      after: ['Wenn du das nicht erwartet hast, ignoriere diese E-Mail: Es ändert sich nichts.']
    }),
    fr: (v) => ({
      subject: `Invitation à gérer ${v.club} sur OpenVolley`,
      before: ['Bonjour,', `${v.inviter || 'Un admin d’OpenVolley'} t’invite à devenir responsable du club ${v.club} sur OpenVolley : tu crées les codes d’invitation du club, approuves ses inscriptions et suis ses membres et ses équipes.`,
        `Ouvre le lien, puis connecte-toi ou crée un compte. Le lien fonctionne une seule fois et expire dans ${v.days} jours.`],
      button: 'Devenir responsable du club',
      after: ['Si tu ne t’y attendais pas, ignore cet e-mail : rien ne change.']
    }),
    it: (v) => ({
      subject: `Invito a gestire ${v.club} su OpenVolley`,
      before: ['Buongiorno,', `${v.inviter || 'Un admin di OpenVolley'} ti invita a diventare responsabile della società ${v.club} su OpenVolley: crei i codici d’invito della società, approvi le sue registrazioni e segui i suoi membri e le sue squadre.`,
        `Apri il link, poi accedi o crea un account. Il link funziona una sola volta e scade tra ${v.days} giorni.`],
      button: 'Diventare responsabile della società',
      after: ['Se non te lo aspettavi, ignora questa e-mail: non cambia nulla.']
    })
  },
  // The final scoresheet (lib/finalMail.js), the PDF attached. vars: teams,
  // game ('' when none), date, result ('' when unknown), corrected; pdf:
  // false when it goes without the PDF (that follows), late: the PDF that
  // was missing from it; technical: the match's technical remarks, never
  // printed on its sheet (lines, technicalRemarkLines), listed after the facts
  scoresheet: {
    en: (v) => ({
      subject: `${v.corrected ? 'Corrected scoresheet' : 'Scoresheet'}: ${v.teams}`,
      before: ['Hello,', v.pdf === false
        ? `this match is over and its ${v.corrected ? 'corrected ' : ''}result is final. Its scoresheet PDF has not reached the server yet: it follows in another mail as soon as it does.`
        : `the ${v.corrected ? 'corrected ' : ''}final scoresheet of this match is attached${v.late ? ': it was missing from the result mail you got' : ''}.`,
        `Match: ${v.teams}`, ...(v.game ? [`Game: ${v.game}`] : []), `Date: ${v.date}`, ...(v.result ? [`Result: ${v.result}`] : []), ...technicalSection(v, 'Technical remarks (not printed on the scoresheet):')],
      button: null,
      after: ['You get this mail as an official of the match or as the contact of one of its clubs. Questions about the match go to the organiser of the competition.']
    }),
    de: (v) => ({
      subject: `${v.corrected ? 'Korrigiertes Matchblatt' : 'Matchblatt'}: ${v.teams}`,
      before: ['Hallo', v.pdf === false
        ? `Dieses Spiel ist beendet, sein ${v.corrected ? 'korrigiertes ' : ''}Resultat ist definitiv. Das PDF des Matchblatts ist noch nicht auf dem Server angekommen: Es folgt in einer weiteren E-Mail, sobald es da ist.`
        : `Im Anhang findest du das ${v.corrected ? 'korrigierte ' : ''}fertige Matchblatt dieses Spiels${v.late ? ': Es fehlte in der E-Mail mit dem Resultat' : ''}.`,
        `Spiel: ${v.teams}`, ...(v.game ? [`Spielnummer: ${v.game}`] : []), `Datum: ${v.date}`, ...(v.result ? [`Resultat: ${v.result}`] : []), ...technicalSection(v, 'Technische Bemerkungen (nicht auf dem Matchblatt gedruckt):')],
      button: null,
      after: ['Du erhältst diese E-Mail als Offizielle/r des Spiels oder als Kontakt eines der beiden Vereine. Fragen zum Spiel richtest du an den Veranstalter der Meisterschaft.']
    }),
    fr: (v) => ({
      subject: `${v.corrected ? 'Feuille de match corrigée' : 'Feuille de match'} : ${v.teams}`,
      before: ['Bonjour,', v.pdf === false
        ? `ce match est terminé et son résultat ${v.corrected ? 'corrigé ' : ''}est définitif. Le PDF de sa feuille de match n’est pas encore arrivé sur le serveur : il suivra dans un autre e-mail dès qu’il sera là.`
        : `tu trouveras en pièce jointe la feuille de match ${v.corrected ? 'corrigée ' : ''}finale de ce match${v.late ? ' : elle manquait dans l’e-mail du résultat' : ''}.`,
        `Match : ${v.teams}`, ...(v.game ? [`Numéro : ${v.game}`] : []), `Date : ${v.date}`, ...(v.result ? [`Résultat : ${v.result}`] : []), ...technicalSection(v, 'Remarques techniques (non imprimées sur la feuille de match) :')],
      button: null,
      after: ['Tu reçois cet e-mail en tant qu’officiel du match ou contact de l’un de ses clubs. Les questions sur le match vont à l’organisateur du championnat.']
    }),
    it: (v) => ({
      subject: `${v.corrected ? 'Referto corretto' : 'Referto'}: ${v.teams}`,
      before: ['Buongiorno,', v.pdf === false
        ? `questa partita è terminata e il suo risultato ${v.corrected ? 'corretto ' : ''}è definitivo. Il PDF del referto non è ancora arrivato sul server: seguirà in un’altra e-mail appena ci sarà.`
        : `in allegato trovi il referto ${v.corrected ? 'corretto ' : ''}finale di questa partita${v.late ? ': mancava nell’e-mail del risultato' : ''}.`,
        `Partita: ${v.teams}`, ...(v.game ? [`Numero: ${v.game}`] : []), `Data: ${v.date}`, ...(v.result ? [`Risultato: ${v.result}`] : []), ...technicalSection(v, 'Osservazioni tecniche (non stampate sul referto):')],
      button: null,
      after: ['Ricevi questa e-mail come ufficiale della partita o come contatto di una delle due società. Le domande sulla partita vanno all’organizzatore del campionato.']
    })
  },
  // A test match's scoresheet to its scorer (never stored). vars: teams,
  // result: the caller's text, so in the body only (a fixed subject)
  scoresheet_test: {
    en: (v) => ({
      subject: 'Test scoresheet',
      before: ['Hello,', 'the scoresheet of your test match is attached. Test matches are not kept on the server or on your device: this mail is their only copy.',
        `Match: ${v.teams}`, ...(v.result ? [`Result: ${v.result}`] : [])],
      button: null,
      after: []
    }),
    de: (v) => ({
      subject: 'Test-Matchblatt',
      before: ['Hallo', 'Im Anhang findest du das Matchblatt deines Testspiels. Testspiele werden weder auf dem Server noch auf deinem Gerät aufbewahrt: Diese E-Mail ist die einzige Kopie.',
        `Spiel: ${v.teams}`, ...(v.result ? [`Resultat: ${v.result}`] : [])],
      button: null,
      after: []
    }),
    fr: (v) => ({
      subject: 'Feuille de match de test',
      before: ['Bonjour,', 'tu trouveras en pièce jointe la feuille de ton match de test. Les matchs de test ne sont gardés ni sur le serveur ni sur ton appareil : cet e-mail en est la seule copie.',
        `Match : ${v.teams}`, ...(v.result ? [`Résultat : ${v.result}`] : [])],
      button: null,
      after: []
    }),
    it: (v) => ({
      subject: 'Referto di prova',
      before: ['Buongiorno,', 'in allegato trovi il referto della tua partita di prova. Le partite di prova non vengono conservate né sul server né sul tuo dispositivo: questa e-mail è l’unica copia.',
        `Partita: ${v.teams}`, ...(v.result ? [`Risultato: ${v.result}`] : [])],
      button: null,
      after: []
    })
  },
  // The final mail went without the PDF (lib/finalMail.js), to the closing
  // scorer and the admins. vars: teams, game, date, result, admin
  scoresheet_no_pdf: {
    en: (v) => ({
      subject: `Scoresheet PDF missing: ${v.teams}`,
      before: ['Hello,', 'the result mail of this match went to its officials and clubs without the scoresheet PDF: the PDF did not reach the server within 2 hours of the close.',
        `Match: ${v.teams}`, ...(v.game ? [`Game: ${v.game}`] : []), `Date: ${v.date}`, ...(v.result ? [`Result: ${v.result}`] : [])],
      button: null,
      after: [v.admin
        ? 'The scorer was asked to open OpenVolley online on the device that closed the match, so that it sends the PDF; it is then mailed on its own. The match is in the manager under Closed matches.'
        : 'Open OpenVolley online on the device that closed the match: it then sends the PDF, which is mailed on its own. If that device is no longer at hand, tell an admin.']
    }),
    de: (v) => ({
      subject: `Matchblatt-PDF fehlt: ${v.teams}`,
      before: ['Hallo', 'Die E-Mail mit dem Resultat dieses Spiels ging ohne das PDF des Matchblatts an die Offiziellen und die Vereine: Das PDF ist innert 2 Stunden nach dem Abschluss nicht auf dem Server angekommen.',
        `Spiel: ${v.teams}`, ...(v.game ? [`Spielnummer: ${v.game}`] : []), `Datum: ${v.date}`, ...(v.result ? [`Resultat: ${v.result}`] : [])],
      button: null,
      after: [v.admin
        ? 'Der Schreiber wurde gebeten, OpenVolley auf dem Gerät, das das Spiel abgeschlossen hat, mit Internetverbindung zu öffnen, damit es das PDF sendet; es wird dann von selbst verschickt. Das Spiel steht im Manager unter Abgeschlossene Spiele.'
        : 'Öffne OpenVolley mit Internetverbindung auf dem Gerät, das das Spiel abgeschlossen hat: Es sendet dann das PDF, das von selbst verschickt wird. Ist das Gerät nicht mehr verfügbar, informiere einen Admin.']
    }),
    fr: (v) => ({
      subject: `PDF de la feuille de match manquant : ${v.teams}`,
      before: ['Bonjour,', 'l’e-mail du résultat de ce match est parti aux officiels et aux clubs sans le PDF de la feuille de match : le PDF n’est pas arrivé sur le serveur dans les 2 heures après la clôture.',
        `Match : ${v.teams}`, ...(v.game ? [`Numéro : ${v.game}`] : []), `Date : ${v.date}`, ...(v.result ? [`Résultat : ${v.result}`] : [])],
      button: null,
      after: [v.admin
        ? 'Le marqueur a été invité à ouvrir OpenVolley, connecté à Internet, sur l’appareil qui a clôturé le match, afin qu’il envoie le PDF ; celui-ci est ensuite envoyé automatiquement. Le match figure dans le manager sous Matchs clôturés.'
        : 'Ouvre OpenVolley, connecté à Internet, sur l’appareil qui a clôturé le match : il envoie alors le PDF, qui est ensuite envoyé automatiquement. Si cet appareil n’est plus disponible, préviens un admin.']
    }),
    it: (v) => ({
      subject: `PDF del referto mancante: ${v.teams}`,
      before: ['Buongiorno,', 'l’e-mail con il risultato di questa partita è partita verso gli ufficiali e le società senza il PDF del referto: il PDF non è arrivato sul server entro 2 ore dalla chiusura.',
        `Partita: ${v.teams}`, ...(v.game ? [`Numero: ${v.game}`] : []), `Data: ${v.date}`, ...(v.result ? [`Risultato: ${v.result}`] : [])],
      button: null,
      after: [v.admin
        ? 'Il segnapunti è stato invitato ad aprire OpenVolley, con connessione a Internet, sul dispositivo che ha chiuso la partita, affinché invii il PDF; verrà poi inviato automaticamente. La partita è elencata nel manager sotto Partite chiuse.'
        : 'Apri OpenVolley, con connessione a Internet, sul dispositivo che ha chiuso la partita: invierà il PDF, che verrà poi inviato automaticamente. Se il dispositivo non è più disponibile, avvisa un admin.']
    })
  }
}

// OpenBeach: one login for both apps, so a password mail says the password
// is the one of both (plan 1.5 "Reset mail text"). After the main paragraph.
const SHARED_PASSWORD_NOTE = {
  reset: {
    en: 'This changes the password of your account for OpenVolley and OpenBeach.',
    de: 'Damit änderst du das Passwort deines Kontos für OpenVolley und OpenBeach.',
    fr: 'Cela modifie le mot de passe de ton compte pour OpenVolley et OpenBeach.',
    it: 'Così modifichi la password del tuo account per OpenVolley e OpenBeach.'
  },
  passkey_added: {
    en: 'Your account works for OpenVolley and OpenBeach: the passkey signs in to both apps.',
    de: 'Dein Konto gilt für OpenVolley und OpenBeach: Der Passkey meldet dich in beiden Apps an.',
    fr: 'Ton compte est valable pour OpenVolley et OpenBeach : la clé d’accès te connecte aux deux applications.',
    it: 'Il tuo account vale per OpenVolley e OpenBeach: la passkey dà accesso a entrambe le app.'
  },
  password_changed: {
    en: 'Your account works for OpenVolley and OpenBeach: the new password is the one of both apps.',
    de: 'Dein Konto gilt für OpenVolley und OpenBeach: Das neue Passwort gilt für beide Apps.',
    fr: 'Ton compte est valable pour OpenVolley et OpenBeach : le nouveau mot de passe vaut pour les deux applications.',
    it: 'Il tuo account vale per OpenVolley e OpenBeach: la nuova password vale per entrambe le app.'
  },
  sign_in_attempts: {
    en: 'Your account works for OpenVolley and OpenBeach: the password is the one of both apps.',
    de: 'Dein Konto gilt für OpenVolley und OpenBeach: Das Passwort gilt für beide Apps.',
    fr: 'Ton compte est valable pour OpenVolley et OpenBeach : le mot de passe vaut pour les deux applications.',
    it: 'Il tuo account vale per OpenVolley e OpenBeach: la password vale per entrambe le app.'
  },
  email_changed: {
    en: 'Your account works for OpenVolley and OpenBeach: the change applies to both apps.',
    de: 'Dein Konto gilt für OpenVolley und OpenBeach: Die Änderung gilt für beide Apps.',
    fr: 'Ton compte est valable pour OpenVolley et OpenBeach : la modification vaut pour les deux applications.',
    it: 'Il tuo account vale per OpenVolley e OpenBeach: la modifica vale per entrambe le app.'
  }
}

/**
 * The template of `kind` in `lang` for a brand: OpenVolley's as written,
 * OpenBeach's with its name and the shared-password note. A template that is
 * a function (the notices with values) gets the cleaned `vars` first.
 */
function templateFor(kind, lang, app, vars) {
  const entry = T[kind][lang]
  const m = typeof entry === 'function'
    ? entry(Object.fromEntries(Object.entries(vars && typeof vars === 'object' ? vars : {}).map(([k, v]) => [k, cleanVar(v)])))
    : entry
  if (app !== 'beach') return m
  const name = MAIL_BRANDS.beach.name
  const swap = (line) => line.replace(/OpenVolley/g, name)
  const note = SHARED_PASSWORD_NOTE[kind]?.[lang]
  const before = m.before.map(swap)
  if (note) before.push(note)
  return { subject: swap(m.subject), before, button: m.button, after: m.after.map(swap) }
}

// The footer line under the signature: where the privacy policy is, in the
// mail's language. Written as text (host and path, no scheme, no <a>): every
// mail links only its action, and the password-changed notice nothing at all,
// so a reader can tell a genuine mail by that.
const PRIVACY_LABEL = {
  en: 'Privacy policy:',
  de: 'Datenschutzerklärung:',
  fr: 'Protection des données :',
  it: 'Protezione dei dati:'
}

export function privacyLine(lang) {
  const l = langOf(lang) || 'en'
  return `${PRIVACY_LABEL[l]} ${legalUrl('privacy', l).replace(/^https?:\/\//, '')}`
}

/**
 * { subject, text, html } of one mail. link: the action link (every kind but
 * password_changed); app: the brand ('indoor' default, 'beach'); vars: the
 * values of the kinds that take them (see T).
 */
export function renderMail(kind, lang, { link, app, vars } = {}) {
  const set = T[kind]
  if (!set) throw new Error(`mailer: unknown mail kind ${kind}`)
  const brand = MAIL_BRANDS[mailBrandOf(kind, app)]
  const m = templateFor(kind, langOf(lang) || 'en', brand.app, vars)
  if (m.button && !link) throw new Error(`mailer: ${kind} needs a link`)
  const textParts = [...m.before]
  if (m.button) textParts.push(link)
  textParts.push(...m.after, `– ${brand.name}`, privacyLine(lang))
  const text = textParts.join('\n\n') + '\n'

  // pre-line: a paragraph of several lines (a final mail's technical remarks) keeps its line breaks
  const p = (s) => `<p style="margin:0 0 16px;white-space:pre-line">${escapeHtml(s)}</p>`
  const button = m.button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#e2001a;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${escapeHtml(m.button)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#57534e;word-break:break-all">${escapeHtml(link)}</p>`
    : ''
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;padding:24px;background:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:24px">' +
    m.before.map(p).join('') + button + m.after.map(p).join('') +
    `<p style="margin:24px 0 0;font-size:13px;color:#78716c">${escapeHtml(brand.name)}</p>` +
    `<p style="margin:8px 0 0;font-size:12px;color:#78716c">${escapeHtml(privacyLine(lang))}</p>` +
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
  let alerted = false // in this window
  const roll = () => {
    const t = now()
    if (t - windowStart >= HOUR_MS) { windowStart = t; used = 0; dropped = 0; alerted = false }
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
    /** True once per window: the first drop alerts the operator. */
    alertDue() { roll(); if (alerted) return false; alerted = true; return true },
    /** Milliseconds until the window ends and mails go out again. */
    get resetsInMs() { roll(); return Math.max(0, windowStart + HOUR_MS - now()) },
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
    async sendOps() { return { sent: false, skipped: 'disabled' } },
    async sendUser() { return { sent: false, skipped: 'disabled' } },
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
 * @param {{account?: number, confirm?: number, notify?: number, scoresheet?: number, scoresheet_test?: number, user?: number}} [o.budgets]  per hour, see DEFAULT_BUDGETS
 * @param {number} [o.maxPerInbox]    reset + confirm mails per inbox and hour (and, counted apart, sendUser's)
 * @param {object} [o.logger]
 */
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const hmacSha256 = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * AWS Signature Version 4 of one request with an empty query string: the
 * `authorization` and `x-amz-date` headers (host and x-amz-date are signed).
 * `path` must already be URI-encoded.
 */
export function sigV4({ method, host, path, body = '', region, service, accessKeyId, secretAccessKey, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${region}/${service}/aws4_request`
  const canonical = [method, path, '', `host:${host}\nx-amz-date:${amzDate}\n`, 'host;x-amz-date', sha256Hex(body)].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')
  const key = [day, region, service, 'aws4_request'].reduce((k, part) => hmacSha256(k, part), `AWS4${secretAccessKey}`)
  return {
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=host;x-amz-date, Signature=${hmacSha256(key, toSign).toString('hex')}`
  }
}

const SES_TIMEOUT_MS = 20_000

/**
 * A nodemailer transport that hands the finished message (headers, text,
 * HTML, attachments: nodemailer builds it as for SMTP) to the Amazon SES
 * HTTPS API (v2 SendEmail, raw content), signed with an IAM key that may
 * ses:SendRawEmail. For the Regions without an SMTP endpoint (Europe
 * (Zurich), eu-central-2). Errors: code 'ESES' with the HTTP status as
 * responseCode, 'ETIMEDOUT' after SES_TIMEOUT_MS.
 */
export function sesTransport({ region, accessKeyId, secretAccessKey, fetch = globalThis.fetch, now = () => new Date() }) {
  const host = `email.${region}.amazonaws.com`
  const path = '/v2/email/outbound-emails'
  return {
    name: 'ses-api',
    version: '1',
    send(mail, done) {
      const chunks = []
      const stream = mail.message.createReadStream()
      stream.on('error', done)
      stream.on('data', (c) => chunks.push(c))
      stream.on('end', async () => {
        try {
          const envelope = mail.message.getEnvelope()
          const body = JSON.stringify({ Destination: { ToAddresses: envelope.to }, Content: { Raw: { Data: Buffer.concat(chunks).toString('base64') } } })
          const res = await fetch(`https://${host}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...sigV4({ method: 'POST', host, path, body, region, service: 'ses', accessKeyId, secretAccessKey, now: now() }) },
            body,
            signal: AbortSignal.timeout(SES_TIMEOUT_MS)
          })
          const text = await res.text()
          if (!res.ok) throw Object.assign(new Error(`Amazon SES answered ${res.status}: ${text.slice(0, 300)}`), { code: 'ESES', responseCode: res.status })
          let messageId = null
          try { messageId = JSON.parse(text).MessageId ?? null } catch { /* sent; the id is only for the log */ }
          done(null, { messageId, envelope, response: `SES ${res.status}` })
        } catch (err) {
          if (err?.name === 'TimeoutError') err.code = 'ETIMEDOUT'
          done(err)
        }
      })
    }
  }
}

/**
 * The Amazon SES API account of the environment (SES_REGION,
 * SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY: all three): null when none is
 * set, { reason } when it is half-set or the Region is not one, else
 * { region, keyHint, transport }. The Region is checked because it becomes
 * part of the host name.
 */
export function sesFromEnv(env = process.env) {
  const region = (env.SES_REGION || '').trim()
  const accessKeyId = (env.SES_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = env.SES_SECRET_ACCESS_KEY || ''
  if (!region && !accessKeyId && !secretAccessKey) return null
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return { reason: 'SES_REGION is not an AWS Region (for example eu-central-2)' }
  if (!accessKeyId || !secretAccessKey) return { reason: !accessKeyId ? 'SES_ACCESS_KEY_ID not set' : 'SES_SECRET_ACCESS_KEY not set' }
  return { region, keyHint: `…${accessKeyId.slice(-4)}`, transport: nodemailer.createTransport(sesTransport({ region, accessKeyId, secretAccessKey })) }
}

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
  const maxPerInbox = Number.isInteger(o.maxPerInbox) && o.maxPerInbox > 0 ? o.maxPerInbox : DEFAULT_MAX_PER_INBOX
  const perInbox = inboxCounter(maxPerInbox, o.now)
  // sendUser's mails per inbox: apart from the reset and confirmation mails
  const userInbox = inboxCounter(maxPerInbox, o.now)
  const kindInbox = Object.fromEntries(Object.entries(KIND_INBOX_MAX).map(([kind, max]) => [kind, inboxCounter(max, o.now)]))
  // The operator's own mails (sendOps): their own small budget, never one of the users'
  const opsBudget = hourlyBudget(Number.isInteger(o.opsPerHour) && o.opsPerHour > 0 ? o.opsPerHour : OPS_PER_HOUR, o.now)
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

  async function send(kind, { to, lang, link, app, vars, attachments } = {}) {
    if (!MAIL_KINDS.includes(kind)) throw new Error(`mailer: unknown mail kind ${kind}`)
    if (typeof to !== 'string' || !to.includes('@')) throw new Error('mailer: no recipient')
    // Files only on the scoresheet mails, and only PDFs held in memory
    const files = attachments ?? []
    if (files.length && (!ATTACHING.has(kind) || !files.every((f) => Buffer.isBuffer(f?.content) && /^[^/\\]{1,120}\.pdf$/i.test(f?.filename || '')))) {
      throw new Error(`mailer: ${kind} takes no such attachment`)
    }
    const budgetName = MAIL_BUDGET_OF[kind]
    const budget = budgets[budgetName]
    if (!budget.take()) {
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] hourly ${budgetName} budget (${budget.max}) used up; ${kind} mail to ${maskEmail(to)} dropped`)
      // The operator hears of it once per window (an error line, as the
      // storage alerts; stats() lists it under exhausted)
      if (budget.alertDue()) log.error(`[mail] ALERT: the hourly ${budgetName} mail budget (${budget.max}) is used up; mails are dropped until the window ends (raise ${BUDGET_ENV[budgetName] || 'it'} if this is real traffic)`)
      return { sent: false, skipped: 'budget' }
    }
    if (INBOX_CAPPED.has(kind) && !perInbox.take(inboxKey(to))) {
      budget.refund()
      counters.inboxDropped++
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] ${perInbox.max} mails per hour to one inbox reached; ${kind} mail to ${maskEmail(to)} dropped`)
      return { sent: false, skipped: 'inbox' }
    }
    if (kindInbox[kind] && !kindInbox[kind].take(inboxKey(to))) {
      budget.refund()
      counters.inboxDropped++
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] ${kindInbox[kind].max} ${kind} mails per hour to one inbox reached; mail to ${maskEmail(to)} dropped`)
      return { sent: false, skipped: 'inbox' }
    }
    const brand = mailBrandOf(kind, app)
    const { subject, text, html } = renderMail(kind, lang, { link, app: brand, vars })
    try {
      await transport.sendMail({
        from: brands[brand].from,
        to,
        subject,
        text,
        html,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, content: f.content, contentType: 'application/pdf' })) } : {}),
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

  /**
   * A mail to the operator (lib/errorAlerts.js: the error digest), rendered
   * by the caller, in English only: not one of the users' mail kinds, no
   * template, its own budget (OPS_PER_HOUR). Throws when the send fails.
   */
  async function sendOps({ to, subject, text, html } = {}) {
    if (typeof to !== 'string' || !to.includes('@')) throw new Error('mailer: no recipient')
    if (typeof subject !== 'string' || !subject || typeof text !== 'string') throw new Error('mailer: an ops mail needs a subject and a text')
    if (!opsBudget.take()) {
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] hourly ops budget (${opsBudget.max}) used up; mail to ${maskEmail(to)} dropped`)
      return { sent: false, skipped: 'budget' }
    }
    try {
      await transport.sendMail({
        from: brands.indoor.from,
        to,
        subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
        text,
        ...(typeof html === 'string' ? { html } : {}),
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        disableFileAccess: true,
        disableUrlAccess: true
      })
    } catch (err) {
      opsBudget.refund()
      counters.failed++
      counters.lastFailureAt = new Date().toISOString()
      throw err
    }
    counters.sent++
    return { sent: true }
  }

  /**
   * A mail a signed-in user asks for to its own address (server.js: the game
   * PIN, the match information), rendered by the caller: plain text, from
   * OpenVolley's sender, no kind and no template. Budget "user", and at most
   * maxPerInbox an hour to one delivered inbox (inboxKey), counted apart from
   * the reset and confirmation mails. A mail over a limit is dropped and
   * logged with the address masked; the caller decides what to answer.
   * Throws when the send fails.
   */
  async function sendUser({ to, subject, text } = {}) {
    if (typeof to !== 'string' || !to.includes('@')) throw new Error('mailer: no recipient')
    if (typeof subject !== 'string' || !subject || typeof text !== 'string' || !text) throw new Error('mailer: a user mail needs a subject and a text')
    const budget = budgets.user
    if (!budget.take()) {
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] hourly user budget (${budget.max}) used up; mail to ${maskEmail(to)} dropped`)
      if (budget.alertDue()) log.error(`[mail] ALERT: the hourly user mail budget (${budget.max}) is used up; mails are dropped until the window ends (raise ${BUDGET_ENV.user} if this is real traffic)`)
      return { sent: false, skipped: 'budget' }
    }
    if (!userInbox.take(inboxKey(to))) {
      budget.refund()
      counters.inboxDropped++
      counters.lastDropAt = new Date().toISOString()
      log.warn(`[mail] ${userInbox.max} user mails per hour to one inbox reached; mail to ${maskEmail(to)} dropped`)
      return { sent: false, skipped: 'inbox' }
    }
    try {
      await transport.sendMail({
        from: brands.indoor.from,
        to,
        subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
        text,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        disableFileAccess: true,
        disableUrlAccess: true
      })
    } catch (err) {
      budget.refund()
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
    sendOps,
    sendUser,
    stats,
    close() { try { transport.close?.() } catch { /* already closed */ } }
  }
}

/**
 * The mailer described by the environment, or a disabled one (with the reason)
 * when neither SMTP_HOST nor SMTP_PASS nor an Amazon SES account (sesFromEnv)
 * is set. With the SES account the mails go through its HTTPS API and SMTP_*
 * is not used here (it stays the support form's, lib/contact.js). Once one is set, mail is
 * meant to be on: a missing or unusable setting throws (the server does not
 * start), instead of silently turning mail off, which would also confirm
 * every sign-up at once. Never logs the password.
 */
export function mailerFromEnv(env = process.env, opts = {}) {
  const host = (env.SMTP_HOST || '').trim()
  const pass = env.SMTP_PASS || ''
  if (!host && !pass && sesFromEnv(env) === null) return disabledMailer('SMTP_HOST not set')
  const m = mailerFromSettings(env, opts)
  if (!m.enabled) throw new Error(`mail settings unusable: ${m.reason}`)
  return m
}

function mailerFromSettings(env, { logger, tls, maxPerHour, budgets, maxPerInbox } = {}) {
  // An Amazon SES account wins: the SMTP settings are then not checked here
  const ses = sesFromEnv(env)
  if (ses?.reason) return disabledMailer(ses.reason)
  const host = (env.SMTP_HOST || '').trim()
  const pass = env.SMTP_PASS || ''
  if (!ses && (!host || !pass)) return disabledMailer(!host ? 'SMTP_HOST not set' : 'SMTP_PASS not set')
  const user = (env.SMTP_USER || '').trim()
  if (!ses && !user) return disabledMailer('SMTP_USER not set')
  const portText = (env.SMTP_PORT || '').trim() || '465'
  const port = Number(portText)
  if (!ses && (!/^\d+$/.test(portText) || port < 1 || port > 65535)) return disabledMailer(`SMTP_PORT is not a port number: ${portText.slice(0, 20)}`)
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
  const sized = budgetsFromEnv(env)
  try {
    const mailer = createMailer({ ...(ses ? { transport: ses.transport } : { host, port, user, pass }), from, managerUrl, fromBeach, managerUrlBeach, logger, tls, maxPerHour, budgets: { ...sized.budgets, ...budgets }, maxPerInbox })
    // for the startup line
    mailer.route = ses ? `Amazon SES API ${ses.region} (key ${ses.keyHint})` : `SMTP ${host}:${port} as ${user}`
    const warnings = [...(beachNote ? [beachNote] : []), ...sized.warnings]
    if (warnings.length) mailer.warnings = warnings
    return mailer
  } catch (err) {
    return disabledMailer(err.message)
  }
}
