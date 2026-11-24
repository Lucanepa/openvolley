import { describe, it, expect } from 'vitest'
import { phonePairMatchOf } from '../phonePairStore'

describe('phonePairMatchOf', () => {
  it('takes the room key, the game PIN and the context the phone page shows', () => {
    const data = { match: { id: 3, seed_key: 'seed-1', gamePin: '123456', game_n: 4711 }, homeTeam: { name: 'VBC Musterau' }, awayTeam: { name: 'VC Beispielstadt' } }
    expect(phonePairMatchOf(data, { lang: 'de-CH' })).toEqual({
      matchId: 3, matchKey: 'seed-1', gamePin: '123456',
      context: { home: 'VBC Musterau', away: 'VC Beispielstadt', lang: 'de-CH', matchNo: '4711' },
    })
  })

  it('falls back to the side names, and nothing without a match', () => {
    expect(phonePairMatchOf({ match: { id: 1 } }, { fallbackHome: 'Home', fallbackAway: 'Away' }).context).toEqual({ home: 'Home', away: 'Away', lang: 'en' })
    expect(phonePairMatchOf(null)).toBeNull()
  })
})
