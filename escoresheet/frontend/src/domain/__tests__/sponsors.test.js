import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getSponsorsOption, setSponsorsOption, SPONSORS_OPTION_EVENT, SPONSORS_OPTION_KEY,
  sponsorsOf, showsSponsorBoxes, withSponsorMark, teamNameWithSponsors, sponsorsPatch,
  sponsorsToMatchInfo, sponsorsFromMatchInfo
} from '../sponsors'

// Sponsors on clothing (owner 2026-11-15)
describe('sponsors on clothing', () => {
  beforeEach(() => localStorage.removeItem(SPONSORS_OPTION_KEY))

  it('the option: off by default, per device, the open screens are told', () => {
    expect(getSponsorsOption()).toBe(false)
    const heard = vi.fn()
    window.addEventListener(SPONSORS_OPTION_EVENT, heard)
    setSponsorsOption(true)
    expect(localStorage.getItem(SPONSORS_OPTION_KEY)).toBe('true')
    expect(getSponsorsOption()).toBe(true)
    setSponsorsOption(false)
    expect(getSponsorsOption()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
    window.removeEventListener(SPONSORS_OPTION_EVENT, heard)
  })

  it('the mark: (+) ticked, (-) not, nothing on an unmarked match or an empty name', () => {
    expect(withSponsorMark('VBC Nord', true, true)).toBe('VBC Nord (+)')
    expect(withSponsorMark('VBC Nord', false, true)).toBe('VBC Nord (-)')
    expect(withSponsorMark('VBC Nord', true, false)).toBe('VBC Nord')
    expect(withSponsorMark('', true, true)).toBe('')
    expect(withSponsorMark(undefined, false, true)).toBe('')
  })

  it('reads a local match and a server row (match_info) alike', () => {
    expect(sponsorsOf({ homeSponsors: true, sponsorsMarked: true })).toEqual({ marked: true, home: true, away: false })
    expect(sponsorsOf({ match_info: { sponsors_home: false, sponsors_away: true, sponsors_marked: true } }))
      .toEqual({ marked: true, home: false, away: true })
    expect(sponsorsOf(null)).toEqual({ marked: false, home: false, away: false })
    expect(teamNameWithSponsors({ awaySponsors: true, sponsorsMarked: true }, 'away', 'Süd')).toBe('Süd (+)')
    expect(teamNameWithSponsors({ awaySponsors: true, sponsorsMarked: true }, 'home', 'Nord')).toBe('Nord (-)')
  })

  it('a ticked box marks the match for good; unticking keeps it marked', () => {
    expect(sponsorsPatch({}, 'home', false)).toEqual({ homeSponsors: false })
    expect(sponsorsPatch({}, 'away', true)).toEqual({ awaySponsors: true, sponsorsMarked: true })
    expect(sponsorsPatch({ sponsorsMarked: true, awaySponsors: true }, 'away', false)).toEqual({ awaySponsors: false, sponsorsMarked: true })
  })

  it('the boxes: with the option on, or on a match already marked (the match decides)', () => {
    expect(showsSponsorBoxes(false, {})).toBe(false)
    expect(showsSponsorBoxes(true, {})).toBe(true)
    expect(showsSponsorBoxes(false, { sponsorsMarked: true })).toBe(true)
  })

  it('match_info both ways: every key out, only the present keys back', () => {
    expect(sponsorsToMatchInfo({ homeSponsors: true, sponsorsMarked: true }))
      .toEqual({ sponsors_home: true, sponsors_away: false, sponsors_marked: true })
    expect(sponsorsFromMatchInfo({ sponsors_home: true, sponsors_away: false, sponsors_marked: true }))
      .toEqual({ homeSponsors: true, awaySponsors: false, sponsorsMarked: true })
    expect(sponsorsFromMatchInfo({ hall: 'H', sponsors_home: 'yes' })).toEqual({})
    expect(sponsorsFromMatchInfo(null)).toEqual({})
  })
})
