// The support diagnostics report builder (pure): sections, the merged
// timeline (order, collapsed runs, gaps, markers, the line cap), the 2 MB cap
// and the redaction over the whole text.
import { describe, it, expect } from 'vitest'
import {
  buildDiagnosticsReport, buildTimeline, redactReport, diagnosticsFileName, mergeAppLog, matchSection, makeClock,
  isTokenShaped, interactionItem, REPORT_MAX_BYTES, TIMELINE_MAX_LINES, APP_LOG_MAX
} from '../diagnosticsReport'

// Fake secrets made at run time (no credential-shaped literal in the source:
// the repo's gitleaks hook would stop it, rightly)
const fakeToken = (length, seed = 7) => {
  const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let x = seed
  let out = ''
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    out += abc[x % abc.length]
  }
  return out
}

const TZ = 'Europe/Zurich'
const T = Date.parse('2026-10-29T21:01:03.120Z') // 22:01:03.120 in Zürich
const S = 1000
const clock = makeClock(TZ)

let n = 0
const ui = (ts, type, target = {}, payload = {}, component = 'global') => ({ id: `${ts}_${n++}`, ts, category: 'ui', type, component, action: type, payload, target, sessionId: 's1' })
const tapAt = (ts, text, component = 'Scoreboard') => ui(ts, 'click', { tagName: 'button', textContent: text }, { button: 0 }, component)
const act = (ts, kind, data = {}, extra = {}) => ({ lid: n++, ts: new Date(ts).toISOString(), kind, level: 'info', matchId: 1, data, ...extra })
const tl = (input) => buildTimeline({ now: T + 60 * S, timeZone: TZ, ...input }).lines

describe('diagnostics report: file name and clock', () => {
  it('openvolley-diagnostics-<YYYYMMDD-HHMM>[-g<game>].txt in local time', () => {
    expect(diagnosticsFileName(T, 406970, { timeZone: TZ })).toBe('openvolley-diagnostics-20261029-2201-g406970.txt')
    expect(diagnosticsFileName(T, null, { timeZone: TZ })).toBe('openvolley-diagnostics-20261029-2201.txt')
    expect(diagnosticsFileName(T, '../12 3', { timeZone: TZ })).toBe('openvolley-diagnostics-20261029-2201-g123.txt')
    expect(clock.time(T)).toBe('22:01:03.120')
    expect(clock.offset(T)).toBe('+01:00')
    expect(makeClock(TZ).offset(Date.parse('2026-07-01T12:00:00Z'))).toBe('+02:00')
  })
})

describe('diagnostics report: the timeline', () => {
  it('one chronological list of both logs; at the same millisecond the tap comes before what it did', () => {
    const lines = tl({
      interaction: [tapAt(T, 'Point A'), tapAt(T + 5 * S, 'Time-out B')],
      activity: [act(T + 180, 'event.add', { type: 'point', team: 'away', scoreA: 3, scoreB: 2, set: 1, seq: 41 }), act(T, 'sync.state', { from: 'synced', to: 'error' }), act(T + 5 * S + 200, 'event.add', { type: 'timeout', team: 'home', set: 1 })]
    })
    expect(lines).toEqual([
      '———— 2026-10-29 ————',
      '22:01:03.120  tap     "Point A"                     Scoreboard',
      '22:01:03.120  sync    status synced → error',
      '22:01:03.300  score   Point away → 3:2 (set 1)  seq 41',
      '22:01:08.120  tap     "Time-out B"                  Scoreboard',
      '22:01:08.320  score   Time-out home (set 1)'
    ])
  })

  it('team letters for the report\'s match (coin toss): "Point A (away)"', () => {
    const lines = tl({
      activity: [act(T, 'event.add', { type: 'point', team: 'away', scoreA: 3, scoreB: 2, set: 1 })],
      matches: new Map([[1, { id: 1, coinTossTeamA: 'away' }]])
    })
    expect(lines.at(-1)).toBe('22:01:03.120  score   Point A (away) → 3:2 (set 1)')
  })

  it('a run of pointer moves or scrolls is one line ("pointer moved ×37 over 4 s"); the activity lines in between do not end it', () => {
    const moves = Array.from({ length: 37 }, (_, i) => ui(T + i * 111, 'touchmove', { tagName: 'div' }))
    const lines = tl({
      interaction: [...moves, ...Array.from({ length: 5 }, (_, i) => ui(T + 10 * S + i * 500, 'scroll')), tapAt(T + 20 * S, 'Next')],
      activity: [act(T + 2 * S, 'sync.summary', { sent: 3, failed: 0, pending: 0 })]
    })
    expect(lines.slice(1)).toEqual([
      '22:01:03.120  move    pointer moved ×37 over 4 s',
      '22:01:05.120  sync    last minutes: sent 3, failed 0, pending 0',
      '22:01:13.120  scroll  scrolled ×5 over 2 s',
      '22:01:23.120  tap     "Next"                        Scoreboard'
    ])
  })

  it('the presses of a tap are part of it; presses without a tap are "touched"; focus, blur and key up are left out', () => {
    const t = { tagName: 'button', textContent: 'OK' }
    const lines = tl({
      interaction: [
        ui(T, 'touchstart', t), ui(T + 50, 'focus', t), ui(T + 80, 'touchend', t), ui(T + 81, 'mousedown', t), ui(T + 82, 'mouseup', t), ui(T + 90, 'click', t),
        ui(T + 10 * S, 'touchstart', { tagName: 'div' }), ui(T + 10 * S + 90, 'touchend', { tagName: 'div' }), ui(T + 11 * S, 'blur', t), ui(T + 11 * S, 'keyup', t)
      ]
    })
    expect(lines.slice(1)).toEqual([
      '22:01:03.210  tap     "OK"',
      '22:01:13.120  touch   touched (no tap) ×2'
    ])
  })

  it('typing is one line per field, with how many keys and characters, never the text', () => {
    const name = { tagName: 'input', type: 'text', ariaLabel: 'Home team' }
    const notes = { tagName: 'textarea', name: 'remarks' }
    const typed = (target, text, t0) => [...text].flatMap((ch, i) => [
      ui(t0 + i * 200, 'keydown', target, { key: ch }),
      ui(t0 + i * 200 + 10, 'input', target, { value: text.slice(0, i + 1), valueLength: i + 1 })
    ])
    const lines = tl({
      interaction: [
        ...typed(name, 'VBC Wiedikon', T), ui(T + 3 * S, 'keydown', name, { key: 'Backspace' }), ui(T + 3 * S + 5, 'input', name, { value: 'VBC Wiediko', valueLength: 11 }),
        ui(T + 4 * S, 'keydown', name, { key: 'Tab' }),
        ...typed(notes, 'Ball 7', T + 5 * S),
        ui(T + 9 * S, 'keydown', { tagName: 'body' }, { key: 'h' }),
        ui(T + 9 * S + 1, 'keydown', { tagName: 'body' }, { key: 'z', ctrlKey: true })
      ]
    })
    expect(lines.slice(1)).toEqual([
      '22:01:03.120  type    typed 13 keys into "Home team" (now 11 characters; the text is not included)',
      '22:01:07.120  key     Tab',
      '22:01:08.120  type    typed 6 keys into textarea[name=remarks] (now 6 characters; the text is not included)',
      '22:01:12.120  key     "h"',
      '22:01:12.121  key     Ctrl+z'
    ])
    expect(lines.join('\n')).not.toMatch(/Wiedikon|Ball 7/)
  })

  it('a password or PIN field: only that it was typed into', () => {
    const lines = tl({
      interaction: [
        ui(T, 'keydown', { tagName: 'input', secret: true }),
        ui(T + 10, 'input', { tagName: 'input', secret: true }),
        ui(T + 20 * S, 'keydown', { tagName: 'input', type: 'password', ariaLabel: 'Approval PIN' }, { key: '[REDACTED]' }),
        ui(T + 20 * S + 5, 'input', { tagName: 'input', type: 'password', ariaLabel: 'Approval PIN' }, { value: '[REDACTED]', valueLength: null })
      ]
    })
    expect(lines.slice(1)).toEqual([
      '22:01:03.120  type    typed into a password or PIN field: not recorded',
      '22:01:23.120  type    typed into "Approval PIN" (a password or PIN field): not recorded'
    ])
  })

  it('changes: a checkbox, a choice, a picked file; a text field\'s change is typing', () => {
    const lines = tl({
      interaction: [
        ui(T, 'change', { tagName: 'input', type: 'checkbox', ariaLabel: 'Include diagnostics' }, { checked: false }),
        ui(T + S, 'change', { tagName: 'select', ariaLabel: 'Area' }, { value: 'scoring' }),
        ui(T + 2 * S, 'change', { tagName: 'input', type: 'email', ariaLabel: 'Your email' }, { value: 'a@b.ch' }),
        ui(T + 3 * S, 'change', { tagName: 'input', type: 'file', name: 'roster' }, {})
      ]
    })
    expect(lines.slice(1)).toEqual([
      '22:01:03.120  change  [ ] "Include diagnostics"',
      '22:01:04.120  change  "Area" → "scoring"',
      '22:01:05.120  type    typed into "Your email" (now 6 characters; the text is not included)',
      '22:01:06.120  change  picked a file in input[type=file][name=roster]'
    ])
  })

  it('marks app start, update, quit, page loads, the background, offline; a gap over 5 minutes; the quiet end', () => {
    const lines = buildTimeline({
      now: T + 40 * 60 * S,
      timeZone: TZ,
      interaction: [
        { id: 'a', ts: T, category: 'system', type: 'init', component: 'ComprehensiveLogger', action: 'initialized', payload: {} },
        { id: 'b', ts: T + 60 * S, category: 'system', type: 'visibility', component: 'App', action: 'hidden', payload: {} },
        { id: 'c', ts: T + 13 * 60 * S, category: 'system', type: 'visibility', component: 'App', action: 'visible', payload: {} },
        { id: 'd', ts: T + 13 * 60 * S + 1, category: 'system', type: 'network', component: 'App', action: 'offline', payload: {} },
        tapAt(T + 14 * 60 * S, 'Point A'),
        tapAt(T + 18 * 60 * S, 'Point B')
      ],
      activity: [
        act(T + 5, 'app.start', { version: '3.0.7', platform: 'android' }),
        act(T + 6, 'app.update', { version: '3.0.7', previous: '3.0.6' }),
        act(T + 20 * 60 * S, 'app.quit')
      ]
    }).lines
    expect(lines.slice(1)).toEqual([
      '22:01:03.120  ════ PAGE LOADED (a new page load: start or reload) ════',
      '22:01:03.125  ════ APP START 3.0.7 (android) ════',
      '22:01:03.126  ════ APP UPDATED 3.0.6 → 3.0.7 ════',
      '22:02:03.120  ════ APP IN THE BACKGROUND (screen off, other app or tab) ════',
      '              ···· 12 min with nothing recorded ····',
      '22:14:03.120  ════ APP IN THE FOREGROUND AGAIN ════',
      '22:14:03.121  net     the device went offline',
      '22:15:03.120  tap     "Point A"                     Scoreboard',
      '22:19:03.120  tap     "Point B"                     Scoreboard',
      '22:21:03.120  ════ APP QUIT (page closed or app ended) ════',
      '              ···· 20 min with nothing recorded, up to this report ····'
    ])
  })

  it('a long scroll run is no gap, a new day gets its date', () => {
    const scroll = Array.from({ length: 20 }, (_, i) => ui(T + i * 60 * S, 'scroll'))
    const lines = tl({ interaction: [...scroll, tapAt(T + 20 * 60 * S, 'x')] })
    expect(lines.some(l => l.includes('nothing recorded'))).toBe(false)
    const night = buildTimeline({ now: T + 3 * 3600 * S, timeZone: TZ, interaction: [tapAt(T, 'a'), tapAt(T + 2 * 3600 * S, 'b')] }).lines
    expect(night).toContain('———— 2026-10-30 ————')
  })

  it('keeps the newest TIMELINE_MAX_LINES lines and counts the rest', () => {
    const taps = Array.from({ length: TIMELINE_MAX_LINES + 120 }, (_, i) => tapAt(T + i * 1000, `t${i}`))
    const r = buildTimeline({ now: T, timeZone: TZ, interaction: taps })
    expect(r.lines).toHaveLength(TIMELINE_MAX_LINES)
    expect(r.cut).toBe(121) // + the date line
    expect(r.lines.at(-1)).toContain(`"t${TIMELINE_MAX_LINES + 119}"`)
  })

  it('leaves out what is older than the window start', () => {
    const lines = tl({ from: T, interaction: [tapAt(T - 1, 'old'), tapAt(T, 'new')], activity: [act(T - 5, 'app.start', { version: '1' })] })
    expect(lines.join('\n')).not.toMatch(/old|APP START/)
    expect(lines.join('\n')).toContain('"new"')
  })

  it('every activity kind reads as a sentence', () => {
    const rows = [
      act(T, 'event.undo', { type: 'point', seq: 40, set: 1, reason: 'undo' }),
      act(T, 'event.edit', { type: 'substitution', seq: 12, set: 2, reason: 'correction', changed: ['playerIn'] }),
      act(T, 'set.end', { set: 1, home: 25, away: 23 }),
      act(T, 'match.status', { from: 'live', to: 'ended' }),
      act(T, 'match.signature', { role: 'captain_home', signed: true }),
      act(T, 'sync.error', { resource: 'event', action: 'insert', status: 409, code: 'OV_MATCH_CLOSED', requestId: 'r-1', attempt: 2 }, { level: 'warn' }),
      act(T, 'app.error', { message: 'TypeError: x is undefined', source: 'window.error' }, { level: 'error' }),
      act(T, 'auth.sign_in'),
      act(T, 'activity.overflow', { dropped: 12 }, { level: 'warn' })
    ]
    expect(tl({ activity: rows }).slice(1).map(l => l.slice(14))).toEqual([
      'undo    Point seq 40 (set 1) undone',
      'fix     Substitution seq 12 (set 2) edited (playerIn), reason: correction',
      'set     Set 1 ended 25:23 (home:away)',
      'match   status: live → ended',
      'match   signature: captain_home signed',
      'sync    refused: event insert 409 OV_MATCH_CLOSED, attempt 2, request r-1',
      'error   TypeError: x is undefined [window.error]',
      'auth    signed in',
      'app     12 activity entries dropped (the device\'s log was full)'
    ])
  })

  it('interaction entries without a reader\'s use are null', () => {
    expect(interactionItem(ui(T, 'focus'))).toBe(null)
    expect(interactionItem({ ts: NaN })).toBe(null)
  })
})

describe('diagnostics report: redaction', () => {
  it('the device\'s secrets wherever they are, also grouped like on screen', () => {
    const token = `ovs_live_${fakeToken(27)}`
    const text = `game PIN 771234; shown as 771 234 and 771-234; token ${token} in a log; 1771234 is another number`
    const out = redactReport(text, { secrets: ['771234', token, '12'] })
    expect(out).toBe('game PIN [secret]; shown as [secret] and [secret]; token [secret] in a log; 1771234 is another number')
  })

  it('emails, phone numbers, JWTs, bearer tokens, secret pairs, data URLs, URL queries, random tokens', () => {
    const jwt = ['eyJ' + fakeToken(17, 1), 'eyJ' + fakeToken(24, 2), fakeToken(43, 3)].join('.')
    const hex64 = Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('')
    const text = [
      'from anna.muster@example.ch and Max.M+test@sub.example.org',
      'call +41 79 123 45 67 or 079 123 45 67 or 0041791234567 or (044) 123 45 67',
      `Authorization: Bearer abcdefghijkl12345 and ${jwt}`,
      '{"refereePin":"903211","game_pin": "771234", "access_token":"zzz", pin=4711 password: hunter2',
      'Code: 4711 · PIN 9032',
      'signature data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA== end',
      'https://app.openvolley.app/referee?pin=771234&match=12#x wss://relay.example/live?token=abc',
      `session ${hex64}`
    ].join('\n')
    const out = redactReport(text)
    for (const bad of ['anna.muster', 'example.org', '79 123 45 67', '0041791234567', '123 45 67', 'abcdefghijkl12345', jwt, '903211', '771234', 'zzz', '4711', 'hunter2', '9032', 'iVBORw0K', '?pin', 'match=12', 'token=abc', hex64.slice(0, 16)]) {
      expect(out, bad).not.toContain(bad)
    }
    expect(out).toContain('[email]')
    expect(out).toContain('[phone]')
    expect(out).toContain('https://app.openvolley.app/referee')
    expect(out).toContain('wss://relay.example/live')
  })

  it('keeps what support needs: ids, game numbers, times, dates, versions, scores, file names, the user agent', () => {
    const keep = [
      'Device id: 98132de2-0cfc-406f-98af-f98ebf1a5e75',
      'Game number: 406970, match_1761762600000_k3f9a2',
      '2026-10-29 22:01:03.120 · 22:01:03.004  score  Point A → 25:23 (set 1)  seq 141',
      'Version: 3.0.7 · openvolley-diagnostics-20261029-2201-g406970.txt',
      'at handleUndo (https://app.openvolley.app/assets/ContextualHelpPanel-Bq3xY_7a.js:1:61877)',
      'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.102 Safari/537.36',
      'Storage: 12.3 MB used of 2.0 GB · Screen 1280×800, 1.5× pixels'
    ].join('\n')
    expect(redactReport(keep)).toBe(keep)
  })

  it('token-shaped: random runs, not words, UUIDs or seed keys', () => {
    expect(isTokenShaped(fakeToken(32))).toBe(true)
    expect(isTokenShaped(Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(i * 5 + 1) % 16]).join(''))).toBe(true)
    expect(isTokenShaped('98132de2-0cfc-406f-98af-f98ebf1a5e75')).toBe(false)
    expect(isTokenShaped('match_1761762600000_k3f9a2')).toBe(false)
    expect(isTokenShaped('openvolley-diagnostics-20261029-2201-g406970')).toBe(false)
    expect(isTokenShaped('SupportFeedbackModal-Bq3xY_7a')).toBe(false)
  })
})

describe('diagnostics report: app log and match', () => {
  it('the same error told twice (activity and interaction log) is one entry with the longer stack; the last 200', () => {
    const merged = mergeAppLog([
      { ts: T, level: 'error', source: 'window.error', message: 'TypeError: x', frames: ['a.js:1'] },
      { ts: T + 5, level: 'error', source: 'window.error', message: 'TypeError: x', stack: 'TypeError: x\n    at f (a.js:1:2)\n    at g (b.js:3:4)' },
      { ts: T + 10 * S, level: 'warn', source: 'console', message: '[Sync] retry for PIN 771234' }
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0].stack).toContain('at g (b.js:3:4)')
    expect(merged[1].message).toBe('[Sync] retry for PIN [redacted]')
    const many = mergeAppLog(Array.from({ length: 300 }, (_, i) => ({ ts: T + i * 3000, level: 'warn', source: 'console', message: `w${i}` })))
    expect(many).toHaveLength(APP_LOG_MAX)
    expect(many.at(-1).message).toBe('w299')
  })

  it('the match: teams with their letters, sets, current score, serving team, line-ups, time-outs, substitutions, the last events', () => {
    const row = { id: 7, gameNumber: 406970, seed_key: 'match_1_x', status: 'live', test: false, coinTossTeamA: 'home', coinTossConfirmed: true, bestOf: 5, cloudBlock: { code: 'OV_SCORER_MOVED', scorer: { platform: 'android', at: '2026-10-29T21:00:00Z' } } }
    const ev = (seq, type, payload, setIndex = 2) => ({ id: seq, matchId: 7, seq, setIndex, type, payload, ts: new Date(T + seq * S).toISOString() })
    const events = [
      ev(1, 'lineup', { team: 'home', isInitial: true, lineup: { I: '7', II: '12', III: '3', IV: '9', V: '14', VI: '1' } }, 1),
      ev(2, 'point', { team: 'home' }, 1),
      ev(3, 'lineup', { team: 'home', isInitial: true, lineup: { I: '1', II: '7', III: '12', IV: '3', V: '9', VI: '14' } }),
      ev(4, 'point', { team: 'away' }),
      ev(5, 'timeout', { team: 'home' }),
      ev(6, 'substitution', { team: 'away', playerIn: 5, playerOut: 12 }),
      ev(7, 'remark', { text: 'Ball 7 was flat, Anna Muster saw it' })
    ]
    const lines = matchSection({ row, sets: [{ index: 1, homePoints: 25, awayPoints: 23, finished: true }, { index: 2, homePoints: 0, awayPoints: 1, finished: false }], events, homeTeam: { name: 'VBC Wiedikon' }, awayTeam: { name: 'Volley Zürich' }, unsent: '2 (2 event)' }, clock).join('\n')
    expect(lines).toMatch(/Teams:\s+VBC Wiedikon \(home, A\) – Volley Zürich \(away, B\)/)
    expect(lines).toMatch(/Sets \(home:away\):\s+set 1 25:23, set 2 0:1 \(running\)/)
    expect(lines).toMatch(/Serving:\s+away \(won the last point\)/)
    expect(lines).toMatch(/Line-up home:\s+I 1 · II 7 · III 12 · IV 3 · V 9 · VI 14 \(seq 3\)/)
    expect(lines).toMatch(/Line-up away:\s+none in this set/)
    expect(lines).toMatch(/Time-outs:\s+set 2: home 1, away 0/)
    expect(lines).toMatch(/Substitutions:\s+set 2: home 0, away 1/)
    expect(lines).toMatch(/Server:\s+another device scores it now \(android since 2026-10-29T21:00:00Z\)/)
    expect(lines).toMatch(/Unsent writes:\s+2 \(2 event\)/)
    expect(lines).toContain('Remark (35 characters)')
    expect(lines).not.toContain('Anna Muster')
    expect(lines).toMatch(/4 {6}22:01:07\.120 {2}2 {4}Point B · Set 2 · A 0:1 B/)
    expect(matchSection(null, clock)).toEqual(['No match is open on this device.'])
  })
})

describe('diagnostics report: the whole report', () => {
  const input = (extra = {}) => ({
    now: T,
    timeZone: TZ,
    gameNumber: 406970,
    summary: { appName: 'OpenVolley', app: 'scorer app', version: '3.0.7', platform: 'android', timeZone: TZ, online: true, deviceId: '98132de2-0cfc-406f-98af-f98ebf1a5e75', accountId: null, info: { sync: { status: 'synced', since: T - 60 * S } } },
    match: { note: 'No match is open on this device.' },
    timeline: { interaction: [tapAt(T - 5 * S, 'Point A')], activity: [], from: T - 7200 * S, sessionStart: T - 600 * S, notes: [] },
    appLog: [{ ts: T - S, level: 'error', source: 'console', message: 'boom', stack: 'Error: boom\n    at x (a.js:1:2)' }],
    secrets: ['771234'],
    ...extra
  })

  it('has the sections in order, and ends with the end line', () => {
    const r = buildDiagnosticsReport(input())
    const heads = ['OpenVolley diagnostics', '== 1. Summary', '== 2. Match', '== 3. Timeline', '== 4. App log', '== end of report ==']
    let pos = -1
    for (const h of heads) {
      const i = r.text.indexOf(h)
      expect(i, h).toBeGreaterThan(pos)
      pos = i
    }
    expect(r.text).toMatch(/Local time:\s+2026-10-29 22:01:03 \(Europe\/Zurich, UTC\+01:00\)/)
    expect(r.text).toMatch(/Sync status:\s+synced since 22:00:03/)
    expect(r.text).toMatch(/Account id:\s+not signed in/)
    expect(r.text).toContain('22:00:58.120  tap     "Point A"')
    expect(r.text).toContain('22:01:02.120  ERROR  [console] boom\n                     at x (a.js:1:2)')
    expect(r.fileName).toBe('openvolley-diagnostics-20261029-2201-g406970.txt')
    expect(r.bytes).toBe(new TextEncoder().encode(r.text).length)
    expect(r.lines).toBe(r.text.split('\n').length)
    expect(r.text).not.toContain('Desktop app')
  })

  it('the tablet apps: no timeline, the note says why', () => {
    const r = buildDiagnosticsReport(input({ timeline: null, timelineNote: 'No timeline: the referee app keeps no activity or interaction log.' }))
    expect(r.text).toContain('No timeline: the referee app keeps no activity or interaction log.')
    expect(r.timelineLines).toBe(0)
  })

  it('at most 2 MB: the oldest timeline lines go, and the top says how many', () => {
    const taps = Array.from({ length: 4000 }, (_, i) => tapAt(T - 4000 * S + i * S, `${'Ü'.repeat(30)} ${i}`))
    const big = buildDiagnosticsReport(input({ timeline: { interaction: taps, activity: [], from: T - 7200 * S, notes: [] } }), { maxBytes: 100 * 1024 })
    expect(big.bytes).toBeLessThanOrEqual(100 * 1024)
    expect(big.sizeCut).toBeGreaterThan(0)
    expect(big.text).toMatch(new RegExp(`NOTE: the report is cut to 100\\.0 KB: the ${big.sizeCut} oldest timeline lines are left out\\.`))
    expect(big.text).toContain(' 3999"')
    expect(big.text).not.toContain(' 0"')
    expect(big.text).toContain('== 4. App log')
    expect(big.text).toContain('== end of report ==')
    expect(REPORT_MAX_BYTES).toBe(2 * 1024 * 1024)
    const fits = buildDiagnosticsReport(input())
    expect(fits.sizeCut).toBe(0)
    expect(fits.text).not.toContain('NOTE:')
  })

  it('redacts the whole text, the timeline included', () => {
    const r = buildDiagnosticsReport(input({
      timeline: { interaction: [tapAt(T - S, 'PIN 771234')], activity: [], from: T - 7200 * S, notes: [] },
      appLog: [{ ts: T - S, level: 'error', source: 'console', message: 'mail to x@example.ch failed, token=abc123def', stack: null }]
    }))
    expect(r.text).not.toContain('771234')
    expect(r.text).not.toContain('x@example.ch')
    expect(r.text).not.toContain('abc123def')
  })
})
