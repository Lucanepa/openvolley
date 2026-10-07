import { describe, it, expect, beforeEach } from 'vitest'
import { parseAuthLinkHash, takeAuthLinkFromLocation } from '../authLinks'

const TOKEN = 'Ab3_-'.repeat(8) + 'xyz' // 43 base64url characters

describe('parseAuthLinkHash', () => {
  it('reads reset and confirm links with their language', () => {
    expect(parseAuthLinkHash(`#reset?token=${TOKEN}&lang=de`)).toEqual({ page: 'reset', token: TOKEN, lang: 'de' })
    expect(parseAuthLinkHash(`#confirm?token=${TOKEN}`)).toEqual({ page: 'confirm', token: TOKEN, lang: null })
    expect(parseAuthLinkHash(`confirm?lang=FR&token=${TOKEN}`)).toEqual({ page: 'confirm', token: TOKEN, lang: 'fr' })
  })

  it('keeps the page but drops a cut, garbled or missing token and unknown languages', () => {
    expect(parseAuthLinkHash(`#reset?token=${TOKEN.slice(0, 30)}`)).toEqual({ page: 'reset', token: null, lang: null })
    expect(parseAuthLinkHash(`#reset?token=${TOKEN}%3Cscript`)).toEqual({ page: 'reset', token: null, lang: null })
    expect(parseAuthLinkHash('#confirm')).toEqual({ page: 'confirm', token: null, lang: null })
    expect(parseAuthLinkHash(`#reset?token=${TOKEN}&lang=rm`).lang).toBe(null)
  })

  it('ignores every other hash (the console tabs)', () => {
    for (const h of ['', '#', '#accounts', '#audit', '#resetx?token=a', '#teams?reset']) {
      expect(parseAuthLinkHash(h)).toBe(null)
    }
  })
})

describe('takeAuthLinkFromLocation', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'))

  it('returns the link and removes the token from the address bar without a new history entry', () => {
    window.history.replaceState(null, '', `/some/path?x=1#reset?token=${TOKEN}&lang=it`)
    const entries = window.history.length
    const link = takeAuthLinkFromLocation()
    expect(link).toEqual({ page: 'reset', token: TOKEN, lang: 'it' })
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(window.location.pathname).toBe('/some/path')
    expect(window.location.search).toBe('?x=1')
    expect(window.history.length).toBe(entries)
  })

  it('also strips a link whose token is unusable', () => {
    window.history.replaceState(null, '', '/#confirm?token=short')
    expect(takeAuthLinkFromLocation()).toEqual({ page: 'confirm', token: null, lang: null })
    expect(window.location.hash).toBe('')
  })

  it('leaves other hashes alone', () => {
    window.history.replaceState(null, '', '/#accounts')
    expect(takeAuthLinkFromLocation()).toBe(null)
    expect(window.location.hash).toBe('#accounts')
  })

  it('falls back to clearing the hash when history is unavailable', () => {
    const fake = {
      location: { hash: `#reset?token=${TOKEN}`, pathname: '/', search: '' },
      history: { replaceState() { throw new Error('SecurityError') } }
    }
    expect(takeAuthLinkFromLocation(fake).token).toBe(TOKEN)
    expect(fake.location.hash).toBe('')
    expect(takeAuthLinkFromLocation(null)).toBe(null)
  })
})
