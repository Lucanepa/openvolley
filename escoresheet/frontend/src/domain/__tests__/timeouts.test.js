import { describe, it, expect } from 'vitest'
import { classifyTimeoutRequest, TIMEOUTS_PER_SET } from '../timeouts'

let seq = 0
const ev = (type, payload = {}, setIndex = 1) => ({ type, payload, setIndex, seq: ++seq })

describe('classifyTimeoutRequest', () => {
  it('two time-outs per set (no technical time-outs)', () => {
    expect(TIMEOUTS_PER_SET).toBe(2)
  })

  it('first time-out of the set', () => {
    const events = [ev('rally_start'), ev('point', { team: 'home' })]
    expect(classifyTimeoutRequest(events, 1, 'home')).toEqual({ used: 0, ordinal: 1, consecutive: false, improper: false })
  })

  it('second time-out with a rally in between is a plain second time-out', () => {
    const events = [ev('timeout', { team: 'home' }), ev('rally_start'), ev('point', { team: 'away' })]
    expect(classifyTimeoutRequest(events, 1, 'home')).toEqual({ used: 1, ordinal: 2, consecutive: false, improper: false })
  })

  it('second time-out in the same interruption (no rally since) is consecutive', () => {
    const events = [ev('point', { team: 'away' }), ev('timeout', { team: 'home' })]
    expect(classifyTimeoutRequest(events, 1, 'home')).toMatchObject({ ordinal: 2, consecutive: true })
  })

  it('the opponent\'s time-out, a substitution or a sanction does not end the interruption', () => {
    const events = [
      ev('timeout', { team: 'home' }),
      ev('timeout', { team: 'away' }),
      ev('substitution', { team: 'home' }),
      ev('sanction', { team: 'away', type: 'delay_warning' })
    ]
    expect(classifyTimeoutRequest(events, 1, 'home')).toMatchObject({ ordinal: 2, consecutive: true })
  })

  it('a rally that was started and then replayed ends the interruption', () => {
    const events = [ev('timeout', { team: 'home' }), ev('rally_start'), ev('replay')]
    expect(classifyTimeoutRequest(events, 1, 'home')).toMatchObject({ ordinal: 2, consecutive: false })
  })

  it('a third request is improper', () => {
    const events = [ev('timeout', { team: 'away' }), ev('rally_start'), ev('point', { team: 'home' }), ev('timeout', { team: 'away' })]
    expect(classifyTimeoutRequest(events, 1, 'away')).toEqual({ used: 2, ordinal: 3, consecutive: false, improper: true })
  })

  it('only counts the current set and the requesting team', () => {
    const events = [
      ev('timeout', { team: 'home' }, 1), ev('timeout', { team: 'home' }, 1),
      ev('timeout', { team: 'away' }, 2)
    ]
    expect(classifyTimeoutRequest(events, 2, 'home')).toMatchObject({ used: 0, ordinal: 1, improper: false })
    expect(classifyTimeoutRequest(events, 2, 'away')).toMatchObject({ used: 1, ordinal: 2, consecutive: true })
  })

  it('copes with no events', () => {
    expect(classifyTimeoutRequest(undefined, 1, 'home')).toEqual({ used: 0, ordinal: 1, consecutive: false, improper: false })
  })
})
