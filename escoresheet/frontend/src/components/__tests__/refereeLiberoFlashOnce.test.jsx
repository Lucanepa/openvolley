// The referee court: a libero replacement flashes once, a substitution as before
// ("do not highlight the libero switch like a sub, one flash is enough",
// owner 15.11.2026).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import PlayerDisc from '../referee/PlayerDisc.jsx'
import {
  SUB_FLASH_MS, LIBERO_FLASH_MS, LIBERO_EVENT_TYPES,
  discFlashOf, withoutLiberoFlashes, liberoFlashKey
} from '../referee/discFlash.js'

const disc = (props) => render(
  <PlayerDisc number={7} position="I" capPx={80} side="left" background="#fdba74" color="#000" {...props} />
).container.querySelector('[data-player-disc="I"]')

describe('referee disc flash', () => {
  it('a substitution pulses until it is cleared, a libero replacement pulses once (about 1 s)', () => {
    expect(disc({ flash: true }).style.animation).toBe('recentSubFlash 0.5s ease-in-out infinite')
    const once = disc({ flash: 'once' }).style.animation
    expect(once).toBe(`recentSubFlash ${LIBERO_FLASH_MS}ms ease-in-out 1`)
    expect(once).not.toMatch(/infinite/)
    expect(disc({ flash: false }).style.animation).toBe('')
    expect(LIBERO_FLASH_MS).toBeGreaterThanOrEqual(500)
    expect(LIBERO_FLASH_MS).toBeLessThanOrEqual(1500)
    expect(SUB_FLASH_MS).toBe(5000)
  })

  it('tells a substitution from a libero entry for a disc; a substitution wins', () => {
    const list = [
      { team: 'home', playerNumber: 7, kind: 'sub' },
      { team: 'away', playerNumber: '10', kind: 'libero' }
    ]
    expect(discFlashOf(list, 'home', '7')).toBe(true)
    expect(discFlashOf(list, 'away', 10)).toBe('once')
    expect(discFlashOf(list, 'home', 10)).toBe(false)
    expect(discFlashOf([...list, { team: 'away', playerNumber: 10, kind: 'sub' }], 'away', 10)).toBe(true)
    // an entry without a kind (as before) is a substitution
    expect(discFlashOf([{ team: 'home', playerNumber: 3 }], 'home', 3)).toBe(true)
  })

  it('the libero pulse ends on its own and leaves the substitutions flashing', () => {
    const list = [
      { team: 'home', playerNumber: 7, kind: 'sub' },
      { team: 'home', playerNumber: 10, kind: 'libero' }
    ]
    expect(withoutLiberoFlashes(list)).toEqual([{ team: 'home', playerNumber: 7, kind: 'sub' }])
  })

  it('one live-state row event flashes once: the same event read again gives the same key', () => {
    const row = { last_event_type: 'libero_entry', last_event_team: 'home', last_event_data: { liberoNumber: 10 }, last_event_ts: '2026-11-15T10:00:00Z', updated_at: 'a' }
    const key = liberoFlashKey(row)
    expect(key).toBeTruthy()
    expect(liberoFlashKey({ ...row, updated_at: 'b', points_a: 3 })).toBe(key)
    // the next replacement is a new event
    expect(liberoFlashKey({ ...row, last_event_type: 'libero_exit', last_event_ts: '2026-11-15T10:01:00Z' })).not.toBe(key)
    expect(liberoFlashKey({ ...row, last_event_ts: '2026-11-15T10:05:00Z' })).not.toBe(key)
    for (const type of LIBERO_EVENT_TYPES) expect(liberoFlashKey({ ...row, last_event_type: type })).toBeTruthy()
    expect(liberoFlashKey({ ...row, last_event_type: 'substitution' })).toBeNull()
    expect(liberoFlashKey({ ...row, last_event_data: {} })).toBeNull()
  })

  it('Referee wires it: libero events take the short pulse, substitutions keep theirs', () => {
    const src = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')
    expect(src).toMatch(/kind: 'libero'/)
    expect(src).toMatch(/setTimeout\(\(\) => setRecentlySubstitutedPlayers\(withoutLiberoFlashes\), LIBERO_FLASH_MS\)/)
    expect(src).toMatch(/flash=\{discFlash\}/)
    // both substitution paths still flash the player in for SUB_FLASH_MS
    expect(src.match(/kind: 'sub' \}/g)?.length).toBe(2)
    expect(src.match(/setRecentlySubstitutedPlayers\(\[\]\)(, SUB_FLASH_MS| *\n *\}, SUB_FLASH_MS)/g)?.length).toBe(2)
  })
})
