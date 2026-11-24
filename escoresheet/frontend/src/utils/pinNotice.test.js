import { describe, it, expect } from 'vitest'
import { gamePinOf, isMailAddress, needsPinNotice, pinMailContent, pinMailtoHref, scorerEmailOf, teamsLine } from './pinNotice'

// t() as i18next does it: the default text with {{name}} filled in
const t = (key, fallback, opts) => String(typeof fallback === 'string' ? fallback : key)
  .replace(/\{\{(\w+)\}\}/g, (_, k) => String((typeof fallback === 'object' ? fallback : opts)?.[k] ?? ''))

const official = (extra = {}) => ({
  id: 1, status: 'setup', seed_key: 'match_1', gamePin: '654321',
  homeName: 'Alpha VC', awayName: 'Beta VC', game_n: 991501, league: '3L',
  scheduledAt: '2026-11-21T18:00:00.000Z',
  officials: [{ role: '1st referee', firstName: 'Rita', email: 'rita@example.ch' }, { role: 'scorer', firstName: 'Sina', email: ' sina@example.ch ' }],
  ...extra
})

describe('needsPinNotice', () => {
  it('a new official match with a game PIN, before its coin toss', () => {
    expect(needsPinNotice(official())).toBe(true)
  })

  it('once: not after it was shown on this device', () => {
    expect(needsPinNotice(official({ pinNoticeShownAt: '2026-11-21T17:00:00.000Z' }))).toBe(false)
  })

  it('never for a match without a PIN on the server: test, Global, guest, easy, or no PIN', () => {
    for (const extra of [{ test: true }, { global: true }, { guest: true }, { easy: true }, { gamePin: null }, { gamePin: '  ' }]) {
      expect(needsPinNotice(official(extra)), JSON.stringify(extra)).toBe(false)
    }
    expect(needsPinNotice(null)).toBe(false)
  })

  it('never once the coin toss is done or the match runs', () => {
    for (const extra of [{ coinTossConfirmed: true }, { approved: true }, { status: 'live' }, { status: 'ended' }, { status: 'final' }]) {
      expect(needsPinNotice(official(extra)), JSON.stringify(extra)).toBe(false)
    }
  })
})

describe('the addresses', () => {
  it('the scorer official\'s address, never another official\'s', () => {
    expect(scorerEmailOf(official())).toBe('sina@example.ch')
    expect(scorerEmailOf(official({ officials: [{ role: '1st referee', email: 'rita@example.ch' }, { role: 'scorer' }] }))).toBe('')
    expect(scorerEmailOf(official({ officials: [{ role: 'scorer', email: 'not an address' }] }))).toBe('')
    expect(scorerEmailOf({})).toBe('')
  })

  it('one plain address only', () => {
    expect(isMailAddress('sina@example.ch')).toBe(true)
    for (const v of ['', 'sina', 'sina@example', 'a@b.ch,c@d.ch', 'a@b.ch?cc=c@d.ch', 'Sina <sina@example.ch>', 'a b@c.ch']) {
      expect(isMailAddress(v), v).toBe(false)
    }
  })
})

describe('the mail-app message', () => {
  it('carries match, teams, date, PIN and the "write it down" sentence', () => {
    const { subject, body } = pinMailContent(t, official())
    expect(subject).toBe('Game PIN: Alpha VC – Beta VC')
    expect(body.split('\r\n')).toEqual([
      'Alpha VC – Beta VC',
      'Game 991501',
      'League: 3L',
      'Date: 21.11.2026 19:00',
      '',
      'Game PIN: 654321',
      '',
      'Please write the PIN down somewhere: it is needed to recover the match and/or to reopen it.'
    ])
  })

  it('leaves out what the match does not have', () => {
    const { body } = pinMailContent(t, official({ game_n: null, league: '', scheduledAt: null, homeName: '', awayName: '' }))
    expect(body.split('\r\n')[0]).toBe('Home – Away')
    expect(body).not.toMatch(/Game \d|League|Date/)
    expect(body).toContain('Game PIN: 654321')
  })

  it('a mailto: link with the address and the encoded subject and body', () => {
    const content = pinMailContent(t, official({ homeName: 'Alpha & Co', awayName: 'Beta?VC' }))
    const href = pinMailtoHref('sina@example.ch', content)
    expect(href.startsWith('mailto:sina@example.ch?subject=')).toBe(true)
    const url = new URL(href)
    expect(url.searchParams.get('subject')).toBe(content.subject)
    expect(url.searchParams.get('body')).toBe(content.body)
    expect(url.searchParams.get('body')).toContain('Game PIN: 654321')
    // no extra header can ride along (an & or ? in a team name is encoded)
    expect([...url.searchParams.keys()]).toEqual(['subject', 'body'])
    expect(href).toContain('%0D%0A')
  })

  it('no recipient for an empty or invalid address: the mail app asks', () => {
    const content = pinMailContent(t, official())
    expect(pinMailtoHref('', content).startsWith('mailto:?subject=')).toBe(true)
    expect(pinMailtoHref('x@y.ch?bcc=z@w.ch', content).startsWith('mailto:?subject=')).toBe(true)
  })

  it('the shown PIN and teams', () => {
    expect(gamePinOf({ gamePin: 42 })).toBe('42')
    expect(teamsLine(t, official())).toBe('Alpha VC – Beta VC')
  })
})

describe('the team names Match setup shows', () => {
  it('win over the match row (a match row without names reads Home – Away otherwise)', () => {
    const row = official({ homeName: undefined, awayName: undefined })
    expect(teamsLine(t, row)).toBe('Home – Away')
    expect(teamsLine(t, row, { home: 'Gamma VC', away: 'Delta VC' })).toBe('Gamma VC – Delta VC')
    const { subject, body } = pinMailContent(t, row, { home: 'Gamma VC', away: 'Delta VC' })
    expect(subject).toBe('Game PIN: Gamma VC – Delta VC')
    expect(body.split('\r\n')[0]).toBe('Gamma VC – Delta VC')
  })
})
