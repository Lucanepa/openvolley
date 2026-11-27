// Roster import's way (Remote · PDF · Photo): the one the scorer chose last is
// kept on the device (never lost to a blocked storage), and a team opens with
// it when the match offers it; else Remote for an official game, else PDF.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ROSTER_IMPORT_MODE_KEY, readRosterImportMode, saveRosterImportMode, rosterImportModeFor } from '../rosterImportMode'

beforeEach(() => localStorage.removeItem(ROSTER_IMPORT_MODE_KEY))
afterEach(() => vi.restoreAllMocks())

describe('the roster import way kept on the device', () => {
  it('reads back what was saved; nothing or something unknown is null', () => {
    expect(readRosterImportMode()).toBeNull()
    saveRosterImportMode('photo')
    expect(readRosterImportMode()).toBe('photo')
    saveRosterImportMode('local') // not a way: ignored
    expect(readRosterImportMode()).toBe('photo')
    localStorage.setItem(ROSTER_IMPORT_MODE_KEY, 'fax')
    expect(readRosterImportMode()).toBeNull()
  })

  it('a blocked storage throws nothing', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => saveRosterImportMode('pdf')).not.toThrow()
    expect(readRosterImportMode()).toBeNull()
  })
})

describe('the way a team opens with', () => {
  it('nothing kept: Remote for an official game, PDF otherwise', () => {
    expect(rosterImportModeFor({ remoteOffered: true, officialGame: true })).toBe('remote')
    expect(rosterImportModeFor({ remoteOffered: true, officialGame: false })).toBe('pdf')
    // a guest match has no Remote
    expect(rosterImportModeFor({ remoteOffered: false, officialGame: true })).toBe('pdf')
  })

  it('the kept way wins when the match offers it', () => {
    expect(rosterImportModeFor({ remembered: 'photo', remoteOffered: true, officialGame: true })).toBe('photo')
    expect(rosterImportModeFor({ remembered: 'pdf', remoteOffered: true, officialGame: true })).toBe('pdf')
    expect(rosterImportModeFor({ remembered: 'remote', remoteOffered: true, officialGame: false })).toBe('remote')
    // Remote kept, a guest match: PDF
    expect(rosterImportModeFor({ remembered: 'remote', remoteOffered: false, officialGame: false })).toBe('pdf')
  })
})
