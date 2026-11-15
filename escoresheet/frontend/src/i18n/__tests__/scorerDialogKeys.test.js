// The scorer's dialogs, alerts and menus (scoreboard.dialogs, the action
// log's short types, the referee tablet's dialogs) were hard-coded English
// on a German, French or Italian screen. Every key they use now must exist
// in all five languages with the same {{placeholders}} and the same <b>/<r>
// tags (the two <Trans> sentences of the sanction substitution dialog).
import { describe, it, expect } from 'vitest'
import en from '../locales/en.json'
import de from '../locales/de.json'
import deCH from '../locales/de-CH.json'
import fr from '../locales/fr.json'
import it_ from '../locales/it.json'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
const marks = s => (String(s).match(/\{\{\s*[\w.]+\s*\}\}|<\/?[a-z]+\s*\/?>/g) || []).sort()

const REFEREE_KEYS = ['iosFullscreenTip', 'selectSetter', 'noLineup', 'exitAdvanced', 'advanced', 'scorerAttention', 'acknowledge']
const ACTION_LOG_KEYS = ['excSubstitution', 'excSub', 'delaySanction', 'rally', 'decision', 'pointCancelled', 'lineupChanged', 'liberoExchShort', 'liberoRedesShort', 'disqualifShort']

const required = [
  ...Object.keys(en.scoreboard.dialogs).map(k => `scoreboard.dialogs.${k}`),
  ...ACTION_LOG_KEYS.map(k => `scoreboard.actionLog.${k}`),
  ...REFEREE_KEYS.map(k => `refereeDashboard.${k}`)
]

describe('scorer dialog keys', () => {
  it('English has the dialog keys', () => {
    expect(Object.keys(en.scoreboard.dialogs).length).toBeGreaterThan(90)
    for (const key of required) expect(typeof get(en, key), key).toBe('string')
  })

  it.each(Object.keys(LOCALES))('%s has every key, with the placeholders and tags of English', (lng) => {
    const missing = []
    for (const key of required) {
      const value = get(LOCALES[lng], key)
      if (typeof value !== 'string' || !value.trim()) missing.push(key)
      else expect(marks(value), `${lng} ${key}`).toEqual(marks(get(en, key)))
    }
    expect(missing).toEqual([])
  })

  it('has no key in another language that English lacks', () => {
    for (const lng of ['de', 'de-CH', 'fr', 'it']) {
      expect(Object.keys(LOCALES[lng].scoreboard.dialogs).sort(), lng).toEqual(Object.keys(en.scoreboard.dialogs).sort())
    }
  })
})
