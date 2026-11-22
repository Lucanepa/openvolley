import { describe, it, expect } from 'vitest'
import en from '../locales/en.json'
import de from '../locales/de.json'
import deCH from '../locales/de-CH.json'
import fr from '../locales/fr.json'
import it_ from '../locales/it.json'

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out.push([key, String(v)])
  }
  return out
}

// The phone scorer's line-up tiles said "Lineup" where every other label says
// "Line-up" (full-match test 2026-11-21)
describe('"line-up" in English', () => {
  it('is written with the hyphen everywhere', () => {
    expect(en.scoreboard.lineup).toBe('Line-up')
    expect(flatten(en).filter(([, v]) => /\b[Ll]ineups?\b/.test(v))).toEqual([])
  })

  it('the help names the line-up button as the button reads, in every language', () => {
    for (const [lng, file] of Object.entries({ en, de, 'de-CH': deCH, fr, it: it_ })) {
      for (const key of ['a_lineup', 'tip_lineup']) {
        expect(file.contextHelp.scoreboard[key], `${lng} ${key}`).toContain(file.scoreboard.lineup)
      }
      expect(file.contextHelp.coinToss.a_lineups, lng).toContain(file.scoreboard.lineup)
    }
  })
})
