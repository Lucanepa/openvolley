// One match, two renderers, one sheet (owner 2026-11-16: "make sure ALL
// scoresheet renderers use the same logic, so we don't have different
// scoresheets"). The server's record of a closed match drawn
//  - as the manager's Rebuild PDF draws it (scoresheetDataFromCloud, nothing
//    written to a device), and
//  - as a device that took the match over draws it (importMatchFromSupabase
//    into the real app database, then loadLocalMatchData, the scorer's own
//    sheet and the approval's PDF window),
// must print the same sheet, word for word.
import 'fake-indexeddb/auto'
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no network in this test') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: vi.fn(async () => null),
  apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })),
  writingDevice: () => ({ id: '00000000-0000-4000-8000-000000000001', platform: 'web' }),
  OV_PROTO: '2'
}))

import { db } from '../../db/db'
import { cloudDataFromServer, importMatchFromSupabase } from '../backupManager'
import { scoresheetDataFromCloud } from '../scoresheetFromCloud'
import { scoresheetInputFromBundle } from '../../components/referee/scoresheetInput'
import { loadLocalMatchData, normalizeMatchData } from '../../../scoresheet_pdf/utils/matchData'
import App from '../../../scoresheet_pdf/App_Scoresheet'

const seed = 'match_1792931096817_parity'
const at = (min, sec = 0) => new Date(Date.parse('2026-11-15T14:00:00Z') + (min * 60 + sec) * 1000).toISOString()
const POS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const lineupOf = (list) => Object.fromEntries(POS.map((p, i) => [p, String(list[i])]))

/** A best-of-3 match won 2:1 (deciding set 15:13, as set index 5), with a sanction, remarks and a correction. */
function serverRecord() {
  let seq = 0
  let id = 100
  const events = []
  const push = (setIndex, type, payload, ts) => events.push({ external_id: `${seed}:e:${++id}`, seq: ++seq, set_index: setIndex, type, payload, ts, created_at: ts })
  push(1, 'coin_toss', {}, at(10))
  const sets = []
  const plan = [[1, 25, 20, 15], [2, 20, 25, 40], [5, 15, 13, 65]]
  for (const [index, h, a, startMin] of plan) {
    push(index, 'lineup', { team: 'home', lineup: lineupOf([1, 2, 3, 4, 5, 6]), isInitial: true }, at(startMin - 1))
    push(index, 'lineup', { team: 'away', lineup: lineupOf([21, 22, 23, 24, 25, 26]), isInitial: true }, at(startMin - 1))
    push(index, 'set_start', { startTime: at(startMin) }, at(startMin))
    let hh = 0, aa = 0, k = 0
    while (hh < h || aa < a) {
      const team = (hh < h && (aa >= a || (hh + aa) % 3 !== 0)) ? 'home' : 'away'
      if (team === 'home') hh++; else aa++
      push(index, 'point', { team, score: { home: hh, away: aa } }, at(startMin, 30 * ++k))
      if (index === 1 && hh + aa === 5) push(1, 'sanction', { team: 'away', type: 'warning', playerNumber: 22, playerType: 'player' }, at(startMin, 30 * k + 5))
    }
    const end = at(startMin, 30 * k)
    push(index, 'set_end', { team: hh > aa ? 'home' : 'away' }, end)
    sets.push({ external_id: `${seed}:s:${index}`, index, home_points: h, away_points: a, finished: true, start_time: at(startMin), end_time: end })
  }
  return {
    match: {
      id: '11111111-1111-4111-8111-111111111111', external_id: seed, game_n: 424849, status: 'final', test: false, sport_type: 'indoor',
      scheduled_at: at(15), closed_at: at(95),
      home_team: { name: 'Home Volley Club', short_name: 'HOME' }, away_team: { name: 'Away Volley Club', short_name: 'AWAY' },
      players_home: [1, 2, 3, 4, 5, 6, 9].map(n => ({ number: n, first_name: 'Anna', last_name: `Home${n}`, dob: '2006-04-05', is_captain: n === 1, libero: n === 9 ? 'libero1' : '' })),
      players_away: [21, 22, 23, 24, 25, 26, 27].map(n => ({ number: n, first_name: 'Bea', last_name: `Away${n}`, dob: '2007-01-02', is_captain: n === 21, libero: n === 27 ? 'libero1' : '' })),
      coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home' },
      match_info: { best_of: 3, league: 'SM-Quali-U23', hall: 'Sporthalle Nord', city: 'Musterstadt', set5_left_team: 'B', set5_first_serve: 'B' },
      remarks: 'Late start: the hall was busy',
      manual_changes: [{ afterMatch: true, action: 'setTimes', setIndex: 2, text: 'Set 2 times corrected', after: { startTime: at(40) } }],
      set_results: []
    },
    sets,
    events,
    liveState: null
  }
}

const sheetText = (c) => (c.querySelector('.scoresheet-container')?.textContent || '').replace(/\s+/g, ' ').trim()

describe('every renderer prints the same sheet for the same match', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
  })
  afterEach(cleanup)

  it('Rebuild PDF (server record) and a device that took the match over (local database) print the same text', async () => {
    const record = serverRecord()
    const fromCloud = scoresheetDataFromCloud(record)

    const id = await importMatchFromSupabase(cloudDataFromServer({ match: record.match, sets: record.sets, events: record.events, liveState: null }))
    const fromDevice = await loadLocalMatchData(db, id)
    expect(fromDevice).not.toBeNull()

    // the same key values
    const key = (d) => ({
      sets: d.sets.map(s => [s.index, s.homePoints, s.awayPoints, s.finished, s.startTime, s.endTime]),
      events: d.events.filter(e => e.type !== 'lineup').map(e => [e.setIndex, e.type, e.seq]),
      home: d.homePlayers.map(p => [p.number, p.lastName, p.libero || '', !!p.isCaptain]).sort(),
      away: d.awayPlayers.map(p => [p.number, p.lastName, p.libero || '', !!p.isCaptain]).sort(),
      bestOf: d.match.bestOf, gameN: d.match.gameN, remarks: d.match.remarks
    })
    expect(key(fromDevice)).toEqual(key(fromCloud))

    const a = render(<App matchData={fromCloud} autoAction="preview" />)
    const cloudText = sheetText(a.container)
    a.unmount()
    const b = render(<App matchData={fromDevice} autoAction="preview" />)
    const deviceText = sheetText(b.container)
    expect(cloudText.length).toBeGreaterThan(500)
    expect(deviceText).toBe(cloudText)

    // the referee tablet: the scorer's database as the relay hands it out (a
    // finished match; the relay itself leaves out PINs, signatures, officials
    // and dates of birth, the sheet then shows those boxes empty)
    const bundle = { access: 'full', ...fromDevice }
    const c = render(<App matchData={scoresheetInputFromBundle(bundle)} autoAction="preview" />)
    expect(sheetText(c.container)).toBe(deviceText)
  })

  it('LFP tracking and the time zone come with the match, not from the drawing device (owner 2026-11-16)', async () => {
    const record = serverRecord()
    // the scorer tracked LFP, the match was created in New York (Global tool)
    record.match.match_info = { ...record.match.match_info, lfp_tracking: true, tz: 'America/New_York' }
    record.match.players_home = record.match.players_home.map(p => ({ ...p, is_lfp: p.number <= 3 }))
    // this device: LFP tracking off, the Swiss tool (Zürich clocks)
    localStorage.removeItem('lfpTrackingEnabled')
    const fromCloud = scoresheetDataFromCloud(record)
    expect(fromCloud.match.lfpTracking).toBe(true)
    expect(fromCloud.match.tz).toBe('America/New_York')
    const id = await importMatchFromSupabase(cloudDataFromServer({ match: record.match, sets: record.sets, events: record.events, liveState: null }))
    const fromDevice = await loadLocalMatchData(db, id)
    expect(fromDevice.match.lfpTracking).toBe(true)
    expect(fromDevice.match.tz).toBe('America/New_York')

    const texts = []
    for (const input of [fromCloud, fromDevice, scoresheetInputFromBundle({ access: 'full', ...fromDevice })]) {
      const r = render(<App matchData={input} autoAction="preview" />)
      texts.push(sheetText(r.container))
      r.unmount()
    }
    expect(texts[1]).toBe(texts[0])
    expect(texts[2]).toBe(texts[1])
    // the marks the scorer tracked, on a device whose own setting is off
    expect(texts[0]).toContain('LFP')
    // set 1 started 14:15 UTC: 09:15 on the match's (New York) clock, not Zürich's 15:15
    expect(texts[0]).toContain('09:15')
    expect(texts[0]).not.toContain('15:15')
  })

  it('the input is normalised the same way whatever its source: sets by index, events by seq, a missing seq last', () => {
    const d = normalizeMatchData({
      match: null,
      homeTeam: 'Plain Name',
      sets: [{ index: 2 }, null, { index: 1 }],
      events: [{ seq: 3, id: 'c' }, { id: 'nos' }, { seq: 1, id: 'a' }, { seq: 2.5, id: 'b' }]
    })
    expect(d.match).toEqual({})
    expect(d.homeTeam).toEqual({ name: 'Plain Name' })
    expect(d.awayTeam).toBeNull()
    expect(d.sets.map(s => s.index)).toEqual([1, 2])
    expect(d.events.map(e => e.id)).toEqual(['a', 'b', 'c', 'nos'])
    expect(d.sanctions).toEqual([])
  })
})
