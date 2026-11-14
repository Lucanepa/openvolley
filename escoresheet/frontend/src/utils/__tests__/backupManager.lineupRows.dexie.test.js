// A match continued on another device (restore by game PIN, "Take back
// scoring here": fetchMatchByPin + importMatchFromSupabase) in the middle of
// a set, against the real app database (Dexie 4 on fake-indexeddb).
// The line-up after a substitution, a libero replacement and a side-out
// rotation is a line-up sub-row (N.x) of its entry. Versions before this fix
// never sent those rows: the server had the starting line-ups and the
// entries only, and the device that continued showed the set's starting six
// (substitutes on the bench, the libero off court, nobody rotated) and served
// with the wrong player.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const byPin = vi.hoisted(() => ({ result: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no network in this test') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: vi.fn(async () => byPin.result),
  apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })),
  writingDevice: () => ({ id: '00000000-0000-4000-8000-000000000001', platform: 'web' }),
  OV_PROTO: '2'
}))

import { db } from '../../db/db'
import { fetchMatchByPin, importMatchFromSupabase } from '../backupManager'

const POS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const seed = 'match_1792931096817_lineuprows'
const lineupOf = (list) => Object.fromEntries(POS.map((p, i) => [p, String(list[i])]))
const rich = (list) => Object.fromEntries(POS.map((p, i) => [p, { number: list[i] }]))
const asText = (lineup) => Object.fromEntries(POS.map(p => [p, String(lineup?.[p] ?? '')]))

// Set 1, home (team A) serves first. Home: 1-7, liberos #10 (L1) and #11 (L2).
//  5 point home (home served: no rotation)               1:0
//  6 substitution home #3 -> #7 at III
//  7 libero #10 in for #6 at VI
//  8 point away: side-out, away rotates                  1:1
//  9 point home: side-out, home rotates (libero VI -> V) 2:1
// 10 libero exchange: #11 in for #10 at V
// 11 point away: side-out, away rotates                  2:2
// 12 point away (away served: no rotation)               2:3
const ENTRIES = [
  [1, 'coin_toss', {}],
  [2, 'lineup', { team: 'home', lineup: lineupOf([1, 2, 3, 4, 5, 6]), isInitial: true }],
  [3, 'lineup', { team: 'away', lineup: lineupOf([21, 22, 23, 24, 25, 26]), isInitial: true }],
  [4, 'set_start', {}],
  [5, 'point', { team: 'home', score: { home: 1, away: 0 } }],
  [6, 'substitution', { team: 'home', position: 'III', playerOut: '3', playerIn: 7, isExceptional: false }],
  [7, 'libero_entry', { team: 'home', position: 'VI', playerOut: '6', liberoIn: 10, liberoType: 'libero1' }],
  [8, 'point', { team: 'away', score: { home: 1, away: 1 } }],
  [9, 'point', { team: 'home', score: { home: 2, away: 1 } }],
  [10, 'libero_exchange', { team: 'home', position: 'V', liberoOut: 10, liberoIn: 11, liberoOutType: 'libero1', liberoInType: 'libero2', playerNumber: '6' }],
  [11, 'point', { team: 'away', score: { home: 2, away: 2 } }],
  [12, 'point', { team: 'away', score: { home: 2, away: 3 } }]
]
// The sub-rows the scoring device wrote with them (as the scoreboard writes them)
const SUB_ROWS = [
  [6.1, { team: 'home', lineup: lineupOf([1, 2, 7, 4, 5, 6]), fromSubstitution: true }],
  [7.1, { team: 'home', lineup: lineupOf([1, 2, 7, 4, 5, 10]), liberoSubstitution: { position: 'VI', liberoNumber: 10, playerNumber: '6', liberoType: 'libero1' } }],
  [8.1, { team: 'away', lineup: lineupOf([22, 23, 24, 25, 26, 21]), liberoSubstitution: null }],
  [9.1, { team: 'home', lineup: lineupOf([2, 7, 4, 5, 10, 1]), liberoSubstitution: { position: 'V', liberoNumber: 10, playerNumber: '6', liberoType: 'libero1' } }],
  [10.1, { team: 'home', lineup: lineupOf([2, 7, 4, 5, 11, 1]), liberoSubstitution: { position: 'V', liberoNumber: 11, playerNumber: '6', liberoType: 'libero2' } }],
  [11.1, { team: 'away', lineup: lineupOf([23, 24, 25, 26, 21, 22]), liberoSubstitution: null }]
]
const HOME_NOW = lineupOf([2, 7, 4, 5, 11, 1])
const AWAY_NOW = lineupOf([23, 24, 25, 26, 21, 22])

const ts = (seq) => new Date(Date.parse('2026-11-12T18:00:00Z') + Math.round(seq * 10) * 1000).toISOString()

function serverAnswer({ withSubRows = false, events = null } = {}) {
  let id = 100
  const rows = ENTRIES.map(([seq, type, payload]) => ({ external_id: `${seed}:e:${++id}`, seq, set_index: 1, type, payload, ts: ts(seq), created_at: ts(seq) }))
  if (withSubRows) {
    for (const [seq, payload] of SUB_ROWS) rows.push({ external_id: `${seed}:e:${++id}`, seq, set_index: 1, type: 'lineup', payload, ts: ts(seq), created_at: ts(seq) })
    rows.sort((a, b) => a.seq - b.seq)
  }
  return {
    data: {
      match: {
        id: '11111111-1111-4111-8111-111111111111', external_id: seed, game_n: 4242, status: 'live', test: false, sport_type: 'indoor',
        home_team: { name: 'Home VC', short_name: 'HOM' }, away_team: { name: 'Away VC', short_name: 'AWY' },
        players_home: [1, 2, 3, 4, 5, 6, 7, 10, 11].map(n => ({ number: n, first_name: 'X', last_name: `H${n}`, libero: n === 10 ? 'libero1' : n === 11 ? 'libero2' : '' })),
        players_away: [21, 22, 23, 24, 25, 26, 27].map(n => ({ number: n, first_name: 'X', last_name: `A${n}`, libero: '' })),
        coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home' },
        match_info: { best_of: 5 }, set_results: []
      },
      sets: [{ external_id: `${seed}:s:7`, index: 1, home_points: 2, away_points: 3, finished: false, start_time: ts(4) }],
      events: events || rows,
      // the live row is right, but is not where the line-ups are read from
      liveState: { current_set: 1, points_a: 2, points_b: 3, lineup_a: rich([2, 7, 4, 5, 11, 1]), lineup_b: rich([23, 24, 25, 26, 21, 22]), updated_at: ts(12) }
    },
    error: null
  }
}

// What the scoreboard shows: the last line-up row of the team in the set
// (Scoreboard getTeamLineupState)
const current = (events, team) => events
  .filter(e => e.type === 'lineup' && e.payload?.team === team && e.setIndex === 1)
  .sort((a, b) => a.seq - b.seq).pop()?.payload

async function continueOnFreshDevice() {
  const cloud = await fetchMatchByPin('123456', 4242)
  const id = await importMatchFromSupabase(cloud)
  return { id, events: await db.events.where('matchId').equals(id).toArray() }
}

const lineupJobs = async () => (await db.sync_queue.toArray())
  .filter(j => j.resource === 'event' && j.action === 'insert' && j.payload?.type === 'lineup')

describe('importMatchFromSupabase: the line-up of the set in progress', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
  })

  it('a log from a version that never sent the line-up sub-rows: the line-ups follow from its entries', async () => {
    byPin.result = serverAnswer()
    const { events } = await continueOnFreshDevice()

    const home = current(events, 'home')
    const away = current(events, 'away')
    expect(asText(home.lineup)).toEqual(HOME_NOW) // #7 in for #3, libero #11 on court, rotated once
    expect(home.liberoSubstitution).toMatchObject({ position: 'V', playerNumber: '6' })
    expect(String(home.liberoSubstitution.liberoNumber)).toBe('11')
    expect(asText(away.lineup)).toEqual(AWAY_NOW) // rotated twice: #23 serves next
    // each one where the scoring device had it
    const rebuilt = events.filter(e => e.type === 'lineup' && !Number.isInteger(e.seq)).sort((a, b) => a.seq - b.seq)
    expect(rebuilt.map(e => e.seq)).toEqual(SUB_ROWS.map(([seq]) => seq))
    for (const [i, [, payload]] of SUB_ROWS.entries()) {
      expect(rebuilt[i].payload.team).toBe(payload.team)
      expect(asText(rebuilt[i].payload.lineup)).toEqual(payload.lineup)
    }

    // and sent, so the server's log has them for the next device
    const jobs = await lineupJobs()
    expect(jobs.map(j => j.payload.seq).sort((a, b) => a - b)).toEqual(SUB_ROWS.map(([seq]) => seq))
    expect(jobs.every(j => j.payload.match_id === seed && j.status === 'queued')).toBe(true)
    expect(jobs.map(j => j.payload.external_id).sort()).toEqual(rebuilt.map(e => `${seed}:e:${e.id}`).sort())
  })

  it('a log that has the sub-rows is imported as it is', async () => {
    byPin.result = serverAnswer({ withSubRows: true })
    const { events } = await continueOnFreshDevice()

    expect(events.filter(e => e.type === 'lineup')).toHaveLength(2 + SUB_ROWS.length)
    expect(events.every(e => e.externalId != null)).toBe(true)
    expect(asText(current(events, 'home').lineup)).toEqual(HOME_NOW)
    expect(asText(current(events, 'away').lineup)).toEqual(AWAY_NOW)
    expect(await lineupJobs()).toHaveLength(0)
  })

  it('line-ups made up from the latest rally (no line-up row on the server) are not rotated again', async () => {
    // A log without any line-up row: fetchMatchByPin takes the line-ups the
    // last rally carried (the current ones) as the set's starting line-ups
    const rows = ENTRIES.filter(([, type]) => type !== 'lineup').map(([seq, type, payload], i) => ({
      external_id: `${seed}:e:${201 + i}`, seq, set_index: 1, type, payload, ts: ts(seq), created_at: ts(seq),
      ...(seq === 12 ? { lineup_left: rich([2, 7, 4, 5, 11, 1]), lineup_right: { ...rich([23, 24, 25, 26, 21, 22]), I: { number: 23, isServing: true } }, serve_team: 'away' } : {})
    }))
    byPin.result = serverAnswer({ events: rows })
    const { events } = await continueOnFreshDevice()

    expect(events.filter(e => e.type === 'lineup')).toHaveLength(2)
    expect(asText(current(events, 'home').lineup)).toEqual(HOME_NOW)
    expect(asText(current(events, 'away').lineup)).toEqual(AWAY_NOW)
    expect(await lineupJobs()).toHaveLength(0)
  })
})
