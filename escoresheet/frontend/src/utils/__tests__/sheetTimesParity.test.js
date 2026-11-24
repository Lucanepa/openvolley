// The server's public API prints the set minutes of the scoresheet (owner
// 2026-11-16): backend/lib/sheetTimes.js is a byte-for-byte copy of
// src/domain/sheetTimes.js, and buildStats' minutes equal the sheet's for the
// same server record (as Rebuild PDF draws it).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { scoresheetDataFromCloud } from '../scoresheetFromCloud'
import { setDurationMinutes, setStartMs, setEndMs } from '../../../scoresheet_pdf/utils/matchTimes'
import { buildStats } from '../../../../backend/lib/publicApi.js'

const at = (min, sec = 0) => new Date(Date.parse('2026-11-15T14:00:00Z') + (min * 60 + sec) * 1000).toISOString()

function record() {
  let seq = 0
  const events = []
  const push = (set_index, type, payload, ts) => events.push({ external_id: `m:e:${++seq}`, seq, set_index, type, payload, ts })
  const sets = []
  // set 1: the row still holds its creation time (the coin toss, earlier than
  // the confirmed start); set 2: corrected after the match; set 3: plain
  const plan = [[1, 25, 20, 15, at(10)], [2, 20, 25, 40, at(38)], [3, 15, 13, 65, at(65)]]
  for (const [index, h, a, startMin, rowStart] of plan) {
    push(index, 'set_start', { startTime: at(startMin) }, at(startMin))
    let hh = 0, aa = 0, k = 0
    while (hh < h || aa < a) {
      const team = (hh < h && (aa >= a || (hh + aa) % 3 !== 0)) ? 'home' : 'away'
      if (team === 'home') hh++; else aa++
      push(index, 'point', { team }, at(startMin, 37 * ++k))
    }
    push(index, 'set_end', { team: hh > aa ? 'home' : 'away' }, at(startMin, 37 * k + 20))
    sets.push({ external_id: `m:s:${index}`, index, home_points: h, away_points: a, finished: true, start_time: rowStart, end_time: at(startMin, 37 * k + 20) })
  }
  return {
    match: {
      id: '1', external_id: 'm', status: 'final', sport_type: 'indoor', home_team: { name: 'H' }, away_team: { name: 'A' },
      match_info: { best_of: 3 }, players_home: [], players_away: [],
      manual_changes: [{ afterMatch: true, action: 'setTimes', setIndex: 2, after: { startTime: at(38) } }]
    },
    sets,
    events
  }
}

describe('public API set minutes = the sheet\'s', () => {
  it('backend/lib/sheetTimes.js is the same file', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/domain/sheetTimes.js'), 'utf8')
    const server = readFileSync(resolve(process.cwd(), '../backend/lib/sheetTimes.js'), 'utf8')
    expect(server).toBe(app)
  })
  it('the same start, end and minutes for every set', () => {
    const r = record()
    const sheet = scoresheetDataFromCloud(r)
    const stats = buildStats(r.match, r.events, r.sets)
    expect(stats.sets.length).toBe(3)
    for (const s of stats.sets) {
      const set = sheet.sets.find(x => x.index === s.set)
      expect(s.minutes).toBe(setDurationMinutes(set, sheet.events))
      expect(Date.parse(s.startedAt)).toBe(setStartMs(set, sheet.events))
      expect(Date.parse(s.endedAt)).toBe(setEndMs(set, sheet.events))
    }
    // set 1: the confirmed 14:15 (not the row's 14:10); set 2: the corrected 14:38
    expect(stats.sets[0].startedAt).toBe('2026-11-15T14:15:00.000Z')
    expect(stats.sets[1].startedAt).toBe('2026-11-15T14:38:00.000Z')
  })
})
