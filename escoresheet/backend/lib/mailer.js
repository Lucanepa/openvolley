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
 * Without SMTP_HOST or SMTP_PASS the mailer is disabled: lib/auth.js then
 * answers reset-password with 503 "temporarily unavailable" and confirms new
 * accounts at sign-up, exactly as before this module existed.
 *
 * TLS: implicit TLS on 465; on any other port STARTTLS is mandatory
 * (requireTLS), so the password never crosses the wire in clear. Certificates
 * are always verified (TLS 1.2+). Pooled connections, bounded timeouts.
 *
 * Mails: plain text plus a minimal HTML part, in en/de/fr/it. No tracking, no
 * remote images, no links other than the one action link. Recipients are
 * never logged in full (maskEmail).
 *
 * Public API:
 *   mailerFromEnv(env, { logger }) -> mailer      (disabled mailer when not configured)
 *   createMailer(options)          -> mailer
 *   disabledMailer(reason)         -> mailer
 *   mailer.enabled / mailer.reason / mailer.managerUrl
 *   mailer.send(kind, { to, lang, link }) -> Promise<{ sent, skipped? }>   kind: reset | confirm | password_changed
 *   mailer.close()
 *   renderMail(kind, lang, vars) -> { subject, text, html }
 *   pickLang(explicit, acceptLanguage) -> 'en' | 'de' | 'fr' | 'it'
 *   authLink(managerUrl, page, token, lang) -> string
 *   maskEmail(email)
 */

import nodemailer from 'nodemailer'

export const MAIL_LANGS = Object.freeze(['en', 'de', 'fr', 'it'])
export const MAIL_KINDS = Object.freeze(['reset', 'confirm', 'password_changed'])
export const DEFAULT_MANAGER_URL = 'https://manager.openvolley.app'
export const DEFAULT_FROM_NAME = 'OpenVolley'

// Outgoing account mails per hour, all recipients together: protects the
// mailbox's sending quota and reputation from a spread-out flood. A mail over
// the budget is dropped and logged (the request itself still succeeds, so the
// answer never tells whether a mail went out).
const DEFAULT_MAX_PER_HOUR = 100

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

/** { subject, text, html } of one account mail. vars: { link } (reset, confirm). */
export function renderMail(kind, lang, { link } = {}) {
  const set = T[kind]
  if (!set) throw new Error(`mailer: unknown mail kind ${kind}`)
  const m = set[langOf(lang) || 'en']
  if (m.button && !link) throw new Error(`mailer: ${kind} needs a link`)
  const textParts = [...m.before]
  if (m.button) textParts.push(link)
  textParts.push(...m.after, '– OpenVolley')
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
    '<p style="margin:24px 0 0;font-size:13px;color:#78716c">OpenVolley</p>' +
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
  return {
    max,
    take() {
      const t = now()
      if (t - windowStart >= 60 * 60 * 1000) { windowStart = t; used = 0 }
      if (used >= max) return false
      used++
      return true
    },
    get used() { return used }
  }
}

export function disabledMailer(reason = 'not configured') {
  return {
    enabled: false,
    reason,
    managerUrl: DEFAULT_MANAGER_URL,
    async send() { return { sent: false, skipped: 'disabled' } },
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
 * @param {object} [o.tls]          extra TLS options (tests: { ca }); rejectUnauthorized stays true
 * @param {boolean} [o.secure]      implicit TLS (default: port === 465)
 * @param {object} [o.transport]    a ready nodemailer-like { sendMail, close } (tests)
 * @param {number} [o.maxPerHour]
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
  const budget = hourlyBudget(o.maxPerHour || DEFAULT_MAX_PER_HOUR, o.now)
  const managerUrl = String(o.managerUrl || DEFAULT_MANAGER_URL).replace(/\/+$/, '')

  async function send(kind, { to, lang, link } = {}) {
    if (!MAIL_KINDS.includes(kind)) throw new Error(`mailer: unknown mail kind ${kind}`)
    if (typeof to !== 'string' || !to.includes('@')) throw new Error('mailer: no recipient')
    if (!budget.take()) {
      log.warn(`[mail] hourly budget used up; ${kind} mail to ${maskEmail(to)} dropped`)
      return { sent: false, skipped: 'budget' }
    }
    const { subject, text, html } = renderMail(kind, lang, { link })
    await transport.sendMail({
      from: o.from,
      to,
      subject,
      text,
      html,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      disableFileAccess: true,
      disableUrlAccess: true
    })
    return { sent: true }
  }

  return {
    enabled: true,
    reason: null,
    managerUrl,
    from: o.from,
    budget,
    send,
    close() { try { transport.close?.() } catch { /* already closed */ } }
  }
}

/**
 * The mailer described by the environment, or a disabled one (with the reason)
 * when SMTP_HOST or SMTP_PASS is missing or the settings are invalid. Never
 * throws and never logs the password.
 */
export function mailerFromEnv(env = process.env, { logger, tls, maxPerHour } = {}) {
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
  let managerUrl = (env.MANAGER_URL || '').trim() || DEFAULT_MANAGER_URL
  try {
    const u = new URL(managerUrl)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
      return disabledMailer('MANAGER_URL must be an https URL')
    }
    managerUrl = u.origin + u.pathname.replace(/\/+$/, '')
  } catch {
    return disabledMailer('MANAGER_URL is not a URL')
  }
  try {
    return createMailer({ host, port, user, pass, from, managerUrl, logger, tls, maxPerHour })
  } catch (err) {
    return disabledMailer(err.message)
  }
}
