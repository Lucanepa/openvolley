/**
 * lib/mailer.js: language choice, links, templates, the env switch, and real
 * SMTP sessions against a local sink (tests/helpers/fakeSmtp.js) over
 * implicit TLS and STARTTLS with certificate checks on.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickLang, authLink, renderMail, maskEmail, mailerFromEnv, createMailer, transportOptions,
  inboxKey, describeMailError, disabledMailer, mailApp, mailBrandOf, brandFrom, beachManagerBase, privacyLine,
  MAIL_LANGS, MAIL_KINDS, MAIL_APPS, MAIL_BRANDS, DEFAULT_MANAGER_URL, DEFAULT_MANAGER_URL_BEACH, DEFAULT_BUDGETS, DEFAULT_MAX_PER_INBOX
} from '../lib/mailer.js'
import { startFakeSmtp, makeTestCert, linkToken, SMTP_USER, SMTP_PASS } from './helpers/fakeSmtp.js'

// The account mails come in both brands; the approval notices are OpenVolley's only
const APPROVAL_KINDS = ['approval', 'approval_pin_locked']
const ACCOUNT_KINDS = MAIL_KINDS.filter((k) => !APPROVAL_KINDS.includes(k))

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

  it('approval notices: the values on one line, escaped in HTML, in every language', () => {
    const vars = { slot: 'referee1', game: '#12 Home – Away', result: '25:20, 23:25', id: '6F1C2A9B', time: '07.10.2026 19:42', sender: 'Olga <b>Owner</b>\r\nBcc: evil@example.test' }
    for (const lang of MAIL_LANGS) {
      const m = renderMail('approval', lang, { link: DEFAULT_MANAGER_URL, vars })
      assert.ok(m.subject.includes('#12 Home – Away'), lang)
      assert.doesNotMatch(m.subject, /[\r\n]/)
      for (const v of ['25:20, 23:25', '6F1C2A9B', '07.10.2026 19:42']) assert.ok(m.text.includes(v), `${lang}: ${v}`)
      assert.ok(m.text.includes('Olga <b>Owner</b> Bcc: evil@example.test'), 'one line')
      assert.ok(m.html.includes('Olga &lt;b&gt;Owner&lt;/b&gt;'), 'escaped')
      assert.ok(!m.html.includes('<b>Owner'))
      const locked = renderMail('approval_pin_locked', lang, { link: DEFAULT_MANAGER_URL, vars: { game: '#12 A – B', until: '07.10.2026 20:00', disabled: false } })
      const blocked = renderMail('approval_pin_locked', lang, { link: DEFAULT_MANAGER_URL, vars: { game: '#12 A – B', until: '', disabled: true } })
      assert.ok(locked.text.includes('07.10.2026 20:00'), lang)
      assert.notEqual(locked.subject, blocked.subject)
    }
    assert.ok(renderMail('approval', 'en', { link: DEFAULT_MANAGER_URL, vars }).text.includes('as 1st referee'))
    assert.ok(!renderMail('approval', 'en', { link: DEFAULT_MANAGER_URL, vars: { ...vars, sender: '' } }).text.includes('Sent by'))
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
    starttls = await startFakeSmtp({ implicitTls: false, cert, rejectRcpt: (a) => a.startsWith('rejected.') })
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

  it('a recipient the server rejects: the error text is loggable without the address', async () => {
    const m = mailerFor(starttls)
    const to = 'rejected.victim.name@club.example'
    try {
      let caught
      await m.send('reset', { to, link: 'https://x.test/#reset?token=t' }).catch((err) => { caught = err })
      assert.ok(caught, 'the send failed')
      assert.ok(String(caught.message).includes(to) || String(caught.response || '').includes(to),
        'precondition: the raw SMTP error quotes the recipient')
      const line = describeMailError(caught)
      assert.equal(line.includes(to), false, line)
      assert.equal(line.includes('victim.name'), false, line)
      assert.match(line, /re\*\*\*@club\.example/)
      assert.match(line, /SMTP 550/)
      assert.equal(m.stats().failed, 1)
    } finally { m.close() }
  })
})

describe('mailer: inbox key and loggable errors', () => {
  it('inboxKey: plus-tags removed; Gmail dots and googlemail.com folded; other domains keep their dots', () => {
    assert.equal(inboxKey('Victim.Name+x@GMail.com'), 'victimname@gmail.com')
    assert.equal(inboxKey('v.i.c.t.i.m.n.a.m.e@googlemail.com'), 'victimname@gmail.com')
    assert.equal(inboxKey('victimname@gmail.com.'), 'victimname@gmail.com')
    assert.equal(inboxKey('anna.muster+club@example.ch'), 'anna.muster@example.ch', 'dots are significant elsewhere')
    assert.equal(inboxKey('+tag@example.ch'), '+tag@example.ch', 'a local part that starts with + is kept')
    assert.equal(inboxKey('...@gmail.com'), '...@gmail.com', 'never an empty local part')
  })
  it('describeMailError masks every address and keeps the codes', () => {
    const err = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <someone.else@club.ch>: Recipient address rejected; also a@b.ch"), { code: 'EENVELOPE', responseCode: 550 })
    const line = describeMailError(err)
    assert.equal(line.includes('someone.else@club.ch'), false)
    assert.equal(line.includes('a@b.ch'), false)
    assert.match(line, /^EENVELOPE SMTP 550 /)
    assert.match(line, /so\*\*\*@club\.ch/)
    assert.equal(describeMailError(undefined), 'unknown error')
    assert.ok(describeMailError(new Error('x'.repeat(1000))).length <= 300)
  })
})

describe('mailer: budgets and the per-inbox cap (stub transport)', () => {
  const stub = () => {
    const sent = []
    return { sent, transport: { async sendMail(m) { sent.push(m) }, close() {} } }
  }
  const link = 'https://x.test/#t?token=t'

  it('defaults: 50 + 50 per hour (100 in total, as before), 100 approval notices, 5 per inbox', () => {
    assert.deepEqual({ ...DEFAULT_BUDGETS }, { account: 50, confirm: 50, notify: 100 })
    assert.equal(DEFAULT_MAX_PER_INBOX, 5)
    const m = createMailer({ ...stub(), from: 'x <x@example.test>', logger: silent })
    const st = m.stats()
    assert.equal(st.budgets.account.max, 50)
    assert.equal(st.budgets.confirm.max, 50)
    assert.deepEqual(disabledMailer('SMTP_HOST not set').stats(), { enabled: false, reason: 'SMTP_HOST not set' })
  })

  it('confirmation mails cannot use up the budget of reset and password-changed mails', async () => {
    let t = 0
    const { sent, transport } = stub()
    const warnings = []
    const m = createMailer({ transport, from: 'x <x@example.test>', budgets: { account: 3, confirm: 4 }, now: () => t, logger: { ...silent, warn: (s) => warnings.push(s) } })
    for (let i = 0; i < 10; i++) await m.send('confirm', { to: `signup${i}@example.ch`, link })
    assert.equal(sent.length, 4, 'the confirm budget')
    assert.deepEqual(await m.send('reset', { to: 'owner@example.ch', link }), { sent: true }, 'reset has its own budget')
    assert.deepEqual(await m.send('password_changed', { to: 'owner@example.ch' }), { sent: true })
    const st = m.stats()
    assert.deepEqual(st.exhausted, ['confirm'])
    assert.equal(st.budgets.confirm.dropped, 6)
    assert.equal(st.budgets.account.used, 2)
    assert.ok(st.lastDropAt)
    assert.ok(warnings.some((w) => /confirm budget/.test(w) && !w.includes('signup9@')), 'logged, masked')
    t = 60 * 60 * 1000
    assert.equal(m.stats().budgets.confirm.used, 0, 'a new hour')
    assert.equal(m.stats().budgets.confirm.droppedTotal, 6)
  })

  it('one Gmail inbox gets at most 5 reset/confirm mails an hour, whatever the spelling; password_changed is not capped', async () => {
    let t = 0
    const { sent, transport } = stub()
    const m = createMailer({ transport, from: 'x <x@example.test>', now: () => t, logger: silent })
    const variants = ['victimname@gmail.com', 'victim.name@gmail.com', 'v.ictimname@gmail.com', 'vi.ctimname@googlemail.com',
      'Victim.Name+a@gmail.com', 'v.i.ctimname@gmail.com', 'victimn.ame@gmail.com']
    const results = []
    for (const to of variants) results.push((await m.send('confirm', { to, link })).skipped || 'sent')
    assert.deepEqual(results, ['sent', 'sent', 'sent', 'sent', 'sent', 'inbox', 'inbox'])
    assert.deepEqual(await m.send('reset', { to: 'victim.name@gmail.com', link }), { sent: false, skipped: 'inbox' })
    assert.deepEqual(await m.send('password_changed', { to: 'victim.name@gmail.com' }), { sent: true })
    assert.equal(sent.length, 6)
    const st = m.stats()
    assert.equal(st.inboxDropped, 3)
    assert.equal(st.budgets.confirm.used, 5, 'mails held back by the inbox cap do not use the budget')
    assert.equal((await m.send('confirm', { to: 'someone.else@gmail.com', link })).sent, true, 'other inboxes are not affected')
    t = 60 * 60 * 1000
    assert.equal((await m.send('confirm', { to: 'victimname@gmail.com', link })).sent, true, 'a new hour')
  })

  it('maxPerHour sets every budget at once (tests)', () => {
    const m = createMailer({ ...stub(), from: 'x <x@example.test>', maxPerHour: 7, logger: silent })
    assert.equal(m.stats().budgets.account.max, 7)
    assert.equal(m.stats().budgets.confirm.max, 7)
  })
})

describe('mailer: brands (OpenVolley / OpenBeach)', () => {
  const stub = () => {
    const sent = []
    return { sent, transport: { async sendMail(m) { sent.push(m) }, close() {} } }
  }
  const link = authLink(DEFAULT_MANAGER_URL_BEACH, 'reset', TOKEN, 'en')

  it('mailApp: an allowlist; only "beach" is OpenBeach, anything else (or nothing) OpenVolley', () => {
    assert.deepEqual([...MAIL_APPS], ['indoor', 'beach'])
    assert.equal(mailApp('beach'), 'beach')
    assert.equal(mailApp(' Beach '), 'beach')
    for (const v of [undefined, null, '', 'indoor', 'snow', 'beachx', ['beach'], { app: 'beach' }, 1]) assert.equal(mailApp(v), 'indoor', String(v))
    assert.equal(MAIL_BRANDS.beach.managerUrl, 'https://manager-beach.openvolley.app')
    assert.equal(MAIL_BRANDS.indoor.managerUrl, DEFAULT_MANAGER_URL)
  })

  it('ends every mail with the privacy policy in its language, as text (no extra link)', () => {
    const link = authLink(DEFAULT_MANAGER_URL, 'reset', TOKEN, 'en')
    const expected = {
      en: 'Privacy policy: openvolley.app/en/privacy',
      de: 'Datenschutzerklärung: openvolley.app/datenschutz',
      fr: 'Protection des données : openvolley.app/fr/confidentialite',
      it: 'Protezione dei dati: openvolley.app/it/privacy'
    }
    for (const lang of MAIL_LANGS) assert.equal(privacyLine(lang), expected[lang])
    assert.equal(privacyLine('de-CH'), expected.de)
    assert.equal(privacyLine('xx'), expected.en)
    for (const kind of MAIL_KINDS) {
      for (const lang of MAIL_LANGS) {
        for (const app of ['indoor', 'beach']) {
          const m = renderMail(kind, lang, { link, app })
          assert.ok(m.text.endsWith(`\n\n${expected[lang]}\n`), `${kind}/${lang}/${app} text`)
          assert.ok(m.html.includes(`>${expected[lang]}</p></div>`), `${kind}/${lang}/${app} html`)
        }
      }
    }
  })

  it('OpenVolley mails are unchanged when the app is indoor, unknown or absent', () => {
    for (const kind of MAIL_KINDS) {
      for (const lang of MAIL_LANGS) {
        const plain = renderMail(kind, lang, { link })
        for (const app of ['indoor', 'snow', undefined]) assert.deepEqual(renderMail(kind, lang, { link, app }), plain, `${kind}/${lang}/${app}`)
        assert.doesNotMatch(plain.text + plain.html + plain.subject, /OpenBeach/)
      }
    }
  })

  it('OpenBeach mails: its name everywhere, its own subjects, the shared-password note on reset and password_changed', () => {
    const subjects = new Set()
    for (const kind of ACCOUNT_KINDS) {
      for (const lang of MAIL_LANGS) {
        const m = renderMail(kind, lang, { link, app: 'beach' })
        const indoor = renderMail(kind, lang, { link })
        assert.ok(m.subject.includes('OpenBeach') && !subjects.has(m.subject), `${kind}/${lang} subject`)
        subjects.add(m.subject)
        assert.notEqual(m.subject, indoor.subject)
        assert.ok(m.text.includes('\n\n– OpenBeach\n\n'), `${kind}/${lang} signature`)
        assert.ok(m.html.includes('>OpenBeach</p>'), `${kind}/${lang} html footer`)
        assert.doesNotMatch(m.html, /<img|<script|<link|url\(|@import/i)
        assert.doesNotMatch(m.text + m.subject, /ß/, 'Swiss spelling')
        // OpenVolley appears only in the shared-password note
        const shared = m.text.split('\n\n').filter((p) => /OpenVolley/.test(p))
        assert.doesNotMatch(m.subject, /OpenVolley/)
        if (kind === 'confirm') {
          assert.equal(shared.length, 0, `${kind}/${lang}: no note`)
        } else {
          assert.equal(shared.length, 1, `${kind}/${lang}: one note`)
          assert.match(shared[0], /OpenVolley .* OpenBeach/)
          assert.ok(m.html.includes(shared[0]), `${kind}/${lang}: note in html`)
        }
        if (kind !== 'password_changed') assert.ok(m.text.includes(link))
      }
    }
    assert.ok(renderMail('reset', 'en', { link, app: 'beach' }).text.includes('This changes the password of your account for OpenVolley and OpenBeach.'))
  })

  it('the approval notices are OpenVolley\'s only: app beach changes nothing', () => {
    const vars = { slot: 'referee1', game: '#12 Home – Away', result: '25:20, 25:18, 25:22', id: '6F1C2A9B', time: '01.10.2026 20:15', sender: '', until: '', disabled: true }
    for (const kind of APPROVAL_KINDS) {
      assert.equal(mailBrandOf(kind, 'beach'), 'indoor')
      for (const lang of MAIL_LANGS) {
        const m = renderMail(kind, lang, { link, app: 'beach', vars })
        assert.deepEqual(m, renderMail(kind, lang, { link, vars }), `${kind}/${lang}`)
        assert.doesNotMatch(m.text + m.html + m.subject, /OpenBeach/)
      }
    }
    for (const kind of ACCOUNT_KINDS) assert.equal(mailBrandOf(kind, 'beach'), 'beach')
  })

  it('send(): the OpenBeach sender for app beach, OpenVolley otherwise; links per brand', async () => {
    const s = stub()
    const m = createMailer({ ...s, from: 'OpenVolley <noreply@openvolley.app>', logger: silent })
    assert.equal(m.fromFor('beach'), 'OpenBeach <noreply@openvolley.app>')
    assert.equal(m.fromFor('indoor'), 'OpenVolley <noreply@openvolley.app>')
    assert.equal(m.managerUrlFor('beach'), DEFAULT_MANAGER_URL_BEACH)
    assert.equal(m.managerUrlFor('snow'), DEFAULT_MANAGER_URL)
    await m.send('reset', { to: 'a@example.ch', lang: 'de', link, app: 'beach' })
    await m.send('reset', { to: 'b@example.ch', lang: 'de', link })
    await m.send('confirm', { to: 'c@example.ch', lang: 'it', link, app: 'https://evil.test' })
    assert.deepEqual(s.sent.map((x) => [x.from, x.subject]), [
      ['OpenBeach <noreply@openvolley.app>', 'OpenBeach-Passwort zurücksetzen'],
      ['OpenVolley <noreply@openvolley.app>', 'OpenVolley-Passwort zurücksetzen'],
      ['OpenVolley <noreply@openvolley.app>', 'Confermi il suo indirizzo e-mail per OpenVolley']
    ])
    m.close()
    const custom = createMailer({ ...stub(), from: 'x@example.test', fromBeach: 'Beach Team <beach@example.test>', managerUrlBeach: 'https://mb.example.test/', logger: silent })
    assert.equal(custom.fromFor('beach'), 'Beach Team <beach@example.test>')
    assert.equal(custom.managerUrlFor('beach'), 'https://mb.example.test')
    assert.equal(disabledMailer().managerUrlFor('beach'), DEFAULT_MANAGER_URL_BEACH)
  })

  it('the budgets and inbox caps are shared by both brands', async () => {
    const m = createMailer({ ...stub(), from: 'x <x@example.test>', logger: silent, maxPerInbox: 2 })
    assert.deepEqual(await m.send('reset', { to: 'same@example.ch', link, app: 'beach' }), { sent: true })
    assert.deepEqual(await m.send('reset', { to: 'same@example.ch', link }), { sent: true })
    assert.deepEqual(await m.send('confirm', { to: 'same@example.ch', link, app: 'beach' }), { sent: false, skipped: 'inbox' })
  })

  it('environment: MAIL_FROM_BEACH / MANAGER_URL_BEACH with sensible defaults; unusable values turn the mailer off', () => {
    const base = { SMTP_HOST: 'smtp.example.test', SMTP_PASS: 'secret', SMTP_USER: 'noreply@openvolley.app' }
    const d = mailerFromEnv(base)
    try {
      assert.equal(d.fromFor('beach'), 'OpenBeach <noreply@openvolley.app>')
      assert.equal(d.managerUrlFor('beach'), 'https://manager-beach.openvolley.app')
      assert.equal(d.from, 'OpenVolley <noreply@openvolley.app>', 'OpenVolley unchanged')
      assert.equal(d.managerUrl, 'https://manager.openvolley.app')
    } finally { d.close() }
    const fromMailFrom = mailerFromEnv({ ...base, SMTP_USER: 'login-name', MAIL_FROM: 'OpenVolley <noreply@openvolley.app>' })
    try { assert.equal(fromMailFrom.fromFor('beach'), 'OpenBeach <noreply@openvolley.app>', 'the address of MAIL_FROM') } finally { fromMailFrom.close() }
    const set = mailerFromEnv({ ...base, MAIL_FROM_BEACH: 'OpenBeach <beach@openvolley.app>', MANAGER_URL_BEACH: 'https://manager-beach.openvolley.app/' })
    try {
      assert.equal(set.fromFor('beach'), 'OpenBeach <beach@openvolley.app>')
      assert.equal(set.managerUrlFor('beach'), 'https://manager-beach.openvolley.app')
    } finally { set.close() }
    for (const [env, reason] of [
      [{ MANAGER_URL_BEACH: 'http://manager-beach.openvolley.app' }, /MANAGER_URL_BEACH must be an https URL/],
      [{ MANAGER_URL_BEACH: 'not a url' }, /MANAGER_URL_BEACH is not a URL/],
      [{ MAIL_FROM_BEACH: 'OpenBeach' }, /MAIL_FROM_BEACH/]
    ]) {
      const m = mailerFromEnv({ ...base, ...env })
      assert.equal(m.enabled, false)
      assert.match(m.reason, reason)
      assert.doesNotMatch(m.reason, /secret/)
    }
  })

  it('MANAGER_URL_BEACH unset follows MANAGER_URL: never the production OpenBeach manager from a dev / test backend (S2 review)', () => {
    const base = { SMTP_HOST: 'smtp.example.test', SMTP_PASS: 'secret', SMTP_USER: 'noreply@openvolley.app' }
    const cases = [
      // [MANAGER_URL, OpenBeach link base, a startup warning?]
      ['https://manager.openvolley.app/', 'https://manager-beach.openvolley.app', false],
      ['http://localhost:5173', 'http://localhost:5173/manager-beach.html', false],
      ['http://127.0.0.1:5173/manager.html', 'http://127.0.0.1:5173/manager-beach.html', false],
      ['https://staging.example.test/ov/manager.html', 'https://staging.example.test/ov/manager-beach.html', false],
      ['https://manager.example.test', 'https://manager.example.test', true]
    ]
    for (const [managerUrl, beach, warns] of cases) {
      const m = mailerFromEnv({ ...base, MANAGER_URL: managerUrl })
      try {
        assert.equal(m.enabled, true, managerUrl)
        assert.equal(m.managerUrlFor('beach'), beach, managerUrl)
        assert.notEqual(m.managerUrlFor('beach') === DEFAULT_MANAGER_URL_BEACH, managerUrl !== 'https://manager.openvolley.app/', managerUrl)
        assert.equal((m.warnings || []).length, warns ? 1 : 0, managerUrl)
        if (warns) assert.match(m.warnings[0], /MANAGER_URL_BEACH is not set/)
        const link = authLink(m.managerUrlFor('beach'), 'confirm', TOKEN, 'en')
        assert.ok(link.startsWith(beach + '/#confirm?token='), link)
      } finally { m.close() }
    }
    // Set explicitly: used as given, no warning, whatever MANAGER_URL is
    const set = mailerFromEnv({ ...base, MANAGER_URL: 'https://manager.example.test', MANAGER_URL_BEACH: 'https://mb.example.test' })
    try {
      assert.equal(set.managerUrlFor('beach'), 'https://mb.example.test')
      assert.equal(set.warnings, undefined)
    } finally { set.close() }
    assert.deepEqual(beachManagerBase(DEFAULT_MANAGER_URL), { url: DEFAULT_MANAGER_URL_BEACH, note: null })
  })

  it('brandFrom: the address of a sender under another name', () => {
    assert.equal(brandFrom('OpenBeach', 'OpenVolley <noreply@openvolley.app>'), 'OpenBeach <noreply@openvolley.app>')
    assert.equal(brandFrom('OpenBeach', '"Open Volley" <a@b.ch> '), 'OpenBeach <a@b.ch>')
    assert.equal(brandFrom('OpenBeach', 'a@b.ch'), 'OpenBeach <a@b.ch>')
    assert.equal(brandFrom('OpenBeach', 'OpenVolley'), '')
    assert.equal(brandFrom('OpenBeach', ''), '')
  })
})
