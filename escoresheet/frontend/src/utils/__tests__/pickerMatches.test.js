import { describe, it, expect } from 'vitest'
import {
  PICKER_STALE,
  isStalePickerMatch,
  isShownCloudPickerRow,
  isBeachPickerRow,
  pickerTeamNames,
  pickerTime,
  pickerQuerySince,
  mergePickerMatches
} from '../pickerMatches'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const H = 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

describe('pickerTime', () => {
  it('reads ISO strings with and without zone (no zone is UTC), Postgres "+00", epoch ms and Dates', () => {
    expect(pickerTime('2026-10-07T12:00:00Z')).toBe(NOW)
    expect(pickerTime('2026-10-07T12:00:00')).toBe(NOW)
    expect(pickerTime('2026-10-07 12:00:00')).toBe(NOW)
    expect(pickerTime('2026-10-07 14:00:00+02')).toBe(NOW)
    expect(pickerTime('2026-10-07T14:00:00+02:00')).toBe(NOW)
    expect(pickerTime(NOW)).toBe(NOW)
    expect(pickerTime(new Date(NOW))).toBe(NOW)
  })

  it('anything else is null', () => {
    for (const v of [null, undefined, '', '  ', 'soon', NaN, {}, new Date('x')]) expect(pickerTime(v)).toBeNull()
  })
})

describe('isStalePickerMatch', () => {
  it('the abandoned February beach test match (live, never finished) is stale', () => {
    const row = { status: 'live', scheduled_at: '2026-06-15T14:00:00', updated_at: '2026-02-20T10:00:00+00:00' }
    expect(isStalePickerMatch(row, NOW)).toBe(true)
  })

  it('not started: stale once its scheduled time is more than 12 h ago', () => {
    expect(isStalePickerMatch({ status: 'setup', scheduled_at: iso(NOW - 11 * H) }, NOW)).toBe(false)
    expect(isStalePickerMatch({ status: 'setup', scheduled_at: iso(NOW - 13 * H) }, NOW)).toBe(true)
    // a recent write does not save it: it was due long ago
    expect(isStalePickerMatch({ status: 'setup', scheduled_at: iso(NOW - 13 * H), updated_at: iso(NOW - H) }, NOW)).toBe(true)
    // relay rows: 'scheduled', camelCase
    expect(isStalePickerMatch({ status: 'scheduled', scheduledAt: iso(NOW - 13 * H) }, NOW)).toBe(true)
    expect(isStalePickerMatch({ status: 'scheduled', scheduledAt: iso(NOW + 48 * H) }, NOW)).toBe(false)
  })

  it('started (live, or its coin toss confirmed): stale once not written for more than 6 h', () => {
    expect(isStalePickerMatch({ status: 'live', scheduled_at: iso(NOW - 48 * H), updated_at: iso(NOW - 5 * H) }, NOW)).toBe(false)
    expect(isStalePickerMatch({ status: 'live', updated_at: iso(NOW - 7 * H) }, NOW)).toBe(true)
    // coin toss done, status not yet live: judged as started, not by the schedule
    expect(isStalePickerMatch({ status: 'setup', coin_toss: { confirmed: true }, scheduled_at: iso(NOW - 14 * H), updated_at: iso(NOW - H) }, NOW)).toBe(false)
    expect(isStalePickerMatch({ status: 'setup', coin_toss: { confirmed: true }, updated_at: iso(NOW - 7 * H) }, NOW)).toBe(true)
  })

  it('a live relay row (no write time): stale once its scheduled time is more than 24 h ago', () => {
    // an old scorer app still publishing the June match it never finished
    expect(isStalePickerMatch({ status: 'live', homeTeam: 'Home', awayTeam: 'Away', scheduledAt: '2026-06-15T14:00:00.000Z' }, NOW)).toBe(true)
    expect(isStalePickerMatch({ status: 'live', scheduledAt: iso(NOW - 25 * H) }, NOW)).toBe(true)
    // started late, still going: shown
    expect(isStalePickerMatch({ status: 'live', scheduledAt: iso(NOW - 10 * H) }, NOW)).toBe(false)
    expect(isStalePickerMatch({ status: 'live', scheduledAt: iso(NOW - 23 * H) }, NOW)).toBe(false)
    // no time at all: shown (the relay drops a match whose scorer left)
    expect(isStalePickerMatch({ status: 'live' }, NOW)).toBe(false)
  })

  it('undated: stale once not written for more than 24 h; without a write time it stays', () => {
    expect(isStalePickerMatch({ status: 'setup', updated_at: iso(NOW - 23 * H) }, NOW)).toBe(false)
    expect(isStalePickerMatch({ status: 'setup', updated_at: iso(NOW - 25 * H) }, NOW)).toBe(true)
    expect(isStalePickerMatch({ status: 'scheduled' }, NOW)).toBe(false)
  })

  it('the limits', () => {
    expect(PICKER_STALE).toEqual({ scheduledPastMs: 12 * H, liveIdleMs: 6 * H, undatedIdleMs: 24 * H, liveScheduledPastMs: 24 * H })
    expect(isStalePickerMatch(null, NOW)).toBe(true)
  })
})

describe('cloud picker rows', () => {
  const fresh = { status: 'live', updated_at: iso(NOW - H), scheduled_at: iso(NOW - 2 * H) }

  it('indoor rows (sport_type indoor or NULL) that are not tests and not stale are shown', () => {
    expect(isShownCloudPickerRow({ ...fresh, sport_type: 'indoor' }, NOW)).toBe(true)
    expect(isShownCloudPickerRow({ ...fresh, sport_type: null }, NOW)).toBe(true)
    expect(isShownCloudPickerRow({ ...fresh }, NOW)).toBe(true)
  })

  it('beach, test and stale rows are not', () => {
    expect(isBeachPickerRow({ sport_type: 'Beach' })).toBe(true)
    expect(isShownCloudPickerRow({ ...fresh, sport_type: 'beach' }, NOW)).toBe(false)
    expect(isShownCloudPickerRow({ ...fresh, test: true }, NOW)).toBe(false)
    expect(isShownCloudPickerRow({ ...fresh, updated_at: iso(NOW - 7 * H) }, NOW)).toBe(false)
    expect(isShownCloudPickerRow(null, NOW)).toBe(false)
  })

  it('team names: home_team / away_team, then team1_data / team2_data, then Home / Away', () => {
    expect(pickerTeamNames({ home_team: { name: 'Volley A' }, away_team: { name: 'Volley B' }, team1_data: { name: 'x' } }))
      .toEqual({ home: 'Volley A', away: 'Volley B' })
    expect(pickerTeamNames({ home_team: { name: ' ' }, away_team: null, team1_data: { name: 'Muster / Beispiel' }, team2_data: { name: 'Rossi / Bianchi' } }))
      .toEqual({ home: 'Muster / Beispiel', away: 'Rossi / Bianchi' })
    expect(pickerTeamNames({})).toEqual({ home: 'Home', away: 'Away' })
    expect(pickerTeamNames(null)).toEqual({ home: 'Home', away: 'Away' })
  })

  it('the cloud asks only for rows written in the last 30 days', () => {
    expect(pickerQuerySince(NOW)).toBe('2026-09-07T12:00:00.000Z')
  })
})

describe('mergePickerMatches', () => {
  it('one row per match id, the relay\'s when both list it, each with its source', () => {
    const cloud = [
      { id: 'm_a', gameNumber: 1, homeTeam: 'cloud A', scheduledAt: '2026-10-07T18:00:00' },
      { id: 'm_b', gameNumber: 2, homeTeam: 'cloud B', scheduledAt: '2026-10-07T16:00:00' }
    ]
    const relay = [
      { id: 'm_a', gameNumber: 1, homeTeam: 'relay A', scheduledAt: '2026-10-07T18:00:00Z' },
      { id: 'm_c', gameNumber: 3, homeTeam: 'relay C', scheduledAt: null }
    ]
    const merged = mergePickerMatches(cloud, relay)
    expect(merged.map((m) => [m.id, m.homeTeam, m.listSource])).toEqual([
      ['m_b', 'cloud B', 'supabase'],
      ['m_a', 'relay A', 'websocket'],
      ['m_c', 'relay C', 'websocket']
    ])
  })

  it('numeric relay ids match the cloud\'s string ids', () => {
    const merged = mergePickerMatches([{ id: '991454', homeTeam: 'cloud' }], [{ id: 991454, homeTeam: 'relay' }])
    expect(merged).toHaveLength(1)
    expect(merged[0].homeTeam).toBe('relay')
  })

  it('takes anything without throwing', () => {
    expect(mergePickerMatches(null, undefined)).toEqual([])
    expect(mergePickerMatches([null, 1], 'x')).toEqual([])
  })
})
