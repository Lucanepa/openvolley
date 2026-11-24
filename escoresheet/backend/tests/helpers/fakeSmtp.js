/**
 * A local SMTP sink for the mail tests (smtp-server, a devDependency). It
 * speaks TLS with a throwaway self-signed certificate for "localhost", made
 * with openssl per run, so the mailer under test keeps certificate checks on:
 * the tests trust that certificate through `ca` (in process) or
 * NODE_EXTRA_CA_CERTS=certPath (a spawned server.js). Nothing leaves the
 * machine: it listens on 127.0.0.1 and only stores what it receives.
 *
 *   const smtp = await startFakeSmtp({ implicitTls: true })   // like port 465
 *   const smtp = await startFakeSmtp({ implicitTls: false })  // STARTTLS, like 587
 *   smtp.mails       -> [{ from, to, subject, text, html, raw }]
 *   await smtp.waitForMail((m) => m.to.includes('a@b.ch'))
 *   linkToken(mail)  -> { page, token, lang } of the action link
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SMTPServer } from 'smtp-server'

export const SMTP_USER = 'noreply@example.test'
// Made per run: a fixed string would look like a committed credential.
export const SMTP_PASS = `sink-${randomBytes(12).toString('hex')}`

/** A self-signed certificate for localhost / 127.0.0.1 in a temp dir. */
export function makeTestCert() {
  const dir = mkdtempSync(join(tmpdir(), 'ov-smtp-cert-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'ignore' })
  return {
    dir,
    keyPath,
    certPath,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    remove() { rmSync(dir, { recursive: true, force: true }) }
  }
}

function decodeQuotedPrintable(s) {
  const bytes = []
  const src = s.replace(/=\r?\n/g, '')
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(...Buffer.from(src[i], 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

function decodeBody(body, encoding) {
  const enc = String(encoding || '').toLowerCase()
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

/** RFC 2047 encoded words (=?UTF-8?Q?...?= / ?B?). */
function decodeWords(v) {
  return String(v || '').replace(/=\?([^?]+)\?([QB])\?([^?]*)\?=\s*/gi, (_, _cs, kind, text) =>
    kind.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : decodeQuotedPrintable(text.replace(/_/g, ' ')))
}

function splitHead(part) {
  const idx = part.search(/\r?\n\r?\n/)
  const head = idx < 0 ? part : part.slice(0, idx)
  const body = idx < 0 ? '' : part.slice(idx).replace(/^\r?\n\r?\n/, '')
  const headers = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line)
    if (m) headers[m[1].toLowerCase()] = m[2]
  }
  return { headers, body }
}

/** Minimal MIME reader: subject, from, to, and the decoded text/plain and text/html parts. */
export function parseMail(raw) {
  const { headers, body } = splitHead(raw)
  const out = { raw, headers, subject: decodeWords(headers.subject), from: headers.from || '', to: headers.to || '', text: '', html: '' }
  const walk = (hdrs, content) => {
    const type = hdrs['content-type'] || 'text/plain'
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1]
    if (/^multipart\//i.test(type) && boundary) {
      for (const part of content.split('--' + boundary).slice(1)) {
        if (part.startsWith('--')) break
        const p = splitHead(part.replace(/^\r?\n/, ''))
        walk(p.headers, p.body)
      }
      return
    }
    const decoded = decodeBody(content, hdrs['content-transfer-encoding'])
    if (/^text\/html/i.test(type)) out.html += decoded
    else if (/^text\/plain/i.test(type)) out.text += decoded
  }
  walk(headers, body)
  return out
}

/** The action link of a mail: { url, page, token, lang } or null. */
export function linkToken(mail) {
  const m = /(https?:\/\/[^\s"<]+)\/#(reset|confirm)\?token=([A-Za-z0-9_-]{43})(?:&lang=([a-z]{2}))?/.exec(mail?.text || '')
  return m ? { url: m[0], page: m[2], token: m[3], lang: m[4] || null } : null
}

/**
 * @param {object} [o]
 * @param {boolean} [o.implicitTls=true]  TLS from the first byte (465) or STARTTLS (587)
 * @param {object} [o.cert]               a makeTestCert() result (made when absent)
 * @param {string} [o.user], [o.pass]     the only credentials accepted
 * @param {(address: string) => boolean} [o.rejectRcpt]  answer RCPT TO for these
 *        with "550 5.1.1 <address>: Recipient address rejected" (quotes the
 *        address, like real servers do)
 */
export async function startFakeSmtp({ implicitTls = true, cert = null, user = SMTP_USER, pass = SMTP_PASS, rejectRcpt = null } = {}) {
  const ownCert = !cert
  const c = cert || makeTestCert()
  const mails = []
  const waiters = new Set()
  const auths = []
  const server = new SMTPServer({
    secure: implicitTls,
    key: c.key,
    cert: c.cert,
    authMethods: ['PLAIN', 'LOGIN'],
    allowInsecureAuth: false, // AUTH only after TLS: proves STARTTLS really happened
    disabledCommands: implicitTls ? ['STARTTLS'] : [],
    logger: false,
    size: 1024 * 1024,
    onAuth(auth, session, cb) {
      auths.push({ username: auth.username, secure: !!session.secure })
      if (auth.username === user && auth.password === pass) return cb(null, { user: auth.username })
      return cb(new Error('Invalid username or password'))
    },
    onRcptTo(address, session, cb) {
      if (rejectRcpt?.(address.address)) {
        return cb(Object.assign(new Error(`5.1.1 <${address.address}>: Recipient address rejected: User unknown`), { responseCode: 550 }))
      }
      cb()
    },
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', (d) => chunks.push(d))
      stream.on('end', () => {
        const mail = {
          ...parseMail(Buffer.concat(chunks).toString('utf8')),
          envelope: { from: session.envelope.mailFrom?.address, to: session.envelope.rcptTo.map((r) => r.address) },
          secure: !!session.secure
        }
        mails.push(mail)
        for (const w of [...waiters]) w()
        cb()
      })
    }
  })
  server.on('error', () => {}) // a client that hangs up mid-session must not crash the test process
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()))
  })
  const port = server.server.address().port
  return {
    port,
    host: 'localhost',
    mails,
    auths,
    cert: c,
    ca: c.cert,
    certPath: c.certPath,
    /** The mailer env of server.js for this sink (STARTTLS when not implicit). */
    env(extra = {}) {
      return {
        SMTP_HOST: 'localhost',
        SMTP_PORT: String(port),
        SMTP_USER: user,
        SMTP_PASS: pass,
        MAIL_FROM: `OpenVolley Test <${user}>`,
        MANAGER_URL: 'https://manager.example.test',
        NODE_EXTRA_CA_CERTS: c.certPath,
        ...extra
      }
    },
    clear() { mails.length = 0 },
    waitForMail(pred = () => true, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const m = mails.find(pred)
          if (m) {
            clearTimeout(timer)
            waiters.delete(check)
            resolve(m)
            return true
          }
          return false
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`no matching mail within ${timeoutMs} ms; got ${JSON.stringify(mails.map((m) => [m.to, m.subject]))}`))
        }, timeoutMs)
        if (!check()) waiters.add(check)
      })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      if (ownCert) c.remove()
    }
  }
}
