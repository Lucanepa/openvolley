import { describe, it, expect, afterEach } from 'vitest'
import { validTz, matchLfpTracking, sheetInputsToMatchInfo, sheetInputsFromMatchInfo } from '../sheetInputs'
import { matchInfoFromLocal, localFromMatchInfo } from '../../db/matchRepository'
import { currentTz, setMatchTz, getMatchTz, toolTz, zonedParts } from '../../ui/format.js'

// The match's own LFP tracking and time zone (owner 2026-11-16)
describe('domain/sheetInputs', () => {
  it('validTz accepts IANA zones only', () => {
    expect(validTz('Europe/Zurich')).toBe(true)
    expect(validTz('America/New_York')).toBe(true)
    expect(validTz('Mars/Olympus')).toBe(false)
    expect(validTz('')).toBe(false)
    expect(validTz(null)).toBe(false)
  })
  it('LFP: the match value wins, the device setting only for older matches, never in a Global match', () => {
    expect(matchLfpTracking({ lfpTracking: true }, false)).toBe(true)
    expect(matchLfpTracking({ lfpTracking: false }, true)).toBe(false)
    expect(matchLfpTracking({}, true)).toBe(true)
    expect(matchLfpTracking(null, false)).toBe(false)
    expect(matchLfpTracking({ global: true, lfpTracking: true }, true)).toBe(false)
  })
  it('travels in match_info and back (a false is kept; nothing set, nothing sent)', () => {
    expect(sheetInputsToMatchInfo({ lfpTracking: false, tz: 'Europe/Zurich' })).toEqual({ lfp_tracking: false, tz: 'Europe/Zurich' })
    expect(sheetInputsToMatchInfo({ tz: 'nope' })).toEqual({})
    expect(sheetInputsFromMatchInfo({ lfp_tracking: true, tz: 'Asia/Tokyo' })).toEqual({ lfpTracking: true, tz: 'Asia/Tokyo' })
    const info = matchInfoFromLocal({ hall: 'H', lfpTracking: true, tz: 'America/New_York' })
    expect(info.lfp_tracking).toBe(true)
    expect(info.tz).toBe('America/New_York')
    const local = localFromMatchInfo(info)
    expect(local.lfpTracking).toBe(true)
    expect(local.tz).toBe('America/New_York')
    expect(matchInfoFromLocal({ hall: 'H' })).not.toHaveProperty('lfp_tracking')
  })
  // owner 22.11.2026: technical remarks stay off the sheet of a match of this model
  it('the remarks model travels in match_info (remarks_model) and back; an older match has none', () => {
    expect(sheetInputsToMatchInfo({ remarksModel: 2 })).toEqual({ remarks_model: 2 })
    expect(sheetInputsToMatchInfo({ remarksModel: null })).toEqual({})
    expect(sheetInputsFromMatchInfo({ remarks_model: 2 })).toEqual({ remarksModel: 2 })
    expect(sheetInputsFromMatchInfo({ remarks_model: 'x' })).toEqual({})
    expect(localFromMatchInfo(matchInfoFromLocal({ hall: 'H', remarksModel: 2 })).remarksModel).toBe(2)
    expect(localFromMatchInfo(matchInfoFromLocal({ hall: 'H' }))).not.toHaveProperty('remarksModel')
  })
})

describe('ui/format: the match zone', () => {
  afterEach(() => setMatchTz(null))
  it('clocks read the match zone while set, the tool zone otherwise', () => {
    expect(currentTz()).toBe(toolTz())
    setMatchTz('America/New_York')
    expect(getMatchTz()).toBe('America/New_York')
    expect(currentTz()).toBe('America/New_York')
    // 14:15 UTC in November: 09:15 in New York
    expect(zonedParts('2026-11-15T14:15:00Z').hour).toBe(9)
    setMatchTz('Not/AZone')
    expect(getMatchTz()).toBeNull()
    expect(currentTz()).toBe(toolTz())
  })
})

describe('ui/useMatchTz', () => {
  it('nested views of one match keep its zone until the last one closes', async () => {
    const React = await import('react')
    const { render, cleanup } = await import('@testing-library/react')
    const { useMatchTz } = await import('../../ui/useMatchTz')
    const View = ({ tz, children }) => { useMatchTz(tz); return React.createElement('div', null, children ?? null) }
    const outer = render(React.createElement(View, { tz: 'America/New_York' }))
    expect(currentTz()).toBe('America/New_York')
    const inner = render(React.createElement(View, { tz: 'America/New_York' }))
    inner.unmount()
    expect(currentTz()).toBe('America/New_York')
    outer.unmount()
    expect(currentTz()).toBe(toolTz())
    cleanup()
  })
})
