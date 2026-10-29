/**
 * lib/contact.js, the support form: the multipart parser (against bodies
 * serialised by Node's own FormData, as a browser sends them), the limits,
 * the file types by their bytes, the field checks, the honeypot, and the one
 * mail. No mail is ever sent: the transport is nodemailer's streamTransport,
 * which composes the real message in memory (so its headers can be read) and
 * delivers it nowhere, or a stub.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import {
  parseMultipart, parseContactBody, boundaryOf, sniffFile, safeFilename, checkAttachments, normalizeContact,
  areaOf, pageUrlOf, firstWords, supportSubject, buildSupportMail, handleContact, isHoneypotHit,
  createContactMailer, contactMailerFromEnv, disabledContactMailer, ContactError,
  SECTION_IDS, SECTION_NAMES, CONTACT_AREAS, LEGACY_AREAS, MAX_FILES, MAX_FILES_BYTES, MAX_PARTS
} from '../lib/contact.js'

const silent = { log() {}, warn() {}, error() {} }

// Real file starts (enough for the signatures)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-test-image-bytes')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-test')])
const GIF = Buffer.from('GIF89a-test')
const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 test', 'latin1')
const HEIC = Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic', 'latin1')
const PDF = Buffer.from('%PDF-1.7\n%test\n')
const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1')
const BACKUP = Buffer.from(JSON.stringify({ match: { gameN: 4711, home: 'Testteam A', away: 'Testteam B' } }))

/** A multipart body exactly as fetch / a browser serialises a FormData. */
async function formBody(entries) {
  const fd = new FormData()
  for (const [name, value, filename, type] of entries) {
    if (Buffer.isBuffer(value)) fd.append(name, new Blob([value], { type: type || 'application/octet-stream' }), filename)
    else fd.append(name, value)
  }
  const req = new Request('http://contact.test/api/contact', { method: 'POST', body: fd })
  return { body: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get('content-type') }
}

const VALID = [
  ['contactType', 'support'],
  ['area', 'scoring'],
  ['supportType', 'bug'],
  ['severity', '2'],
  ['email', 'tester@example.ch'],
  ['comments', 'Undo does nothing after a time-out in set 2.\nSteps: start rally, point, time-out, undo.'],
  ['source', 'app'],
  ['language', 'de-CH'],
  ['appVersion', '3.0.6'],
  ['platform', 'android'],
  ['url', 'https://app.openvolley.app/referee?pin=123456#x'],
  ['userAgent', 'Mozilla/5.0 (Linux; Android 14) test'],
  ['timestamp', '2026-10-29T10:00:00.000Z']
]

/** A mailer over streamTransport: composes the mail, sends nothing; `raw` the RFC 822 text of each. */
function streamMailer(opts = {}) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  const sent = []
  const wrapped = {
    async sendMail(mail) {
      const info = await transport.sendMail(mail)
      sent.push({ mail, raw: info.message.toString('utf8'), envelope: info.envelope })
      return info
    }
  }
  const mailer = createContactMailer({ transport: wrapped, from: 'OpenVolley <noreply@example.test>', to: 'support@example.test', ...opts })
  return { mailer, sent }
}

/** The header block of a raw message, folded lines joined. */
function headersOf(raw) {
  return raw.split('\n\n')[0].replace(/\n[ \t]+/g, ' ')
}

describe('contact: multipart parser', () => {
  it('reads the fields and files of a browser-made body, bytes intact, UTF-8 names', async () => {
    const { body, contentType } = await formBody([
      ...VALID,
      ['comments', 'a second comments field is ignored'],
      ['files', PNG, 'Bildschirmfoto Spielstand ä.png', 'image/png'],
      ['files', BACKUP, 'backup.json', 'application/json']
    ])
    const { fields, files } = parseMultipart(body, contentType)
    assert.equal(fields.contactType, 'support')
    assert.equal(fields.email, 'tester@example.ch')
    assert.match(fields.comments, /^Undo does nothing after a time-out in set 2\.\r?\nSteps/)
    assert.equal(files.length, 2)
    assert.equal(files[0].field, 'files')
    assert.equal(files[0].filename, 'Bildschirmfoto Spielstand ä.png')
    assert.ok(files[0].data.equals(PNG))
    assert.ok(files[1].data.equals(BACKUP))
  })

  it('skips an empty file input, reads a preamble and a quoted boundary', async () => {
    const empty = await formBody([['contactType', 'feedback'], ['files', Buffer.alloc(0), '', 'application/octet-stream']])
    assert.equal(parseMultipart(empty.body, empty.contentType).files.length, 0)

    const raw = Buffer.from([
      'this is a preamble',
      '--b-1',
      'Content-Disposition: form-data; name="email"',
      '',
      'tester@example.ch',
      '--b-1',
      'Content-Disposition: form-data; name="files"; filename="x.txt"; filename*=UTF-8\'\'Spielbericht%20%C3%A4.txt',
      'Content-Type: text/plain',
      '',
      'line 1',
      '--b-1--',
      ''
    ].join('\r\n'))
    const r = parseMultipart(raw, 'multipart/form-data; boundary="b-1"')
    assert.equal(r.fields.email, 'tester@example.ch')
    assert.equal(r.files[0].filename, 'Spielbericht ä.txt')
    assert.equal(r.files[0].data.toString(), 'line 1')
  })

  it('refuses a malformed body', () => {
    const ct = 'multipart/form-data; boundary=b'
    const cases = [
      '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nno closing boundary',
      'no boundary at all',
      '--b\r\nContent-Disposition: attachment; name="a"\r\n\r\nx\r\n--b--',
      '--b\r\nContent-Disposition: form-data\r\n\r\nno name\r\n--b--',
      '--b\r\nContent-Disposition: form-data; name="a"\r\nno blank line\r\n--b--'
    ]
    for (const text of cases) {
      assert.throws(() => parseMultipart(Buffer.from(text), ct), (e) => e instanceof ContactError && e.code === 'invalid_body' && e.status === 400, text)
    }
    assert.equal(boundaryOf('application/json'), null)
    assert.equal(boundaryOf('multipart/form-data'), null)
    assert.throws(() => parseContactBody(Buffer.from('x'), 'text/plain'), (e) => e.code === 'invalid_body')
  })

  it('stops at the limits: parts, field size, file count, total size', async () => {
    const many = await formBody(Array.from({ length: MAX_PARTS + 1 }, (_, i) => [`f${i}`, 'x']))
    assert.throws(() => parseMultipart(many.body, many.contentType), (e) => e.code === 'too_many_parts' && e.status === 400)

    const long = await formBody([['comments', 'x'.repeat(64 * 1024 + 1)]])
    assert.throws(() => parseMultipart(long.body, long.contentType), (e) => e.code === 'field_too_large')

    const six = await formBody(Array.from({ length: MAX_FILES + 1 }, (_, i) => ['files', PNG, `s${i}.png`, 'image/png']))
    assert.throws(() => parseMultipart(six.body, six.contentType), (e) => e.code === 'too_many_files' && e.status === 400 && e.extra.maxFiles === MAX_FILES)

    const half = Buffer.alloc(MAX_FILES_BYTES / 2, 0x41)
    const big = await formBody([['files', half, 'a.txt', 'text/plain'], ['files', Buffer.concat([half, Buffer.from('A')]), 'b.txt', 'text/plain']])
    assert.throws(() => parseMultipart(big.body, big.contentType), (e) => e.code === 'files_too_large' && e.status === 413)

    const exact = await formBody([['files', half, 'a.txt', 'text/plain'], ['files', half, 'b.txt', 'text/plain']])
    assert.equal(parseMultipart(exact.body, exact.contentType).files.length, 2, 'exactly 10 MB is allowed')
  })

  it('still reads a JSON body (no files)', () => {
    const r = parseContactBody(Buffer.from(JSON.stringify({ contactType: 'feedback', severity: 3, diagnostics: { a: 1 }, nested: { x: 1 } })), 'application/json')
    assert.deepEqual(r, { fields: { contactType: 'feedback', severity: '3', diagnostics: '{"a":1}' }, files: [] })
    assert.throws(() => parseContactBody(Buffer.from('[1]'), 'application/json'), (e) => e.code === 'invalid_body')
  })
})

describe('contact: file types by their bytes', () => {
  it('knows images, PDF, text and JSON', () => {
    assert.deepEqual(sniffFile(PNG, 'a.png'), { mime: 'image/png', ext: 'png' })
    assert.deepEqual(sniffFile(JPEG, 'a.JPEG'), { mime: 'image/jpeg', ext: 'jpeg' })
    assert.deepEqual(sniffFile(GIF, 'a.gif'), { mime: 'image/gif', ext: 'gif' })
    assert.deepEqual(sniffFile(WEBP, 'a.webp'), { mime: 'image/webp', ext: 'webp' })
    assert.deepEqual(sniffFile(HEIC, 'IMG_0001.HEIC'), { mime: 'image/heic', ext: 'heic' })
    assert.deepEqual(sniffFile(PDF, 'Matchblatt.pdf'), { mime: 'application/pdf', ext: 'pdf' })
    assert.deepEqual(sniffFile(Buffer.from('[2026-10-29] error\n'), 'logs.txt'), { mime: 'text/plain', ext: 'txt' })
    assert.deepEqual(sniffFile(Buffer.from('a;b\n1;2\n'), 'x.csv'), { mime: 'text/csv', ext: 'csv' })
    assert.deepEqual(sniffFile(Buffer.from('\ufeff  {"a":1}'), 'backup.json'), { mime: 'application/json', ext: 'json' })
    assert.deepEqual(sniffFile(Buffer.from('{"a":1}\n{"b":2}\n'), 'log.ndjson'), { mime: 'application/x-ndjson', ext: 'ndjson' })
    assert.deepEqual(sniffFile(Buffer.from('plain words'), 'notes'), { mime: 'text/plain', ext: 'txt' }, 'no extension: text')
  })

  it('goes by the bytes, not the name', () => {
    assert.deepEqual(sniffFile(PNG, 'screenshot.txt'), { mime: 'image/png', ext: 'png' }, 'a PNG named .txt is a PNG')
    assert.equal(sniffFile(Buffer.from('<html><script>x</script></html>'), 'shot.png'), null, 'text is no PNG')
    assert.equal(sniffFile(Buffer.from('<svg onload="x()"/>'), 'logo.svg'), null)
    assert.equal(sniffFile(Buffer.from('<html></html>'), 'page.html'), null)
    assert.equal(sniffFile(EXE, 'setup.exe'), null)
    assert.equal(sniffFile(EXE, 'setup.pdf'), null)
    assert.equal(sniffFile(Buffer.from('MZ but text'), 'x.bat'), null)
    assert.equal(sniffFile(Buffer.from('not json'), 'backup.json'), null)
    assert.equal(sniffFile(Buffer.from([0x61, 0x00, 0x62]), 'x.txt'), null, 'NUL: binary')
    assert.equal(sniffFile(Buffer.from([0x61, 0xc3, 0x28]), 'x.txt'), null, 'not UTF-8')
    assert.equal(sniffFile(Buffer.alloc(0), 'x.txt'), null)
  })

  it('names the attachment safely, with the extension of its type', () => {
    assert.equal(safeFilename('C:\\Users\\x\\Desktop\\shot.png', 'png'), 'shot.png')
    assert.equal(safeFilename('../../etc/passwd', 'txt'), 'passwd.txt')
    assert.equal(safeFilename('photo.jpg', 'png'), 'photo.jpg.png')
    assert.equal(safeFilename('evil\u202egnp.exe', 'png'), 'evilgnp.exe.png', 'no bidi override')
    assert.equal(safeFilename('a"b<c>|d?.txt\r\n', 'txt'), 'abcd.txt')
    assert.equal(safeFilename('.hidden', 'txt'), 'hidden.txt')
    assert.equal(safeFilename('', 'pdf'), 'attachment.pdf')
    const long = safeFilename(`${'x'.repeat(300)}.json`, 'json')
    assert.equal(long.length, 100)
    assert.ok(long.endsWith('.json'))
  })

  it('checkAttachments: refuses a file of another type, naming it (415)', () => {
    const ok = checkAttachments([{ filename: 'a.png', data: PNG }, { filename: 'b', data: Buffer.from('text') }])
    assert.deepEqual(ok.map((a) => [a.filename, a.mime]), [['a.png', 'image/png'], ['b.txt', 'text/plain']])
    assert.throws(() => checkAttachments([{ filename: 'a.png', data: PNG }, { filename: 'tool.exe', data: EXE }]),
      (e) => e.code === 'file_type' && e.status === 415 && e.extra.file === 'tool.exe')
  })
})

describe('contact: fields', () => {
  const base = Object.fromEntries(VALID)

  it('requires a type, a valid email and a message', () => {
    assert.throws(() => normalizeContact({ ...base, contactType: 'spam' }), (e) => e.code === 'invalid_type' && e.status === 400)
    assert.throws(() => normalizeContact({ ...base, comments: '  \n ' }), (e) => e.code === 'missing_comments')
    for (const email of ['', 'no-at', 'a@b', 'a b@c.ch', 'tester@example.ch\r\nBcc: x@example.org', 'a@b.ch, c@d.ch',
      'Name <a@b.ch>', 'a;b@c.ch', `${'a'.repeat(250)}@b.ch`]) {
      assert.throws(() => normalizeContact({ ...base, email }), (e) => e.code === 'invalid_email', JSON.stringify(email))
    }
  })

  it('maps the section ids, the older area names, and anything else to other', () => {
    for (const id of SECTION_IDS) assert.equal(areaOf(id), id)
    assert.equal(CONTACT_AREAS.at(-1), 'other')
    assert.equal(SECTION_IDS.length, 16)
    assert.equal(areaOf('mainPage'), 'home')
    assert.equal(areaOf('scoreboard'), 'scoring')
    assert.equal(areaOf('manualAdjustments'), 'corrections')
    assert.equal(areaOf('benchDashboard'), 'bench')
    for (const v of Object.values(LEGACY_AREAS)) assert.ok(SECTION_IDS.includes(v))
    assert.equal(areaOf('toString'), 'other', 'no prototype keys')
    assert.equal(areaOf('<script>'), 'other')
    assert.equal(areaOf(undefined), 'other')
  })

  it('the areas are the sections of the app\'s help, in its order, each with its name in the mail', async () => {
    // plain data, no imports but its video list: node reads it as the website's export does
    const help = await import('../../frontend/src/components/help/helpSections.js')
    assert.deepEqual([...SECTION_IDS], help.SECTION_IDS)
    for (const id of CONTACT_AREAS) assert.ok(SECTION_NAMES[id], id)
  })

  it('keeps context fields only when they fit; the page loses its query (?pin=)', () => {
    const v = normalizeContact(base)
    assert.equal(v.url, 'https://app.openvolley.app/referee')
    assert.equal(pageUrlOf('javascript:alert(1)'), '')
    assert.equal(pageUrlOf('capacitor://localhost/index.html?x=1'), 'capacitor://localhost/index.html')
    assert.equal(v.language, 'de-CH')
    assert.equal(v.source, 'app')
    assert.equal(v.supportType, 'bug')
    assert.equal(v.severity, '2')
    const odd = normalizeContact({ ...base, contactType: 'feedback', severity: '9', source: 'robot', language: 'de\r\nX', appVersion: '<b>', platform: 'a b' })
    assert.deepEqual([odd.supportType, odd.severity, odd.source, odd.language, odd.appVersion, odd.platform], ['', '', 'app', '', '', ''])
    assert.equal(normalizeContact({ ...base, source: 'website' }).source, 'website')
  })

  it('diagnostics: indented JSON, a non-JSON text cut short, too long refused', () => {
    const v = normalizeContact({ ...base, diagnostics: '{"appVersion":"3.0.6","consoleErrors":["a"]}' })
    assert.equal(v.diagnostics, '{\n  "appVersion": "3.0.6",\n  "consoleErrors": [\n    "a"\n  ]\n}')
    assert.match(normalizeContact({ ...base, diagnostics: 'not json' }).diagnostics, /^\(not JSON\) not json$/)
    assert.equal(normalizeContact({ ...base, diagnostics: '' }).diagnostics, null)
    assert.throws(() => normalizeContact({ ...base, diagnostics: JSON.stringify({ x: 'y'.repeat(40000) }) }), (e) => e.code === 'field_too_large')
  })

  it('the honeypot', () => {
    assert.equal(isHoneypotHit({ website: '' }), false)
    assert.equal(isHoneypotHit({}), false)
    assert.equal(isHoneypotHit({ website: 'http://spam.example' }), true)
  })

  it('subject: "[OpenVolley <type>] <area> – <first words>", one line', () => {
    const v = normalizeContact(base)
    assert.equal(supportSubject(v), '[OpenVolley Support] scoring – Undo does nothing after a time-out in set…')
    assert.equal(supportSubject(normalizeContact({ ...base, contactType: 'request', area: 'livescore', comments: 'Dark mode\r\nBcc: x@example.org' })),
      '[OpenVolley Request] livescore – Dark mode Bcc: x@example.org')
    assert.equal(firstWords('short'), 'short')
    assert.equal(firstWords('x'.repeat(80)), `${'x'.repeat(60)}…`)
  })
})

describe('contact: the mail', () => {
  it('one mail to the support mailbox: Reply-To the user, From MAIL_FROM, the attachments, the fields and diagnostics', async () => {
    const { mailer, sent } = streamMailer()
    const { body, contentType } = await formBody([
      ...VALID,
      ['diagnostics', JSON.stringify({ appVersion: '3.0.6', online: true, gameNumber: 4711, consoleErrors: ['[Sync] failed'] })],
      ['website', ''],
      ['files', PNG, 'shot.png', 'image/png'],
      ['files', PDF, 'Matchblatt.pdf', 'application/pdf'],
      ['files', BACKUP, 'backup.json', 'application/octet-stream']
    ])
    const r = await handleContact({ body, contentType, mailer, logger: silent, now: () => new Date('2026-10-29T10:00:05.000Z') })
    assert.deepEqual(r, { status: 200, body: { success: true } })
    assert.equal(sent.length, 1, 'exactly one mail (no acknowledgement to the user)')
    const { mail, raw, envelope } = sent[0]
    assert.deepEqual(envelope, { from: 'noreply@example.test', to: ['support@example.test'] }, 'only the support mailbox receives it')
    assert.equal(mail.disableFileAccess, true)
    assert.equal(mail.disableUrlAccess, true)

    const headers = headersOf(raw)
    assert.match(headers, /^From: OpenVolley <noreply@example\.test>$/m)
    assert.match(headers, /^To: support@example\.test$/m)
    assert.match(headers, /^Reply-To: tester@example\.ch$/m)
    assert.match(headers, /^Subject: /m)
    assert.doesNotMatch(headers, /^(Auto-Submitted|Precedence|X-Auto-Response-Suppress|Bcc|Cc):/im, 'FreeScout would read it as an auto-responder')
    assert.equal(mail.subject, '[OpenVolley Support] scoring – Undo does nothing after a time-out in set…')

    // attachments: checked types, the bytes as sent
    assert.deepEqual(mail.attachments.map((a) => [a.filename, a.contentType]),
      [['shot.png', 'image/png'], ['Matchblatt.pdf', 'application/pdf'], ['backup.json', 'application/json']])
    assert.ok(mail.attachments[0].content.equals(PNG))
    assert.ok(mail.attachments[2].content.equals(BACKUP))
    assert.match(raw, /Content-Type: image\/png; name=shot\.png/)
    assert.match(raw, /Content-Disposition: attachment; filename=Matchblatt\.pdf/)
    assert.ok(raw.includes(PNG.toString('base64')), 'the PNG travels base64-encoded')

    // body
    const text = mail.text
    assert.match(text, /^Support from the OpenVolley app$/m)
    assert.match(text, /^Support type: +Bug report$/m)
    assert.match(text, /^Severity: +2 - Very limited functionality$/m)
    assert.match(text, /^Area: +Scoring \(scoring\)$/m)
    assert.match(text, /^Email: +tester@example\.ch$/m)
    assert.match(text, /^Language: +de-CH$/m)
    assert.match(text, /^App version: +3\.0\.6$/m)
    assert.match(text, /^Platform: +android$/m)
    assert.match(text, /^Page: +https:\/\/app\.openvolley\.app\/referee$/m)
    assert.doesNotMatch(text, /pin=/)
    assert.match(text, /^Received at: +2026-10-29T10:00:05\.000Z$/m)
    assert.match(text, /^Attachments: +shot\.png \(.+\), Matchblatt\.pdf \(.+\), backup\.json \(.+\)$/m)
    assert.match(text, /Message:\nUndo does nothing after a time-out in set 2\.\nSteps: start rally/)
    assert.match(text, /Diagnostics \(sent with the user's consent\):\n\{\n {2}"appVersion": "3\.0\.6",[\s\S]*"gameNumber": 4711/)
  })

  it('a website submission without files or diagnostics', async () => {
    const { mailer, sent } = streamMailer()
    const { body, contentType } = await formBody([['contactType', 'feedback'], ['area', 'install-updates'], ['email', 'fan@example.org'],
      ['comments', 'Nice app'], ['source', 'website'], ['language', 'fr']])
    const r = await handleContact({ body, contentType, mailer, logger: silent })
    assert.equal(r.status, 200)
    const { mail } = sent[0]
    assert.equal(mail.subject, '[OpenVolley Feedback] install-updates – Nice app')
    assert.match(mail.text, /^Feedback from the OpenVolley website$/m)
    assert.match(mail.text, /^Attachments: +none$/m)
    assert.doesNotMatch(mail.text, /Diagnostics|Support type|Severity/)
    assert.deepEqual(mail.attachments, [])
  })

  it('the honeypot: 200 and nothing sent', async () => {
    const { mailer, sent } = streamMailer()
    const { body, contentType } = await formBody([...VALID, ['website', 'https://spam.example']])
    const r = await handleContact({ body, contentType, mailer, logger: silent })
    assert.deepEqual(r, { status: 200, body: { success: true } })
    assert.equal(sent.length, 0)
  })

  it('refusals send nothing: bad email, bad file, too many files', async () => {
    const { mailer, sent } = streamMailer()
    const cases = [
      [[...VALID.filter(([k]) => k !== 'email'), ['email', 'x@y.ch\r\nBcc: z@example.org']], 400, 'invalid_email'],
      [[...VALID, ['files', EXE, 'tool.exe']], 415, 'file_type'],
      [[...VALID, ...Array.from({ length: 6 }, (_, i) => ['files', PNG, `${i}.png`])], 400, 'too_many_files']
    ]
    for (const [entries, status, code] of cases) {
      const { body, contentType } = await formBody(entries)
      const r = await handleContact({ body, contentType, mailer, logger: silent })
      assert.equal(r.status, status, code)
      assert.equal(r.body.success, false)
      assert.equal(r.body.code, code)
    }
    assert.equal(sent.length, 0)
  })

  it('no mail configured: 503 unavailable; SMTP failure: 502; hourly budget: 503 busy', async () => {
    const { body, contentType } = await formBody(VALID)
    const off = await handleContact({ body, contentType, mailer: disabledContactMailer('SMTP_HOST not set'), logger: silent })
    assert.deepEqual([off.status, off.body.code], [503, 'unavailable'])

    const lines = []
    const failing = createContactMailer({
      transport: { async sendMail() { throw Object.assign(new Error('550 5.1.1 <support@example.test>: rejected'), { responseCode: 550 }) } },
      from: 'OpenVolley <noreply@example.test>',
      to: 'support@example.test'
    })
    const r = await handleContact({ body, contentType, mailer: failing, logger: { ...silent, error: (...a) => lines.push(a.join(' ')) } })
    assert.deepEqual([r.status, r.body.code], [502, 'send_failed'])
    assert.doesNotMatch(lines.join('\n'), /tester@example\.ch|support@example\.test/, 'addresses masked in the log')

    let t = 0
    const { mailer, sent } = streamMailer({ maxPerHour: 2, now: () => t })
    for (let i = 0; i < 2; i++) assert.equal((await handleContact({ body, contentType, mailer, logger: silent })).status, 200)
    const busy = await handleContact({ body, contentType, mailer, logger: silent })
    assert.deepEqual([busy.status, busy.body.code], [503, 'busy'])
    t += 60 * 60 * 1000
    assert.equal((await handleContact({ body, contentType, mailer, logger: silent })).status, 200, 'a new hour')
    assert.equal(sent.length, 3)
  })

  it('from and to come from the mailer, never from the request', async () => {
    const { mailer, sent } = streamMailer()
    const mail = buildSupportMail(normalizeContact(Object.fromEntries(VALID)), [])
    await mailer.send({ ...mail, to: 'victim@example.org', from: 'x@example.org', bcc: undefined })
    assert.deepEqual(sent[0].envelope.to, ['support@example.test'])
    assert.equal(sent[0].envelope.from, 'noreply@example.test')
  })

  it('logs no full address', async () => {
    const { mailer } = streamMailer()
    const lines = []
    const { body, contentType } = await formBody(VALID)
    await handleContact({ body, contentType, mailer, logger: { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) } })
    assert.match(lines.join('\n'), /support\/scoring from te\*\*\*@example\.ch \(app, 0 attachment\(s\)\) mailed/)
    assert.doesNotMatch(lines.join('\n'), /tester@/)
  })
})

describe('contact: settings', () => {
  // Made per run: a fixed string would look like a committed credential
  const smtp = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'noreply@example.test', SMTP_PASS: `sink-${randomBytes(12).toString('hex')}`, SMTP_PORT: '465' }

  it('off without the SMTP account, with the reason', () => {
    assert.equal(contactMailerFromEnv({}).reason, 'SMTP_HOST not set')
    assert.equal(contactMailerFromEnv({ SMTP_HOST: 'h' }).reason, 'SMTP_PASS not set')
    assert.equal(contactMailerFromEnv({ ...smtp, SMTP_USER: '' }).reason, 'SMTP_USER not set')
    assert.equal(contactMailerFromEnv({ ...smtp, SMTP_PORT: '99999' }).reason, 'SMTP_PORT is not a port number')
    assert.equal(contactMailerFromEnv({ ...smtp, CONTACT_EMAIL: 'a@b.ch, c@d.ch' }).reason, 'CONTACT_EMAIL is not one address')
    assert.equal(contactMailerFromEnv({ ...smtp, SMTP_USER: 'noreply' }).reason, 'MAIL_FROM not set (and SMTP_USER is not an address)')
  })

  it('on with it: From MAIL_FROM (default OpenVolley <SMTP_USER>), To CONTACT_EMAIL (default support@openvolley.app); needs no SMTP_LEGACY_ROUTES', () => {
    const a = contactMailerFromEnv(smtp)
    assert.equal(a.enabled, true)
    assert.equal(a.from, 'OpenVolley <noreply@example.test>')
    assert.equal(a.to, 'support@openvolley.app')
    a.close()
    const b = contactMailerFromEnv({ ...smtp, MAIL_FROM: 'OpenVolley <noreply@openvolley.example>', CONTACT_EMAIL: 'help@example.test' })
    assert.deepEqual([b.from, b.to], ['OpenVolley <noreply@openvolley.example>', 'help@example.test'])
    b.close()
  })
})
