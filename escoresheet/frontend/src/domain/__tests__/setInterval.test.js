// The 10-minute interval after set 2, per match (owner 2026-11-17)
import { describe, it, expect } from 'vitest'
import {
  INTERVAL_MINUTES, LONG_INTERVAL_MINUTES, breakSecondsAfter, endedSetBefore,
  hasLongIntervalAfterSet2, intervalMinutesAfter, isLongInterval, longIntervalChanged
} from '../setInterval'
import { defaultSetStartTime } from '../../utils/setStartTime'
import { sheetInputsToMatchInfo, sheetInputsFromMatchInfo } from '../sheetInputs'
import { matchInfoFromLocal, localFromMatchInfo } from '../../db/matchRepository'
import { planSetTimes } from '../manualCorrections'
import SHARED from '../../../shared/relayPrivateFields.json'
import * as backendColumns from '../../../../backend/lib/publicColumns.js'

const at = (iso) => new Date(iso)
const ON = { longIntervalAfterSet2: true }
const OFF = { longIntervalAfterSet2: false }

describe('the interval rule', () => {
  it('10 minutes only after set 2 of a match with the switch on', () => {
    expect(INTERVAL_MINUTES).toBe(3)
    expect(LONG_INTERVAL_MINUTES).toBe(10)
    expect(intervalMinutesAfter(ON, 2)).toBe(10)
    for (const ended of [1, 3, 4]) expect(intervalMinutesAfter(ON, ended)).toBe(3)
    for (const ended of [1, 2, 3, 4]) expect(intervalMinutesAfter(OFF, ended)).toBe(3)
    expect(intervalMinutesAfter({}, 2)).toBe(3)
    expect(intervalMinutesAfter(null, 2)).toBe(3)
    // only a real true counts (an old row, a string)
    expect(hasLongIntervalAfterSet2({ longIntervalAfterSet2: 'true' })).toBe(false)
    expect(isLongInterval(ON, '2')).toBe(true)
  })

  it('countdown: 600 s after set 2 when on, else the device setting', () => {
    expect(breakSecondsAfter(ON, 2, 180)).toBe(600)
    expect(breakSecondsAfter(ON, 2, 240)).toBe(600)
    expect(breakSecondsAfter(ON, 1, 240)).toBe(240)
    expect(breakSecondsAfter(ON, 3, 120)).toBe(120)
    expect(breakSecondsAfter(ON, 4, 180)).toBe(180)
    expect(breakSecondsAfter(OFF, 2, 240)).toBe(240)
    expect(breakSecondsAfter(undefined, 2, 180)).toBe(180)
    // a broken device value: 3 minutes
    expect(breakSecondsAfter(OFF, 2, NaN)).toBe(180)
    expect(breakSecondsAfter(OFF, 2, 0)).toBe(180)
  })

  it('the set a break follows: the set played before (best-of-3 decider: set 2)', () => {
    expect(endedSetBefore(3, [{ index: 1 }, { index: 2 }, { index: 3 }])).toBe(2)
    expect(endedSetBefore(5, [{ index: 1 }, { index: 2 }, { index: 5 }])).toBe(2)
    expect(endedSetBefore(5, [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 5 }])).toBe(4)
    // no sets on the tablet: the set the push named, else the one before by number
    expect(endedSetBefore(5, [], 2)).toBe(2)
    expect(endedSetBefore(3, [])).toBe(2)
    expect(endedSetBefore(1, [])).toBe(null)
    expect(breakSecondsAfter(ON, endedSetBefore(5, [{ index: 1 }, { index: 2 }, { index: 5 }]), 180)).toBe(600)
  })

  it('an edit that switches it is a change; the same value is not', () => {
    expect(longIntervalChanged({}, ON)).toBe(true)
    expect(longIntervalChanged(ON, OFF)).toBe(true)
    expect(longIntervalChanged(OFF, {})).toBe(false)
    expect(longIntervalChanged(ON, { ...ON, hall: 'x' })).toBe(false)
  })
})

describe('the proposed start of the set after set 2', () => {
  const bo5 = [
    { index: 1, endTime: '2026-11-17T18:25:30Z' },
    { index: 2, endTime: '2026-11-17T18:52:10Z' },
    { index: 3, endTime: '2026-11-17T19:30:40Z' },
    { index: 4, endTime: '2026-11-17T20:01:00Z' },
    { index: 5 }
  ]
  const now = at('2026-11-17T21:00:00Z')

  it('set 3: set 2 end + 10 with the switch on, + 3 without', () => {
    expect(defaultSetStartTime({ setIndex: 3, sets: bo5, now, longIntervalAfterSet2: true })).toBe('2026-11-17T19:02:00.000Z')
    expect(defaultSetStartTime({ setIndex: 3, sets: bo5, now, longIntervalAfterSet2: false })).toBe('2026-11-17T18:55:00.000Z')
    expect(defaultSetStartTime({ setIndex: 3, sets: bo5, now })).toBe('2026-11-17T18:55:00.000Z')
  })

  it('sets 2, 4 and 5 stay + 3 with the switch on', () => {
    expect(defaultSetStartTime({ setIndex: 2, sets: bo5, now, longIntervalAfterSet2: true })).toBe('2026-11-17T18:28:00.000Z')
    expect(defaultSetStartTime({ setIndex: 4, sets: bo5, now, longIntervalAfterSet2: true })).toBe('2026-11-17T19:33:00.000Z')
    expect(defaultSetStartTime({ setIndex: 5, sets: bo5, now, longIntervalAfterSet2: true })).toBe('2026-11-17T20:04:00.000Z')
  })

  it('a best-of-3 decider (set 5 after set 2) gets the 10 minutes', () => {
    const bo3 = [{ index: 1, endTime: '2026-11-17T18:25:00Z' }, { index: 2, endTime: '2026-11-17T18:50:00Z' }, { index: 5 }]
    expect(defaultSetStartTime({ setIndex: 5, sets: bo3, now, longIntervalAfterSet2: true })).toBe('2026-11-17T19:00:00.000Z')
    expect(defaultSetStartTime({ setIndex: 5, sets: bo3, now, longIntervalAfterSet2: false })).toBe('2026-11-17T18:53:00.000Z')
  })

  it('set 1 is still the scheduled time (the switch changes nothing there)', () => {
    const sets = [{ index: 1 }]
    expect(defaultSetStartTime({ setIndex: 1, sets, now: at('2026-11-17T18:30:00Z'), scheduledAt: '2026-11-17T19:00:00Z', longIntervalAfterSet2: true }))
      .toBe(defaultSetStartTime({ setIndex: 1, sets, now: at('2026-11-17T18:30:00Z'), scheduledAt: '2026-11-17T19:00:00Z' }))
  })
})

describe('delayed start remark in corrections', () => {
  const sets = [
    { index: 1, startTime: '2026-11-17T18:00:00Z', endTime: '2026-11-17T18:25:00Z' },
    { index: 2, startTime: '2026-11-17T18:28:00Z', endTime: '2026-11-17T18:50:00Z' },
    { index: 3, startTime: '2026-11-17T19:00:00Z', endTime: '2026-11-17T19:25:00Z' }
  ]
  it('set 3 at set 2 end + 10 is no delay with the switch on, a delay without', () => {
    const args = { setIndex: 3, startTime: '2026-11-17T19:00:00Z' }
    expect(planSetTimes([], sets, { ...args, longIntervalAfterSet2: true }).suggestedRemark).toBeFalsy()
    expect(planSetTimes([], sets, args).suggestedRemark).toBeTruthy()
    // over 12 minutes: a delay all the same
    expect(planSetTimes([], sets, { setIndex: 3, startTime: '2026-11-17T19:03:00Z', longIntervalAfterSet2: true }).suggestedRemark).toBeTruthy()
  })
})

describe('sync: the switch travels like the other match fields', () => {
  it('match_info carries long_interval_after_set2, a false too', () => {
    expect(sheetInputsToMatchInfo(ON)).toMatchObject({ long_interval_after_set2: true })
    expect(sheetInputsToMatchInfo(OFF)).toMatchObject({ long_interval_after_set2: false })
    expect(sheetInputsToMatchInfo({})).not.toHaveProperty('long_interval_after_set2')
    expect(sheetInputsFromMatchInfo({ long_interval_after_set2: true })).toMatchObject(ON)
    expect(sheetInputsFromMatchInfo({ long_interval_after_set2: false })).toMatchObject(OFF)
    expect(sheetInputsFromMatchInfo({ long_interval_after_set2: 'yes' })).not.toHaveProperty('longIntervalAfterSet2')
  })

  it('round trip through the cloud match_info (save, restore, take over)', () => {
    const info = matchInfoFromLocal({ hall: 'Halle', bestOf: 5, longIntervalAfterSet2: true })
    expect(info).toMatchObject({ hall: 'Halle', long_interval_after_set2: true })
    expect(localFromMatchInfo(info)).toMatchObject({ longIntervalAfterSet2: true })
    expect(localFromMatchInfo(matchInfoFromLocal({ longIntervalAfterSet2: false }))).toMatchObject({ longIntervalAfterSet2: false })
  })

  it('the LAN relay and the backend let the referee / bench tablets see it', () => {
    expect(SHARED.publicMatchFields).toContain('longIntervalAfterSet2')
    const row = { match_info: { hall: 'Halle', long_interval_after_set2: true, secret: 'x' } }
    expect(backendColumns.projectRow(backendColumns.LIVE_COLUMNS, 'matches', row).match_info)
      .toEqual({ hall: 'Halle', long_interval_after_set2: true })
    expect(backendColumns.projectAnonDbRows('matches', [row])[0].match_info)
      .toMatchObject({ long_interval_after_set2: true })
  })
})
