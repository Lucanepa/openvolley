import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CONTACT_AREAS, SUPPORT_SECTIONS, LEGACY_AREAS, MAX_FILES, MAX_FILES_BYTES, buildContactForm, checkFiles,
  collectDiagnostics, contactAreaOf, contactMailto, isAllowedFile, isContactEmail, pageUrl
} from '../supportContact'
import { setActiveMatch } from '../activity/activeMatch'
import { helpContent } from '../../components/help/helpContent'

const file = (name, size = 10, type = '') => new File([new Uint8Array(size)], name, { type })
const win = (href = 'https://app.openvolley.app/referee?pin=123456#set2') => {
  const u = new URL(href)
  return { location: { protocol: u.protocol, host: u.host, pathname: u.pathname, href }, innerWidth: 1280, innerHeight: 800, navigator: { userAgent: 'test' } }
}

describe('support form: areas', () => {
  it('are the 16 help sections and "other"', () => {
    expect(SUPPORT_SECTIONS).toEqual(['home', 'setup', 'coin-toss', 'scoring', 'subs-timeouts', 'sanctions', 'set-end', 'match-end',
      'corrections', 'connections', 'referee', 'bench', 'livescore', 'handover', 'sync-offline', 'install-updates'])
    expect(CONTACT_AREAS).toEqual([...SUPPORT_SECTIONS, 'other'])
  })

  it('maps the older area names and every page of the contextual help onto a section', () => {
    for (const id of CONTACT_AREAS) expect(contactAreaOf(id)).toBe(id)
    expect(contactAreaOf('mainPage')).toBe('home')
    expect(contactAreaOf('options')).toBe('home')
    expect(contactAreaOf('scoreboard')).toBe('scoring')
    expect(contactAreaOf('uploadRoster')).toBe('setup')
    expect(contactAreaOf('approval')).toBe('match-end')
    for (const page of Object.keys(helpContent)) expect(SUPPORT_SECTIONS).toContain(contactAreaOf(page))
    for (const v of Object.values(LEGACY_AREAS)) expect(SUPPORT_SECTIONS).toContain(v)
    expect(contactAreaOf('toString')).toBe('')
    expect(contactAreaOf('nope')).toBe('')
    expect(contactAreaOf(undefined)).toBe('')
  })
})

describe('support form: attachments', () => {
  it('takes images, PDF, text and JSON, up to 5 files and 10 MB together', () => {
    expect(checkFiles([file('a.png'), file('b.JPG'), file('c.pdf'), file('d.json'), file('logs.txt')])).toBeNull()
    expect(checkFiles([file('IMG_1.heic'), file('x.log'), file('y.csv'), file('z.ndjson')])).toBeNull()
    expect(isAllowedFile(file('screenshot', 10, 'image/png'))).toBe(true)
    expect(checkFiles([file('a.png'), file('setup.exe')])).toEqual({ code: 'file_type', name: 'setup.exe' })
    expect(checkFiles([file('page.html')])).toEqual({ code: 'file_type', name: 'page.html' })
    expect(checkFiles([file('logo.svg')])).toEqual({ code: 'file_type', name: 'logo.svg' })
    expect(checkFiles(Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`${i}.png`)))).toEqual({ code: 'too_many_files' })
    expect(checkFiles([file('a.pdf', MAX_FILES_BYTES / 2), file('b.pdf', MAX_FILES_BYTES / 2 + 1)])).toEqual({ code: 'files_too_large' })
    expect(checkFiles([file('a.pdf', MAX_FILES_BYTES)])).toBeNull()
    expect(checkFiles([])).toBeNull()
  })

  it('checks the address like the backend', () => {
    expect(isContactEmail('tester@example.ch')).toBe(true)
    expect(isContactEmail(' tester@example.ch ')).toBe(true)
    for (const bad of ['', 'x', 'a@b', 'a b@c.ch', 'a@b.ch, c@d.ch', 'Name <a@b.ch>']) expect(isContactEmail(bad)).toBe(false)
  })
})

describe('support form: diagnostics', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => setActiveMatch(null))

  it('app version, platform, display mode, screen, online, the open match; the last 20 errors, redacted', () => {
    localStorage.setItem('displayMode', 'tablet')
    setActiveMatch({ id: 7, gameNumber: 4711 })
    const logs = [
      { level: 'log', timestamp: 't0', message: 'not an error' },
      ...Array.from({ length: 25 }, (_, i) => ({ level: 'error', timestamp: `t${i + 1}`, message: `[Sync] failed ${i + 1}` })),
      { level: 'error', timestamp: 't26', message: 'GET https://backend.openvolley.app/api/match/1?pin=987654&x=1 failed, PIN 123456' }
    ]
    const d = collectDiagnostics({ win: win(), logs })
    expect(d).toMatchObject({ appVersion: '0.0.0-test', platform: 'web', displayMode: 'tablet', screen: '1280x800', online: true, gameNumber: 4711 })
    expect(d.consoleErrors).toHaveLength(20)
    expect(d.consoleErrors[0]).toBe('t7 [Sync] failed 7')
    const last = d.consoleErrors.at(-1)
    expect(last).toContain('https://backend.openvolley.app/api/match/1 failed')
    expect(last).not.toMatch(/987654|123456|pin=/)
  })

  it('the caller\'s game number wins; no errors kept: no consoleErrors key', () => {
    setActiveMatch({ id: 7, gameNumber: 4711 })
    const d = collectDiagnostics({ win: win(), logs: [], gameNumber: 12 })
    expect(d.gameNumber).toBe(12)
    expect(d.displayMode).toBe('auto')
    expect('consoleErrors' in d).toBe(false)
    setActiveMatch(null)
    expect(collectDiagnostics({ win: win(), logs: [] }).gameNumber).toBeNull()
  })
})

describe('support form: the request', () => {
  it('the multipart fields of POST /api/contact, files under "files", the page without its query', () => {
    const files = [file('shot.png', 20, 'image/png'), file('backup.json', 30, 'application/json')]
    const fd = buildContactForm({
      contactType: 'support', area: 'scoring', supportType: 'bug', severity: 2, email: ' tester@example.ch ',
      comments: 'Undo does nothing', files, diagnostics: { online: false }, language: 'de-CH', win: win(), now: new Date('2026-10-29T10:00:00Z')
    })
    const get = (k) => fd.get(k)
    expect([get('contactType'), get('area'), get('supportType'), get('severity'), get('email'), get('comments')])
      .toEqual(['support', 'scoring', 'bug', '2', 'tester@example.ch', 'Undo does nothing'])
    expect([get('source'), get('language'), get('appVersion'), get('platform')]).toEqual(['app', 'de-CH', '0.0.0-test', 'web'])
    expect(get('url')).toBe('https://app.openvolley.app/referee')
    expect(get('timestamp')).toBe('2026-10-29T10:00:00.000Z')
    expect(JSON.parse(get('diagnostics'))).toEqual({ online: false })
    expect(fd.getAll('files').map((f) => f.name)).toEqual(['shot.png', 'backup.json'])
    expect(fd.has('website')).toBe(false)

    const plain = buildContactForm({ contactType: 'feedback', area: 'other', email: 'a@b.ch', comments: 'x', win: win() })
    expect(plain.has('diagnostics')).toBe(false)
    expect(plain.getAll('files')).toEqual([])
    expect(plain.get('severity')).toBe('')
  })

  it('pageUrl drops query and fragment', () => {
    expect(pageUrl(win('capacitor://localhost/index.html?pin=1#x'))).toBe('capacitor://localhost/index.html')
  })

  it('the mailto fallback: to the support mailbox, the fields and the files to attach', () => {
    const href = contactMailto({
      contactType: 'support', area: 'connections', email: 'tester@example.ch', comments: 'Tablet does not connect',
      files: [file('shot.png')], diagnostics: { online: false }, win: win()
    }, { type: 'Support', area: 'Connecting tablets', supportType: 'Help / question' })
    expect(href.startsWith('mailto:support@openvolley.app?subject=')).toBe(true)
    const url = new URL(href)
    expect(url.searchParams.get('subject')).toBe('[OpenVolley Support] connections - Help / question')
    const body = url.searchParams.get('body')
    expect(body).toContain('Area: Connecting tablets (connections)')
    expect(body).toContain('From: tester@example.ch')
    expect(body).toContain('Page: https://app.openvolley.app/referee')
    expect(body).not.toContain('pin=')
    expect(body).toContain('Tablet does not connect')
    expect(body).toContain('Diagnostics: {"online":false}')
    expect(body).toContain('1 file(s) to attach: shot.png')
  })
})
