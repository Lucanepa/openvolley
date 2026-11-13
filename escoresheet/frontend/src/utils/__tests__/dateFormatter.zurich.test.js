import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../../lib/apiClient', () => ({ apiFrom: () => ({}) }))

import { formatBackupDateTime, formatZurichDateTime } from '../dateFormatter'
import { toRosterUploadMatch } from '../rosterUploadMatches'

// A scorer laptop left on a fixed GMT+2 (the 2026-10-25 case), then one on UTC
const saved = process.env.TZ
afterAll(() => { process.env.TZ = saved })

describe('backup list and roster-upload list: Zürich time on any device zone', () => {
  beforeAll(() => { process.env.TZ = 'Etc/GMT-2' })

  it('a backup written at 14:30 gym time is listed at 14:30, not 15:30', () => {
    expect(new Date('2026-10-25T13:30:00Z').getHours()).toBe(15) // the device's own clock
    expect(formatBackupDateTime('20261025', '133000', '000')).toBe('25.10.2026, 14:30:00')
    // summer time: two hours ahead of UTC
    expect(formatBackupDateTime('20260704', '173005', '120')).toBe('04.07.2026, 19:30:05')
    expect(formatBackupDateTime('', '1')).toBe('Unknown')
  })

  it('the storage time of a backup without a stamp in its name is Zürich time too', () => {
    expect(formatZurichDateTime('2026-11-13T22:59:59.000Z')).toBe('13.11.2026, 23:59:59')
    expect(formatZurichDateTime('2026-11-13T23:00:00.000Z')).toBe('14.11.2026, 00:00:00')
    expect(formatZurichDateTime(null)).toBe('')
    expect(formatZurichDateTime('not a date')).toBe('')
  })

  it('a 00:30 game is listed under its own day, date and time from the same clock', () => {
    process.env.TZ = 'UTC'
    const row = { id: 'u1', external_id: 'm1', game_n: 5, status: 'setup', scheduled_at: '2026-10-05T22:30:00Z', home_team: { name: 'H' }, away_team: { name: 'A' } }
    expect(toRosterUploadMatch(row).dateTime).toBe('06.10.2026 00:30')
    expect(toRosterUploadMatch({ ...row, scheduled_at: '2026-10-05T18:00:00' }).dateTime).toBe('05.10.2026 20:00')
    expect(toRosterUploadMatch({ ...row, scheduled_at: null }).dateTime).toBe('TBD')
  })
})
