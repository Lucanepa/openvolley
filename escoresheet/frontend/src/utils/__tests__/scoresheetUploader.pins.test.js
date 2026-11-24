import { describe, it, expect } from 'vitest'
import { scoresheetJsonBlob, scoresheetMatch } from '../scoresheetUploader'

describe('scoresheet JSON file', () => {
  const match = {
    seed_key: 'match_1', gameN: 12, homeName: 'Home VC',
    gamePin: '123456', refereePin: '234567', homeTeamPin: '345678', awayTeamPin: '456789',
    homeTeamUploadPin: '567890', awayTeamUploadPin: '678901', connection_pins: { referee: '234567' },
    sessionId: 's1', cloudBlock: { reason: 'x' },
    officials: [{ role: '1st referee', lastName: 'Muster', email: 'ref@example.ch', phone: '+41 00 000 00 00' }]
  }

  it('carries no PIN, session or officials\' contact data', async () => {
    const text = await scoresheetJsonBlob({ match, homeTeam: {}, awayTeam: {}, homePlayers: [], awayPlayers: [], sets: [], events: [] }).text()
    for (const secret of ['123456', '234567', '345678', '456789', '567890', '678901', 'ref@example.ch', '+41 00', 'sessionId', 'cloudBlock']) {
      expect(text.includes(secret), secret).toBe(false)
    }
    const kept = scoresheetMatch(match)
    expect(kept.seed_key).toBe('match_1')
    expect(kept.gameN).toBe(12)
    expect(kept.officials[0]).toEqual({ role: '1st referee', lastName: 'Muster' })
    expect(match.gamePin).toBe('123456')
  })
})
