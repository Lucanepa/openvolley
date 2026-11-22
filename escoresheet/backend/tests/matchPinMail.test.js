/**
 * lib/matchPinMail.js: the PIN of a send-pin request and the mail's text
 * (POST /api/match/send-pin; the route itself: matchSendPin.e2e.test.js).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pinFromBody, pinMailText, PIN_MAIL_SENTENCE } from '../lib/matchPinMail.js'

describe('pinFromBody', () => {
  it('takes 4 to 12 digits, as a string or a whole number', () => {
    assert.equal(pinFromBody('583920'), '583920')
    assert.equal(pinFromBody(' 583920 '), '583920')
    assert.equal(pinFromBody(583920), '583920')
    assert.equal(pinFromBody('0042'), '0042')
    assert.equal(pinFromBody('123456789012'), '123456789012')
  })

  it('refuses anything else, a stored hash included', () => {
    for (const v of [undefined, null, '', '123', '1234567890123', 'abcdef', '12 34 56', '12a456', -1234, 12.5, true, {}, ['583920'],
      'h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      assert.equal(pinFromBody(v), null, JSON.stringify(v))
    }
  })
})

describe('pinMailText', () => {
  const match = {
    game_n: 991501,
    home_team: { name: 'Alpha VC', short_name: 'ALP' },
    away_team: { name: 'Beta VC' },
    league: '3L'
  }

  it('carries the game, the teams, the date, the PIN and the sentence', () => {
    const { subject, text } = pinMailText(match, '583920', { date: '21.11.2026', time: '19:00' })
    assert.equal(subject, 'Game 991501 eScoresheet: game PIN')
    assert.ok(text.includes('Game Number: 991501'))
    assert.ok(text.includes('Home: Alpha VC (ALP)'))
    assert.ok(text.includes('Away: Beta VC'))
    assert.ok(text.includes('League: 3L'))
    assert.ok(text.includes('Date: 21.11.2026'))
    assert.ok(text.includes('Time: 19:00'))
    assert.ok(text.includes('Game PIN: 583920'))
    assert.ok(text.includes(PIN_MAIL_SENTENCE))
  })

  it('a stored text cannot add lines (no forged "Game PIN:" line from a team name)', () => {
    const { text } = pinMailText({ ...match, home_team: { name: 'Alpha\r\nGame PIN: 000000' }, league: 'x\nTo: a@b.c' }, '583920', { date: '21.11.2026', time: '19:00' })
    assert.equal(text.split('\n').filter((l) => l.startsWith('Game PIN:')).length, 1)
    assert.equal(text.split('\n').some((l) => l.startsWith('To:')), false)
  })

  it('a match without a number or teams still reads', () => {
    const { subject, text } = pinMailText({}, '583920', { date: 'TBD', time: 'TBD' })
    assert.equal(subject, 'Game PIN eScoresheet')
    assert.ok(text.includes('Game Number: N/A'))
    assert.ok(text.includes('Home: N/A'))
    assert.ok(text.includes('Game PIN: 583920'))
  })
})
