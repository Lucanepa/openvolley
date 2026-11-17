import { describe, it, expect, beforeEach } from 'vitest'
import { isLiveCode, normalizeLiveCode, newLiveCode, formatLiveCode, liveCodeUrl, localTvUrl, courtTokenFor, getLiveCode, setLiveCode, liveCodeForMatch, liveCodeFromUrl, LIVE_CODE_ALPHABET } from '../globalLive.js'

beforeEach(() => { localStorage.clear() })

describe('globalLive codes', () => {
  it('makes 8-character codes from the alphabet without look-alikes', () => {
    for (let i = 0; i < 50; i++) {
      const c = newLiveCode()
      expect(isLiveCode(c)).toBe(true)
      expect([...c].every(ch => LIVE_CODE_ALPHABET.includes(ch))).toBe(true)
    }
    expect(LIVE_CODE_ALPHABET).not.toMatch(/[01IO]/)
  })

  it('takes what a person types', () => {
    expect(normalizeLiveCode(' abcd-2345 ')).toBe('ABCD2345')
    expect(normalizeLiveCode('abcd 2345')).toBe('ABCD2345')
    expect(normalizeLiveCode('ABCD234O')).toBe(null) // O is not in the alphabet
    expect(normalizeLiveCode('short')).toBe(null)
    expect(formatLiveCode('ABCD2345')).toBe('ABCD 2345')
    expect(liveCodeUrl('ABCD2345')).toBe('https://openvolley.app/tv/ABCD2345')
    expect(liveCodeUrl('bad')).toBe(null)
  })

  it('a Global match carries the device\'s code, a Swiss match never', () => {
    expect(liveCodeForMatch({ global: true })).toBe(null)
    setLiveCode('ABCD2345')
    expect(getLiveCode()).toBe('ABCD2345')
    expect(liveCodeForMatch({ global: true, test: true })).toBe('ABCD2345')
    expect(liveCodeForMatch({ test: true })).toBe(null)
    expect(liveCodeForMatch({})).toBe(null)
    setLiveCode(null)
    expect(liveCodeForMatch({ global: true })).toBe(null)
    setLiveCode('not a code')
    expect(getLiveCode()).toBe(null)
  })

  it('reads the code a livescore URL asks for', () => {
    expect(liveCodeFromUrl('?t=abcd2345')).toBe('ABCD2345')
    expect(liveCodeFromUrl('?match=1')).toBe(null)
    expect(liveCodeFromUrl('?t=<script>')).toBe(null)
  })
})

describe('TV links and court tokens', () => {
  it('a venue relay serves the same TV page at its own address', () => {
    expect(localTvUrl('http://192.168.1.20:8080/', 'ABCD2345')).toBe('http://192.168.1.20:8080/tv/ABCD2345')
    expect(localTvUrl('javascript:alert(1)', 'ABCD2345')).toBe(null)
    expect(localTvUrl('http://x', 'bad')).toBe(null)
  })

  it('a match\'s court token is 32 hex characters from its own secret key, the same every time', async () => {
    const a = await courtTokenFor({ globalKey: 'k'.repeat(22) })
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(await courtTokenFor({ globalKey: 'k'.repeat(22) })).toBe(a)
    expect(await courtTokenFor({ globalKey: 'j'.repeat(22) })).not.toBe(a)
    expect(await courtTokenFor({})).toBe(null)
  })
})
