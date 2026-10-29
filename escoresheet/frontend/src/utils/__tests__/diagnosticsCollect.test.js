// What the support diagnostics read on the device (utils/diagnosticsCollect)
// and what the apps publish for them (utils/diagnosticsInfo): the secrets to
// scrub, the tablet apps' report (no database, no timeline), the error trail.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { secretValuesOf, storageSecrets, collectDiagnosticsInput, isSecretKey } from '../diagnosticsCollect'
import { buildDiagnosticsReport } from '../diagnosticsReport'
import {
  setDiagnosticsInfo, getDiagnosticsInfo, installErrorTrail, getErrorTrail, noteAppProblem, resetDiagnosticsInfoForTests, ERROR_TRAIL_MAX
} from '../diagnosticsInfo'

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

function memoryStorage(entries = {}) {
  const store = { ...entries }
  return {
    get length() { return Object.keys(store).length },
    key: (i) => Object.keys(store)[i] ?? null,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] }
  }
}

afterEach(() => {
  resetDiagnosticsInfoForTests()
  vi.restoreAllMocks()
})

describe('diagnostics: the secrets to leave out', () => {
  it('a match row: every PIN, the connection PINs, the scorer claim; not the signatures, ids or names', () => {
    const row = {
      id: 3, gameNumber: 406970, seed_key: 'match_1_abc', gamePin: '771234', refereePin: 903211, homeTeamUploadPin: '120934',
      connection_pins: { referee: '903211', bench_home: '554433' }, scorerClaim: '2b6d0c9e-51f4-4a7e-9e1b-7c3d8a5f0e42',
      supersededClaims: ['0f1e2d3c-4b5a-4968-8776-655443322110'], homeCaptainSignature: 'data:image/png;base64,AAAA', homeName: 'VBC Wiedikon', pin: '12'
    }
    expect(secretValuesOf(row).sort()).toEqual(['0f1e2d3c-4b5a-4968-8776-655443322110', '120934', '2b6d0c9e-51f4-4a7e-9e1b-7c3d8a5f0e42', '554433', '771234', '903211', '903211'].sort())
  })

  it('web storage: tokens and PINs by key, inside JSON too; not the account id, the email or the settings', () => {
    const access = `ovs_${fakeToken(27, 11)}`
    const refresh = `rt_${fakeToken(22, 12)}`
    const storage = memoryStorage({
      api_auth_token: JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: 1793000000, user: { id: '4c1f7a2e-9b3d-4e8a-a6c5-2f0e1d9b7c3a', email: 'a@example.ch' } }),
      refereePin: '903211',
      bench_session: JSON.stringify({ matchId: 12, team: 'home', pin: '554433' }),
      'ov.connectionPins': JSON.stringify({ referee: '771234' }),
      'ov.deviceId': '98132de2-0cfc-406f-98af-f98ebf1a5e75',
      displayMode: 'auto',
      i18nextLng: 'de-CH',
      // words with "pin" or "token" in them, and settings under a secret's name, are no secrets
      typingHints: 'shown',
      'ov.pinnedMatch': '12',
      cookieConsent: 'true',
      'ov.tokenPrompt': 'never'
    })
    expect(storageSecrets(storage).sort()).toEqual(['554433', '771234', '903211', access, refresh].sort())
    expect(storageSecrets(null)).toEqual([])
    expect(['refereePin', 'game_pin', 'homeTeamUploadPin', 'connection_pins', 'api_auth_token', 'access_token', 'scorerClaim', 'supersededClaims', 'ov.connectionPins'].filter(k => !isSecretKey(k))).toEqual([])
    expect(['typing', 'mapping', 'pinned', 'spinner', 'shipping', 'tokenizer'].filter(isSecretKey)).toEqual([])
  })
})

describe('diagnostics: a tablet app (referee, bench, livescore)', () => {
  it('summary, its connection and its error trail; no database read, no timeline', async () => {
    const untouchable = new Proxy({}, { get: (_, k) => { throw new Error(`the database was read: ${String(k)}`) } })
    setDiagnosticsInfo('realtime', { status: 'connected', connectionType: 'auto', activeConnection: 'websocket', matchId: 'match_1_abc', error: null, lastUpdate: Date.parse('2026-10-29T21:00:00Z') })
    noteAppProblem('error', 'window.error', "TypeError: Cannot read properties of null (reading 'sets')", 'TypeError: x\n    at Referee (https://app.openvolley.app/assets/Referee-a1.js:1:2)')
    const local = memoryStorage({ refereePin: '903211' })
    const win = {
      location: { protocol: 'https:', host: 'app.openvolley.app', pathname: '/referee/', search: '?match=match_1_abc&pin=903211' },
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14)', onLine: true, languages: ['de-CH', 'de'] },
      screen: { width: 1280, height: 800 }, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1.5,
      localStorage: local, sessionStorage: memoryStorage(), matchMedia: () => ({ matches: false })
    }
    const now = Date.parse('2026-10-29T21:01:03.120Z')
    const input = await collectDiagnosticsInput({ db: untouchable, win, now, appEntry: 'referee', language: 'de-CH', timeZone: 'Europe/Zurich' })
    expect(input.timeline).toBe(null)
    expect(input.secrets).toContain('903211')
    const r = buildDiagnosticsReport(input)
    expect(r.text).toMatch(/App:\s+OpenVolley – referee app/)
    expect(r.text).toMatch(/Connection:\s+connected via websocket \(mode auto\), match match_1_abc, last update 22:00:00\.000/)
    expect(r.text).toContain('The referee app keeps no match on this device: it follows match match_1_abc (see the summary).')
    expect(r.text).toContain('No timeline: the referee app keeps no activity or interaction log (only the scorer app does).')
    expect(r.text).toContain("[window.error] TypeError: Cannot read properties of null (reading 'sets')")
    expect(r.text).toContain('at Referee (https://app.openvolley.app/assets/Referee-a1.js:1:2)')
    expect(r.text).toMatch(/Page:\s+https:\/\/app\.openvolley\.app\/referee\/$/m)
    expect(r.text).not.toContain('903211')
    expect(r.fileName).toBe('openvolley-diagnostics-20261029-2201.txt')
  })
})

describe('diagnostics: what the apps publish', () => {
  it('the latest value per key, with its time; null removes it', () => {
    setDiagnosticsInfo('bench', { view: 'match' })
    setDiagnosticsInfo('bench', { view: 'roster' })
    expect(getDiagnosticsInfo().bench).toMatchObject({ view: 'roster' })
    expect(Number.isFinite(getDiagnosticsInfo().bench.at)).toBe(true)
    setDiagnosticsInfo('bench', null)
    expect(getDiagnosticsInfo()).toEqual({})
  })

  it('the error trail: console errors and warnings (still printed) and uncaught errors, the last 200, in memory', () => {
    const printed = []
    const con = { error: (...a) => printed.push(['error', ...a]), warn: (...a) => printed.push(['warn', ...a]), log: () => {} }
    const listeners = {}
    const win = { addEventListener: (t, f) => { listeners[t] = f }, removeEventListener: (t) => { delete listeners[t] } }
    const uninstall = installErrorTrail({ win, con })
    const err = new Error('relay gone')
    con.error('[Bench] socket:', err)
    con.warn('[Bench] slow')
    listeners.error({ message: 'Script error', error: { message: 'boom', stack: 'Error: boom\n    at a (b.js:1:2)' } })
    listeners.unhandledrejection({ reason: new TypeError('nope') })
    expect(printed.map(p => p[0])).toEqual(['error', 'warn'])
    const trail = getErrorTrail()
    expect(trail.map(e => [e.level, e.source])).toEqual([['error', 'console'], ['warn', 'console'], ['error', 'window.error'], ['error', 'unhandledrejection']])
    expect(trail[0].message).toContain('[Bench] socket: Error: relay gone')
    expect(trail[0].stack).toBe(err.stack)
    expect(trail[2]).toMatchObject({ message: 'boom', stack: 'Error: boom\n    at a (b.js:1:2)' })
    uninstall()
    con.error('after')
    expect(getErrorTrail()).toHaveLength(4)
    expect(listeners).toEqual({})
    for (let i = 0; i < ERROR_TRAIL_MAX + 10; i++) noteAppProblem('warn', 'console', `w${i}`)
    expect(getErrorTrail()).toHaveLength(ERROR_TRAIL_MAX)
    expect(getErrorTrail().at(-1).message).toBe(`w${ERROR_TRAIL_MAX + 9}`)
  })
})
