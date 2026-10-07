/**
 * lib/mailer.js: language choice, links, templates, the env switch, and real
 * SMTP sessions against a local sink (tests/helpers/fakeSmtp.js) over
 * implicit TLS and STARTTLS with certificate checks on.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickLang, authLink, renderMail, maskEmail, mailerFromEnv, createMailer, transportOptions,
  MAIL_LANGS, MAIL_KINDS, DEFAULT_MANAGER_URL
} from '../lib/mailer.js'
import { startFakeSmtp, makeTestCert, linkToken, SMTP_USER, SMTP_PASS } from './helpers/fakeSmtp.js'

const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21)
const silent = { log() {}, warn() {}, error() {} }

describe('mailer: language', () => {
  it('takes the explicit lang first; de-CH and other regions map to the base language', () => {
    assert.equal(pickLang('de-CH'), 'de')
    assert.equal(pickLang('fr_CH'), 'fr')
    assert.equal(pickLang('IT'), 'it')
    assert.equal(pickLang('rm', 'it'), 'it', 'unsupported explicit lang falls through to the header')
  })
  it('reads Accept-Language by q and order, English otherwise', () => {
    assert.equal(pickLang(undefined, 'de-CH,de;q=0.9,en;q=0.8'), 'de')
    assert.equal(pickLang(null, 'rm;q=1, fr;q=0.4, it;q=0.7'), 'it')
    assert.equal(pickLang(null, 'es, ja'), 'en')
    assert.equal(pickLang(null, 'fr;q=0'), 'en')
    assert.equal(pickLang(null, 'x'.repeat(600)), 'en')
    assert.equal(pickLang(), 'en')
  })
})

describe('mailer: links and templates', () => {
  it('builds a fragment link (the token never reaches a server log)', () => {
    assert.equal(authLink('https://manager.openvolley.app/', 'reset', TOKEN, 'de'),
      `https://manager.openvolley.app/#reset?token=${TOKEN}&lang=de`)
    assert.equal(authLink(undefined, 'confirm', TOKEN), `${DEFAULT_MANAGER_URL}/#confirm?token=${TOKEN}`)
  })

  it('renders every kind in every language: link in text and html, no remote content', () => {
    const link = authLink(DEFAULT_MANAGER_URL, 'reset', TOKEN, 'en')
    const subjects = new Set()
    for (const kind of MAIL_KINDS) {
      for (const lang of MAIL_LANGS) {
        const m = renderMail(kind, lang, { link })
        assert.ok(m.subject && !subjects.has(m.subject), `${kind}/${lang} has its own subject`)
        subjects.add(m.subject)
        assert.ok(m.text.endsWith('\n'))
        assert.doesNotMatch(m.html, /<img|<script|<link|url\(|@import/i, 'no remote images, scripts or styles')
        assert.doesNotMatch(m.text + m.subject, /ß/, 'Swiss spelling')
        const urls = (m.html.match(/https?:\/\/[^"<\s]+/g) || [])
        if (kind === 'password_changed') {
          assert.equal(urls.length, 0, 'the notice carries no link')
          assert.doesNotMatch(m.text, /https?:/)
        } else {
          assert.ok(m.text.includes(link), `${kind}/${lang} text has the link`)
          assert.ok(urls.length > 0 && urls.every((u) => u.replace(/&amp;/g, '&') === link), `${kind}/${lang} html links only the action`)
          assert.equal(linkToken({ text: m.text }).token, TOKEN)
        }
      }
    }
    assert.equal(renderMail('reset', 'de-CH', { link }).subject, renderMail('reset', 'de', { link }).subject)
    assert.equal(renderMail('reset', 'xx', { link }).subject, renderMail('reset', 'en', { link }).subject)
    assert.throws(() => renderMail('reset', 'en', {}), /needs a link/)
    assert.throws(() => renderMail('spam', 'en', { link }), /unknown mail kind/)
  })

  it('escapes the link in HTML', () => {
    const m = renderMail('confirm', 'en', { link: 'https://x.test/#confirm?token=a&lang=en"><b>' })
    assert.ok(m.html.includes('token=a&amp;lang=en&quot;&gt;&lt;b&gt;'))
    assert.ok(!m.html.includes('"><b>'))
  })

  it('masks addresses for logs', () => {
    assert.equal(maskEmail('anna.muster@example.ch'), 'an***@example.ch')
    assert.equal(maskEmail('a@b.ch'), 'a***@b.ch')
    assert.equal(maskEmail('nope'), '***')
  })
})

describe('mailer: configuration from the environment', () => {
  const base = { SMTP_HOST: 'smtp.example.test', SMTP_PASS: 'secret', SMTP_USER: 'noreply@openvolley.app' }

  it('is disabled without SMTP_HOST or SMTP_PASS (the server then behaves as before)', async () => {
    for (const env of [{}, { SMTP_HOST: 'smtp.example.test' }, { SMTP_PASS: 'x' }, { ...base, SMTP_HOST: '  ' }]) {
      const m = mailerFromEnv(env)
      assert.equal(m.enabled, false)
      assert.match(m.reason, /SMTP_(HOST|PASS) not set/)
      assert.deepEqual(await m.send('reset', { to: 'a@b.ch', link: 'x' }), { sent: false, skipped: 'disabled' })
    }
  })

  it('refuses incomplete or unsafe settings without throwing, and never echoes the password', () => {
    const reasons = [
      { ...base, SMTP_USER: '' },
      { ...base, SMTP_PORT: 'abc' },
      { ...base, SMTP_PORT: '70000' },
      { ...base, SMTP_USER: 'noreply', MAIL_FROM: '' },
      { ...base, MANAGER_URL: 'http://manager.openvolley.app' },
      { ...base, MANAGER_URL: 'not a url' }
    ].map((env) => mailerFromEnv(env))
    for (const m of reasons) {
      assert.equal(m.enabled, false)
      assert.doesNotMatch(m.reason, /secret/)
    }
  })

  it('defaults: port 465, from = OpenVolley <SMTP_USER>, links to manager.openvolley.app', () => {
    const m = mailerFromEnv(base)
    try {
      assert.equal(m.enabled, true)
      assert.equal(m.from, 'OpenVolley <noreply@openvolley.app>')
      assert.equal(m.managerUrl, 'https://manager.openvolley.app')
    } finally { m.close() }
    const m2 = mailerFromEnv({ ...base, MAIL_FROM: 'OpenVolley <noreply@openvolley.app>', MANAGER_URL: 'https://manager.openvolley.app/' })
    try { assert.equal(m2.managerUrl, 'https://manager.openvolley.app') } finally { m2.close() }
  })

  it('transport: implicit TLS on 465, mandatory STARTTLS otherwise, certificate checks always on', () => {
    const t465 = transportOptions({ host: 'smtp.migadu.com', port: 465, user: 'u', pass: 'p' })
    assert.equal(t465.secure, true)
    assert.equal(t465.tls.rejectUnauthorized, true)
    assert.equal(t465.tls.servername, 'smtp.migadu.com')
    assert.equal(t465.pool, true)
    assert.ok(t465.connectionTimeout > 0 && t465.socketTimeout > 0 && t465.greetingTimeout > 0)
    const t587 = transportOptions({ host: 'smtp.migadu.com', port: 587, user: 'u', pass: 'p', tls: { rejectUnauthorized: false } })
    assert.equal(t587.secure, false)
    assert.equal(t587.requireTLS, true)
    assert.equal(t587.ignoreTLS, false)
    assert.equal(t587.tls.rejectUnauthorized, true, 'cannot be switched off')
  })
})

describe('mailer: SMTP sessions against a local sink', () => {
  let cert, implicit, starttls
  before(async () => {
    cert = makeTestCert()
    implicit = await startFakeSmtp({ implicitTls: true, cert })
    starttls = await startFakeSmtp({ implicitTls: false, cert })
  })
  after(async () => {
    await implicit?.close()
    await starttls?.close()
    cert?.remove()
  })

  const mailerFor = (smtp, extra = {}) => createMailer({
    host: 'localhost', port: smtp.port, user: SMTP_USER, pass: SMTP_PASS,
    from: 'OpenVolley <noreply@example.test>', managerUrl: 'https://manager.example.test', tls: { ca: cert.cert }, logger: silent, ...extra
  })

  for (const mode of ['implicit TLS', 'STARTTLS']) {
    it(`delivers a reset mail over ${mode} with authentication`, async () => {
      const smtp = mode === 'STARTTLS' ? starttls : implicit
      // The sink runs on a random port: implicit TLS is chosen explicitly
      // (from the environment it follows the port, 465 = implicit).
      const mailer = mailerFor(smtp, { secure: mode === 'implicit TLS' })
      try {
        const link = authLink(mailer.managerUrl, 'reset', TOKEN, 'fr')
        assert.deepEqual(await mailer.send('reset', { to: 'anna@example.ch', lang: 'fr', link }), { sent: true })
        const mail = await smtp.waitForMail((x) => x.to.includes('anna@example.ch'))
        assert.equal(mail.secure, true, 'the session was encrypted')
        assert.equal(mail.subject, 'Réinitialiser votre mot de passe OpenVolley')
        assert.match(mail.from, /noreply@example\.test/)
        assert.equal(mail.headers['auto-submitted'], 'auto-generated')
        assert.deepEqual(linkToken(mail), { url: link, page: 'reset', token: TOKEN, lang: 'fr' })
        assert.ok(mail.html.includes('Choisir un nouveau mot de passe'))
        assert.ok(smtp.auths.every((a) => a.secure), 'AUTH only inside TLS')
      } finally { mailer.close() }
    })
  }

  it('refuses a server whose certificate it does not trust', async () => {
    const m = createMailer({ host: 'localhost', port: starttls.port, user: SMTP_USER, pass: SMTP_PASS, from: 'x <x@example.test>', logger: silent })
    try {
      await assert.rejects(() => m.send('reset', { to: 'b@example.ch', link: 'https://x.test/#reset?token=t' }),
        (err) => /certificate|self.signed/i.test(err.message))
      assert.equal(starttls.mails.some((x) => x.to.includes('b@example.ch')), false)
    } finally { m.close() }
  })

  it('refuses wrong credentials', async () => {
    const m = mailerFor(starttls, { pass: 'wrong' })
    try {
      await assert.rejects(() => m.send('reset', { to: 'c@example.ch', link: 'https://x.test/#reset?token=t' }), /Invalid|auth/i)
    } finally { m.close() }
  })

  it('drops mails over the hourly budget without failing', async () => {
    let t = 0
    const m = mailerFor(starttls, { maxPerHour: 2, now: () => t })
    try {
      const link = 'https://x.test/#confirm?token=t'
      assert.equal((await m.send('confirm', { to: 'd1@example.ch', link })).sent, true)
      assert.equal((await m.send('confirm', { to: 'd2@example.ch', link })).sent, true)
      assert.deepEqual(await m.send('confirm', { to: 'd3@example.ch', link }), { sent: false, skipped: 'budget' })
      t = 60 * 60 * 1000
      assert.equal((await m.send('confirm', { to: 'd4@example.ch', link })).sent, true, 'a new hour')
    } finally { m.close() }
  })
})
