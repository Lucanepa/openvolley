// The change log of Edit match info names each field as the screen does: the
// three match-type selects, the game number and the date logged
// "Match match_type_1" (their keys did not exist).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll } from 'vitest'
import i18n from '../../i18n'
import { matchFieldLabel } from '../ManualAdjustments'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }

describe('Edit match info: change-log labels', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  const t = (...args) => i18n.t(...args)

  it('names every field with its on-screen label', () => {
    expect(matchFieldLabel(t, 'match_type_1')).toBe('Match type')
    expect(matchFieldLabel(t, 'match_type_2')).toBe('Match type (gender)')
    expect(matchFieldLabel(t, 'match_type_3')).toBe('Match level')
    expect(matchFieldLabel(t, 'gameN')).toBe('Game number')
    expect(matchFieldLabel(t, 'scheduledAt')).toBe('Scheduled date/time')
    expect(matchFieldLabel(t, 'hall')).toBe('Hall')
    for (const f of ['match_type_1', 'match_type_2', 'match_type_3', 'gameN', 'scheduledAt', 'hall', 'city', 'league', 'championshipType']) {
      expect(matchFieldLabel(t, f)).not.toMatch(/^Match (match_type_|gameN|scheduledAt|championshipType)|manualAdjustmentsEditor\./)
    }
  })

  it('every language has the labels (looked up in its own file)', () => {
    for (const [lng, file] of Object.entries(LOCALES)) {
      const lookup = (key, def) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), file) ?? def
      for (const f of ['match_type_1', 'match_type_2', 'match_type_3', 'gameN', 'scheduledAt']) {
        const label = matchFieldLabel(lookup, f)
        expect(typeof label, `${lng} ${f}`).toBe('string')
        expect(label, `${lng} ${f}`).not.toMatch(/^Match (match_type_|gameN|scheduledAt)|manualAdjustmentsEditor\./)
      }
    }
    expect(matchFieldLabel((key, def) => key.split('.').reduce((o, k) => o?.[k], LOCALES.de) ?? def, 'match_type_3')).toBe('Stufe')
  })
})
