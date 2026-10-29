// The support diagnostics report of a realistic evening, end to end on the
// real app database (Dexie 4 on fake-indexeddb): a scorer sets up an official
// match, plays most of set 1 (taps, a time-out, a substitution, an undo, a
// sync error, the app in the background for 7 minutes), then opens Support &
// feedback. The activity log hooks, the interaction log and the logger all
// run for real; the collector reads them back and the builder writes the
// text. DIAG_SAMPLE_OUT=<path> also saves the report there (the owner's
// sample of a ticket's attachment).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import { db } from '../../db/db'
import { withActivityContext, eventHistorySettled } from '../../db/eventHistory'
import { startActivityLog } from '../activity'
import { emitActivity, flushActivityNow } from '../activity/bus'
import { reportAppError } from '../activity/appError'
import { setActiveMatch } from '../activity/activeMatch'
import { initComprehensiveLogger, log, logUI, shutdownLogger } from '../comprehensiveLogger'
import { debugLogger } from '../debugLogger'
import { captureConsole, resetLoggerForTests } from '../logger'
import { setDiagnosticsInfo, resetDiagnosticsInfoForTests } from '../diagnosticsInfo'
import { collectDiagnosticsInput } from '../diagnosticsCollect'
import { buildDiagnosticsReport } from '../diagnosticsReport'

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

const SEED = 'match_1761762600000_k3f9a2'
const GAME = 406970
const PINS = { gamePin: '771234', refereePin: '903211', homeTeamPin: '554433', awayTeamPin: '667788', homeTeamUploadPin: '120934', awayTeamUploadPin: '448812' }
const TOKEN = `ovs_${fakeToken(39, 5)}`
const ACCOUNT = '4c1f7a2e-9b3d-4e8a-a6c5-2f0e1d9b7c3a'
const T0 = Date.parse('2026-10-29T18:40:00Z') // 19:40 in Zürich
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} }

let at = T0
const setTime = (ms) => { at = ms; vi.setSystemTime(ms) }
const step = (s) => setTime(at + s * 1000)
const settle = async () => {
  await new Promise(r => setTimeout(r, 15))
  await eventHistorySettled()
  await flushActivityNow(500)
}

const button = (text, extra = {}) => ({ tagName: 'button', id: null, className: 'inline-flex', name: null, type: 'button', role: null, ariaLabel: null, textContent: text, href: null, path: 'div.court > button.inline-flex', dataAttributes: {}, ...extra })
const field = (label, extra = {}) => ({ tagName: 'input', id: null, className: 'w-full', name: null, type: 'text', role: null, ariaLabel: label, textContent: null, href: null, path: 'form > label > input.w-full', dataAttributes: {}, ...extra })

function tap(target, component = 'global') {
  logUI('touchstart', component, 'touchstart', { touches: 1 }, target)
  step(0.08)
  logUI('touchend', component, 'touchend', { touches: 0 }, target)
  logUI('click', component, 'click', { button: 0, clientX: 400, clientY: 300 }, target)
}

function typeInto(target, text, component = 'global') {
  for (let i = 0; i < text.length; i++) {
    logUI('keydown', component, 'keydown', { key: text[i], code: `Key${text[i].toUpperCase()}` }, target)
    logUI('input', component, 'input', { inputType: 'insertText', value: text.slice(0, i + 1), valueLength: i + 1 }, target)
    logUI('keyup', component, 'keyup', { key: text[i] }, target)
    step(0.15)
  }
}

function scrollFor(n, component = 'global') {
  for (let i = 0; i < n; i++) {
    logUI('scroll', component, 'scroll', { scrollTop: i * 40 }, { tagName: 'div', path: 'main > div.overflow-y-auto' })
    step(0.5)
  }
}

describe('diagnostics report: a realistic evening (sample)', () => {
  let activity
  let report
  let matchId
  const homeTeam = { name: 'VBC Wiedikon' }
  const awayTeam = { name: 'Volley Zürich Nord' }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setTime(T0)
    resetLoggerForTests()
    resetDiagnosticsInfoForTests()
    localStorage.clear()
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: TOKEN, refresh_token: 'rt_' + TOKEN, expires_at: Math.floor(T0 / 1000) + 30 * 86400, user: { id: ACCOUNT, email: 'scorer.wiedikon@example.ch' } }))
    localStorage.setItem('refereePin', PINS.refereePin)
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    activity = startActivityLog({ db })
    initComprehensiveLogger(null, null)
    log('navigation', 'component_mount', 'App', 'root_mount', {})
    await settle()

    // Home screen: new official match, teams typed in, league picked
    step(20)
    tap(button('New match'))
    step(2)
    tap(button('Official match'))
    step(3)
    typeInto(field('Home team'), 'VBC Wiedikon')
    step(1)
    logUI('keydown', 'global', 'keydown', { key: 'Tab', code: 'Tab' }, field('Home team'))
    typeInto(field('Away team'), 'Volley Zürich Nord')
    logUI('change', 'global', 'change', { value: '3L', selectedIndex: 4 }, { tagName: 'select', name: 'league', ariaLabel: 'League', type: 'select-one', path: 'form > select' })
    // the approval PIN field: eventCapture writes no key and no value
    logUI('keydown', 'global', 'keydown', { key: '[REDACTED]', code: '[REDACTED]' }, field('Approval PIN', { type: 'password' }))
    logUI('input', 'global', 'input', { inputType: 'insertText', value: '[REDACTED]', valueLength: null }, field('Approval PIN', { type: 'password' }))
    const homeTeamId = await db.teams.add(homeTeam)
    const awayTeamId = await db.teams.add(awayTeam)
    for (const [team, numbers] of [[homeTeamId, [1, 3, 7, 9, 12, 14, 5, 8]], [awayTeamId, [2, 4, 6, 10, 11, 13, 15, 16]]]) {
      for (const n of numbers) await db.players.add({ teamId: team, number: n, name: `Player ${n}`, dob: '2004-05-17' })
    }
    matchId = await db.matches.add({
      status: 'scheduled', seed_key: SEED, gameNumber: GAME, homeTeamId, awayTeamId, test: false, bestOf: 5,
      createdAt: new Date(at).toISOString(), scorerClaim: '2b6d0c9e-51f4-4a7e-9e1b-7c3d8a5f0e42', ...PINS,
      connection_pins: { referee: PINS.refereePin, bench_home: PINS.homeTeamPin }, homeCaptainSignature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
    })
    setActiveMatch(await db.matches.get(matchId))
    await settle()
    step(40)
    scrollFor(12)
    tap(button('Save and continue'), 'MatchSetup')
    await settle()

    // Coin toss: team A is the away team
    step(90)
    tap(button('Coin toss'))
    step(30)
    tap(button('Confirm coin toss result'), 'CoinToss')
    await db.matches.update(matchId, { status: 'live', coinTossTeamA: 'away', coinTossConfirmed: true })
    await settle()

    // Set 1: line-ups and the rallies
    step(60)
    const setId = await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    let seq = 0
    const addEvent = async (type, payload, snapshot = null) => {
      seq += 1
      const id = await db.events.add({ matchId, setIndex: 1, type, payload, ts: new Date(at).toISOString(), seq, ...(snapshot ? { stateSnapshot: snapshot } : {}) })
      return id
    }
    await addEvent('lineup', { team: 'home', isInitial: true, lineup: { I: '7', II: '12', III: '3', IV: '9', V: '14', VI: '1' } }, { pointsA: 0, pointsB: 0 })
    await addEvent('lineup', { team: 'away', isInitial: true, lineup: { I: '4', II: '10', III: '2', IV: '11', V: '6', VI: '13' } }, { pointsA: 0, pointsB: 0 })
    await settle()
    let home = 0
    let away = 0
    const point = async (team) => {
      step(6)
      await addEvent('rally_start', {})
      step(14 + (seq % 5) * 3)
      // Team A is the away team: "Point A" is away's point
      tap(button(team === 'away' ? 'Point A' : 'Point B'), 'Scoreboard')
      if (team === 'home') home++
      else away++
      await addEvent('point', { team }, { pointsA: away, pointsB: home })
      await db.sets.update(setId, { homePoints: home, awayPoints: away })
      debugLogger.log('POINT_AWARDED', { team, homeScore: home, awayScore: away })
      if (seq % 4 === 0) {
        logUI('touchmove', 'Scoreboard', 'touchmove', { touches: 1 }, { tagName: 'div', path: 'div.court' })
        step(0.1)
        logUI('touchmove', 'Scoreboard', 'touchmove', { touches: 1 }, { tagName: 'div', path: 'div.court' })
      }
      await settle()
    }
    for (const team of ['home', 'away', 'away', 'home', 'away', 'away', 'home', 'home', 'away', 'away']) await point(team)

    // A time-out for B (home), then a substitution
    step(5)
    tap(button('Time-out'), 'Scoreboard')
    step(1)
    tap(button('Time-out B'), 'Scoreboard')
    await addEvent('timeout', { team: 'home' }, { pointsA: away, pointsB: home })
    debugLogger.log('TIMEOUT', { team: 'home' })
    await settle()
    step(30)
    tap(button('Confirm time-out'), 'Scoreboard')
    for (const team of ['home', 'home', 'away', 'home']) await point(team)
    step(8)
    tap(button('Substitution'), 'Scoreboard')
    step(4)
    tap(button('#5'), 'Scoreboard')
    step(2)
    tap(button('#12'), 'Scoreboard')
    await addEvent('substitution', { team: 'home', playerIn: 5, playerOut: 12 }, { pointsA: away, pointsB: home })
    debugLogger.log('SUBSTITUTION', { team: 'home', playerIn: 5, playerOut: 12 })
    await settle()

    // The sync queue: the backend is down for a while
    step(10)
    captureConsole('warn', ['[SyncQueue] Job 41 (event insert) got a 503 without a backend error code; retrying later'], silent)
    emitActivity('sync.error', { resource: 'event', action: 'insert', status: 503, code: null, requestId: 'req-7f3a91', attempt: 2 }, { level: 'warn', matchId })
    emitActivity('sync.state', { from: 'synced', to: 'error' }, { level: 'warn' })
    for (let i = 0; i < 3; i++) {
      await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:${20 + i}`, match_id: SEED }, ts: new Date(at).toISOString(), status: 'queued' })
    }
    await db.sync_queue.add({ resource: 'set', action: 'update', payload: { external_id: `${SEED}:s:${setId}`, match_id: SEED, game_pin: PINS.gamePin }, ts: new Date(at).toISOString(), status: 'error', attempts: 3, next_attempt_at: at + 120000, last_error: { status: 503, code: null, message: 'Service Unavailable' } })
    setDiagnosticsInfo('sync', { status: 'error', since: at, lastPass: { at, processed: 4, sent: 0, error: true, failed: false, retry: true, stopped: true, authRequired: false } })
    setDiagnosticsInfo('relay', { state: 'open', url: 'wss://backend.example.test/relay', users: 2, reconnectAttempt: 0, lastMessageAt: at - 4000, clock: { offsetMs: -412, rttMs: 86, at: at - 30000 } })
    await settle()

    // An undo of the last point, with a typing PIN in an error message
    for (const team of ['away', 'home']) await point(team)
    step(12)
    tap(button('Undo'), 'Scoreboard')
    step(3)
    tap(button('Undo last point'), 'Scoreboard')
    const last = await db.events.where('matchId').equals(matchId).filter(e => e.type === 'point').last()
    await withActivityContext({ reason: 'undo', actionId: 'u1' }, () => db.events.delete(last.id))
    await db.sets.update(setId, { homePoints: --home })
    await settle()
    const err = new TypeError("Cannot read properties of undefined (reading 'payload')")
    err.stack = `TypeError: Cannot read properties of undefined (reading 'payload')\n    at describeLastAction (https://app.openvolley.app/assets/Scoreboard-C3xYz_12.js:1:52311)\n    at handleUndo (https://app.openvolley.app/assets/Scoreboard-C3xYz_12.js:1:61877)\n    at HTMLButtonElement.onClick (https://app.openvolley.app/assets/index-B1x2Y3z4.js:9:1044)`
    captureConsole('error', ['[Scoreboard] Undo label failed for game PIN 771234:', err], silent)
    reportAppError(err.message, err.stack, 'window.error')
    logUI('error', 'global', 'error', { message: err.message, filename: 'https://app.openvolley.app/assets/Scoreboard-C3xYz_12.js?pin=771234', lineno: 1, colno: 52311, error: err.stack })
    await settle()

    // The phone goes to the pocket for 7 minutes
    step(4)
    log('system', 'visibility', 'App', 'hidden')
    step(7 * 60)
    log('system', 'visibility', 'App', 'visible')
    log('system', 'network', 'App', 'offline')
    step(20)
    log('system', 'network', 'App', 'online')
    for (const team of ['away', 'away', 'home']) await point(team)
    scrollFor(5, 'Scoreboard')

    // Then: the help, Support & feedback, a message typed
    step(25)
    tap(button('', { ariaLabel: 'Help', tagName: 'button' }), 'Scoreboard')
    step(6)
    tap(button('Contact support'))
    logUI('change', 'global', 'change', { value: 'support', selectedIndex: 1 }, { tagName: 'select', ariaLabel: 'What can we help you with?', type: 'select-one' })
    logUI('change', 'global', 'change', { value: 'bug', selectedIndex: 1 }, { tagName: 'select', ariaLabel: 'What type of support do you need?', type: 'select-one' })
    typeInto({ tagName: 'textarea', ariaLabel: 'Comments or description', path: 'label > textarea' }, 'Undo crashes after a sub')
    typeInto(field('Your email (for follow-up)', { type: 'email' }), 'scorer.wiedikon@example.ch')
    step(3)
    await settle()

    // the sample in the owner's time zone, whatever the machine's
    const input = await collectDiagnosticsInput({ db, now: at, appEntry: 'scorer', language: 'de-CH', timeZone: 'Europe/Zurich' })
    report = buildDiagnosticsReport(input)
    if (process.env.DIAG_SAMPLE_OUT) fs.writeFileSync(process.env.DIAG_SAMPLE_OUT, report.text)
  })

  afterAll(() => {
    activity?.stop()
    shutdownLogger()
    resetDiagnosticsInfoForTests()
    vi.useRealTimers()
  })

  it('has every section, the match and the evening in order', () => {
    const t = report.text
    for (const h of ['== 1. Summary', '== 2. Match', '== 3. Timeline', '== 4. App log', '== end of report ==']) expect(t).toContain(h)
    expect(report.fileName).toBe('openvolley-diagnostics-20261029-2001-g406970.txt')
    expect(t).toMatch(/Game number:\s+406970/)
    expect(t).toContain('VBC Wiedikon (home, B) – Volley Zürich Nord (away, A)')
    expect(t).toMatch(/Time-outs:\s+set 1: home 1, away 0/)
    expect(t).toMatch(/Substitutions:\s+set 1: home 1, away 0/)
    expect(t).toMatch(/Unsent writes:\s+5 \(1 set, 4 event\)/)
    expect(t).toContain('this device holds a scorer claim')
    expect(t).toMatch(/Clock offset:\s+the relay's clock is -412 ms/)
    const tl = t.slice(t.indexOf('== 3. Timeline'), t.indexOf('== 4. App log'))
    const order = ['APP START', 'tap     "New match"', 'typed 12 keys into "Home team"', 'a password or PIN field', 'tap     "Point B"', 'Point B (home) → 0:1 (set 1)', 'Time-out B (home)', 'Substitution B (home) #5 in for #12', 'refused: event insert 503', 'undone', 'APP IN THE BACKGROUND', 'with nothing recorded', 'APP IN THE FOREGROUND AGAIN', 'the device went offline', '"Contact support"']
    let pos = -1
    for (const s of order) {
      const i = tl.indexOf(s, pos + 1)
      expect(i, s).toBeGreaterThan(pos)
      pos = i
    }
    expect(tl).toMatch(/scrolled ×12 over \d+ s/)
    expect(tl).toMatch(/pointer moved ×2/)
    // the presses of a tap are part of it
    expect(tl).not.toContain('touched (no tap)')
  })

  it('the app log holds the error once, with its stack, and the warning', () => {
    const log4 = report.text.slice(report.text.indexOf('== 4. App log'))
    expect(log4).toContain('WARN   [console] [SyncQueue] Job 41')
    expect(log4).toContain("TypeError: Cannot read properties of undefined (reading 'payload')")
    expect(log4).toContain('at handleUndo (https://app.openvolley.app/assets/Scoreboard-C3xYz_12.js:1:61877)')
  })

  it('holds no PIN, token, email, signature or typed text', () => {
    const t = report.text
    for (const pin of Object.values(PINS)) {
      expect(t).not.toContain(pin)
      expect(t).not.toContain(`${pin.slice(0, 3)} ${pin.slice(3)}`)
    }
    expect(t).not.toContain(TOKEN)
    expect(t).not.toContain('2b6d0c9e-51f4-4a7e-9e1b-7c3d8a5f0e42') // the scorer claim
    expect(t).not.toContain('scorer.wiedikon@example.ch')
    expect(t).not.toContain('@example.ch')
    expect(t).not.toContain('data:image')
    expect(t).not.toContain('iVBORw0KGgo')
    expect(t).not.toContain('2004-05-17')
    expect(t).not.toContain('Undo crashes after a sub')
    expect(t).not.toContain('Volley Zürich Nord"') // the typed value of the away team field
    expect(t).toContain(ACCOUNT)
  })

  it('stays a small file for an evening like this', () => {
    expect(report.bytes).toBeLessThan(200 * 1024)
    expect(report.sizeCut).toBe(0)
  })
})
