/**
 * MatchEnd for a match stopped for impossibility to resume or forfeited:
 *  - the results table names no winner and no result for a stopped match
 *    (the winner card and the PDF have none);
 *  - Reopen last set removes the set's match_stopped event, so the record no
 *    longer says the match was stopped there;
 *  - Reopen last set reverses a forfeit from its forfait event, also on a
 *    device that continued the match from the cloud (the match row's
 *    forfeitTeam and the sets' forfeitCreated stay on the scoring device);
 *  - and a default (FIVB 6.4.1-2) gives the played sets their score back,
 *    still finished.
 * Real MatchEnd, real Dexie (fake-indexeddb), the real cloud import.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
const interpolate = (text, vars) => String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const found = lookup(key)
      if (typeof found === 'string') return interpolate(found, typeof opts === 'object' ? opts : undefined)
      return typeof opts === 'string' ? opts : key
    },
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))
vi.mock('../../contexts/LoggingContext', () => {
  const noop = () => {}
  const logger = { logHandler: noop, logFunction: noop, logCallback: noop, logHook: noop, logEffect: noop, logError: noop, wrapHandler: (fn) => fn, wrapFunction: (fn) => fn }
  return { useComponentLogging: () => logger, useLogging: () => ({ createComponentLogger: () => logger, logNavigation: () => {} }) }
})
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn(), showConfirm: vi.fn() }) }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, access: null }) }))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (n) => `${n}vmin` }), default: () => ({ vmin: (n) => `${n}vmin` }) }))
vi.mock('../../utils/comprehensiveLogger', () => ({ exportLogsAsNDJSON: async () => '', downloadLogs: async () => {} }))
vi.mock('../../utils/askConfirm.js', () => ({ askConfirm: async () => true, default: async () => true }))
vi.mock('../../lib/accountApi', async (orig) => ({
  ...(await orig()),
  approvalsApi: { approve: vi.fn(), list: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })), undo: vi.fn() }
}))
vi.mock('../../lib/apiClient', () => {
  const chain = () => {
    const b = new Proxy({}, { get: (_, prop) => (prop === 'then' ? (r) => Promise.resolve({ data: null, error: null }).then(r) : () => b) })
    return b
  }
  return {
    apiFrom: () => chain(),
    apiStorage: { from: () => chain() },
    apiRequest: vi.fn(),
    apiMatchRestoreByPin: vi.fn(),
    apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })),
    writingDevice: () => ({ id: '00000000-0000-4000-8000-000000000001', platform: 'web' }),
    OV_PROTO: '2'
  }
})
vi.mock('../SignaturePad', () => ({ default: () => null }))

import { db } from '../../db/db'
import MatchEnd from '../MatchEnd'
import { importMatchFromSupabase } from '../../utils/backupManager'
import { setExtId } from '../../utils/syncIds'

const SEED = 'match_1792931096817_stopfrft'
const T = (m) => `2026-10-05T18:${String(m).padStart(2, '0')}:00.000Z`

// Best of 5. Set 1 home 25:20. At 10:12 in set 2 the HOME team forfeits the
// match as an incomplete team (6.4.3): away is given 13 points in set 2
// (10:25), sets 3 and 4 are created 0:25. Away wins 3:1.
function incompleteScenario() {
  const sets = [
    { n: 1, index: 1, home: 25, away: 20, created: false },
    { n: 2, index: 2, home: 10, away: 25, created: false },
    { n: 3, index: 3, home: 0, away: 25, created: true },
    { n: 4, index: 4, home: 0, away: 25, created: true }
  ]
  const events = []
  let seq = 0
  const ev = (setIndex, type, payload) => events.push({ n: events.length + 1, setIndex, type, payload, seq: ++seq, ts: T(seq % 60) })
  ev(1, 'set_end', { team: 'home', setIndex: 1, homePoints: 25, awayPoints: 20 })
  for (let i = 0; i < 10; i++) ev(2, 'point', { team: 'home' })
  for (let i = 0; i < 12; i++) ev(2, 'point', { team: 'away' })
  for (let i = 0; i < 13; i++) ev(2, 'point', { team: 'away', forfeitAwarded: true })
  for (const s of [2, 3, 4]) ev(s, 'set_end', { team: 'away', setIndex: s, homePoints: s === 2 ? 10 : 0, awayPoints: 25, reason: 'forfait' })
  ev(2, 'forfait', { team: 'home', reason: 'injury', scope: 'match', setIndex: 2, setsBefore: [{ id: 2, index: 2, homePoints: 10, awayPoints: 12 }] })
  return { sets, events }
}

async function addTeams() {
  const homeTeamId = await db.teams.add({ name: 'Home V' })
  const awayTeamId = await db.teams.add({ name: 'Away V' })
  return { homeTeamId, awayTeamId }
}

async function seedLocal({ match = {}, sets, events }) {
  const teams = await addTeams()
  const id = await db.matches.add({ seed_key: SEED, status: 'ended', test: false, coinTossTeamA: 'home', bestOf: 5, officials: [], ...teams, ...match })
  const ids = {}
  for (const s of sets) ids[s.index] = await db.sets.add({ matchId: id, index: s.index, homePoints: s.home, awayPoints: s.away, finished: s.finished !== false, ...(s.endTime ? { endTime: s.endTime } : {}), ...(s.created ? { forfeitCreated: true } : {}) })
  for (const e of events) await db.events.add({ matchId: id, setIndex: e.setIndex, type: e.type, payload: typeof e.payload === 'function' ? e.payload(ids) : e.payload, seq: e.seq, ts: e.ts })
  return { id, setIds: ids }
}

// The same match as the cloud holds it (what the sync sent), continued on another device
async function importFromCloud({ sets, events }) {
  return importMatchFromSupabase({
    match: {
      id: '11111111-1111-4111-8111-1111111111cc', external_id: SEED, game_n: 939718, status: 'ended', test: false, sport_type: 'indoor',
      home_team: { name: 'Home V' }, away_team: { name: 'Away V' }, officials: [], signatures: {},
      coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, confirmed: true, first_serve: 'home' }, match_info: { best_of: 5 }
    },
    sets: sets.map(s => ({ external_id: `${SEED}:s:${s.n}`, index: s.index, home_points: s.home, away_points: s.away, finished: true })),
    events: events.map(e => ({ external_id: `${SEED}:e:${e.n}`, set_index: e.setIndex, type: e.type, payload: e.payload, seq: e.seq, ts: e.ts }))
  })
}

const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 50)))

async function reopenLastSet(matchId) {
  const onReopen = vi.fn()
  render(<MatchEnd matchId={matchId} onReopenLastSet={onReopen} />)
  await settle()
  fireEvent.click(await screen.findByRole('button', { name: en.matchEnd.reopenLastSet }))
  fireEvent.click(await screen.findByRole('button', { name: en.matchEnd.yesReopen }))
  await waitFor(() => expect(onReopen).toHaveBeenCalled())
  cleanup()
  const sets = (await db.sets.where('matchId').equals(matchId).sortBy('index')).map(s => `${s.index}:${s.homePoints}-${s.awayPoints}${s.finished ? 'F' : ''}`)
  const events = await db.events.where('matchId').equals(matchId).toArray()
  return { sets, events, status: (await db.matches.get(matchId)).status }
}

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
  globalThis.URL.createObjectURL ||= () => 'blob:test'
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Best of 5 stopped for impossibility to resume at 2:1 in sets, set 4 at 14:12
const STOPPED = {
  match: { stoppedReason: 'impossibility_to_resume' },
  sets: [
    { index: 1, home: 25, away: 20 }, { index: 2, home: 20, away: 25 }, { index: 3, home: 25, away: 18 },
    { index: 4, home: 14, away: 12, finished: false }
  ],
  events: [
    { setIndex: 1, type: 'set_end', payload: { team: 'home', setIndex: 1 }, seq: 1, ts: T(1) },
    { setIndex: 2, type: 'set_end', payload: { team: 'away', setIndex: 2 }, seq: 2, ts: T(2) },
    { setIndex: 3, type: 'set_end', payload: { team: 'home', setIndex: 3 }, seq: 3, ts: T(3) },
    { setIndex: 4, type: 'point', payload: { team: 'home' }, seq: 4, ts: T(4) },
    { setIndex: 4, type: 'match_stopped', payload: { reason: 'impossibility_to_resume', setIndex: 4, homePoints: 14, awayPoints: 12 }, seq: 5, ts: T(5) }
  ]
}

describe('MatchEnd of a match stopped for impossibility to resume', () => {
  it('the results table names no winner and no result (2:1 in sets is no result)', async () => {
    const { id } = await seedLocal(STOPPED)
    render(<MatchEnd matchId={id} />)
    await settle()
    const valueOf = async (label) => {
      const labels = await screen.findAllByText(label)
      const inTable = labels.find(el => el.tagName === 'SPAN' && el.nextElementSibling)
      return inTable.nextElementSibling.textContent
    }
    expect(screen.getAllByText(en.matchEnd.noWinner).length).toBeGreaterThan(0)
    expect(await valueOf(en.matchEnd.winner)).toBe('-')
    expect(await valueOf(en.matchEnd.result)).toBe('-')
  })

  it('a finished match prints its winner and result there', async () => {
    const { id } = await seedLocal({
      sets: [{ index: 1, home: 25, away: 20 }, { index: 2, home: 20, away: 25 }, { index: 3, home: 25, away: 18 }, { index: 4, home: 25, away: 23 }],
      events: []
    })
    render(<MatchEnd matchId={id} />)
    await settle()
    const labels = await screen.findAllByText(en.matchEnd.result)
    const inTable = labels.find(el => el.tagName === 'SPAN' && el.nextElementSibling)
    expect(inTable.nextElementSibling.textContent).toBe('3:1')
    const winner = (await screen.findAllByText(en.matchEnd.winner)).find(el => el.tagName === 'SPAN' && el.nextElementSibling)
    expect(winner.nextElementSibling.textContent).toBe('Home V')
  })

  it('Reopen last set removes the set\'s match_stopped event', async () => {
    const { id } = await seedLocal(STOPPED)
    const r = await reopenLastSet(id)
    expect(r.status).toBe('live')
    expect(r.sets).toEqual(['1:25-20F', '2:20-25F', '3:25-18F', '4:14-12'])
    expect(r.events.filter(e => e.type === 'match_stopped')).toHaveLength(0)
    expect((await db.matches.get(id)).stoppedReason).toBeNull()
  })
})

describe('Reopen last set after a forfeit', () => {
  it('on a device that continued the match from the cloud: set 2 back at 10:12, the created sets gone', async () => {
    const id = await importFromCloud(incompleteScenario())
    const r = await reopenLastSet(id)
    expect(r.status).toBe('live')
    expect(r.sets).toEqual(['1:25-20F', '2:10-12'])
    expect(r.events.filter(e => e.type === 'forfait')).toHaveLength(0)
    expect(r.events.filter(e => e.payload?.forfeitAwarded)).toHaveLength(0)
  })

  it('a default after sets were played: set 1 gets its 25:20 back, still finished, and the cloud is told', async () => {
    // Home won set 1 25:20 and refused to play on at 10:12 in set 2: sets 1-3 0:25
    const END1 = T(30)
    const { id, setIds } = await seedLocal({
      match: { forfeitTeam: 'home', forfeitReason: 'forfeit' },
      sets: [
        { index: 1, home: 0, away: 25, endTime: END1 },
        { index: 2, home: 0, away: 25 },
        { index: 3, home: 0, away: 25, created: true }
      ],
      events: [
        { setIndex: 1, type: 'set_end', payload: { team: 'home', setIndex: 1, homePoints: 25, awayPoints: 20 }, seq: 1, ts: T(1) },
        { setIndex: 2, type: 'point', payload: { team: 'away' }, seq: 2, ts: T(2) },
        { setIndex: 2, type: 'set_end', payload: { team: 'away', setIndex: 2, homePoints: 0, awayPoints: 25, reason: 'forfait' }, seq: 3, ts: T(3) },
        { setIndex: 3, type: 'set_end', payload: { team: 'away', setIndex: 3, homePoints: 0, awayPoints: 25, reason: 'forfait' }, seq: 4, ts: T(4) },
        {
          setIndex: 2, type: 'forfait', seq: 5, ts: T(5),
          payload: (ids) => ({
            team: 'home', reason: 'forfeit', scope: 'match', inDefault: true, setIndex: 2,
            setsBefore: [
              { id: ids[1], index: 1, homePoints: 25, awayPoints: 20, finished: true, endTime: END1 },
              { id: ids[2], index: 2, homePoints: 10, awayPoints: 12 }
            ]
          })
        }
      ]
    })
    const r = await reopenLastSet(id)
    expect(r.status).toBe('live')
    expect(r.sets).toEqual(['1:25-20F', '2:10-12'])
    expect((await db.sets.get(setIds[1])).endTime).toBe(END1)
    const set1Jobs = (await db.sync_queue.toArray()).filter(j => j.resource === 'set' && j.payload?.external_id === setExtId(SEED, setIds[1]))
    expect(set1Jobs.map(j => j.payload)).toEqual([
      { home_points: 25, away_points: 20, finished: true, end_time: END1, external_id: setExtId(SEED, setIds[1]), match_id: SEED }
    ])
  })
})
