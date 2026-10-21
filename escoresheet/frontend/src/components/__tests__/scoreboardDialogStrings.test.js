// @vitest-environment node
/**
 * The undo dialog, the substitution confirmation and the rotate-device
 * overlay were English in every language ("Do you want to undo action?",
 * "OUT: # / IN: #", Yes / Cancel, "Please rotate your device"). Their text
 * comes from the locales now, in all five.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const KEYS = [
  'scoreboard.modals.undoQuestion', 'scoreboard.modals.subOut', 'scoreboard.modals.subIn',
  'scoreboard.modals.fifthSubstitution', 'scoreboard.modals.sixthSubstitution',
  'scoreboard.rotateDeviceTitle', 'scoreboard.rotateDeviceMessage', 'scoreboard.rotateDeviceTip',
  'common.yes', 'common.cancel'
]
const lookup = (locale, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), locale)

describe('Scoreboard dialogs in the scorer\'s language', () => {
  it('no English literal is left in the undo, substitution and rotate dialogs', () => {
    for (const literal of ['Do you want to undo action?', 'OUT: #', 'IN: #', 'Please rotate your device', 'works best in landscape mode', '<strong>Tip:</strong>', "'5th'", "'6th'"]) {
      expect(sb, literal).not.toContain(literal)
    }
    // the Yes / Cancel of the two dialogs
    expect(sb).not.toMatch(/onClick=\{(handleUndo|cancelUndo|confirmSubstitution|cancelSubstitutionConfirm)\}\s*>\s*(Yes|Cancel)\s*</)
    for (const key of KEYS) expect(sb, key).toContain(`t('${key}'`)
  })

  it.each([['en', en], ['de', de], ['de-CH', deCH], ['fr', fr], ['it', it_]])('%s has every key', (_, locale) => {
    for (const key of KEYS) expect(typeof lookup(locale, key), key).toBe('string')
    expect(lookup(locale, 'scoreboard.modals.subOut')).toContain('{{number}}')
    expect(lookup(locale, 'scoreboard.modals.subIn')).toContain('{{number}}')
  })
})
