import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import en from '../locales/en.json'
import de from '../locales/de.json'
import deCH from '../locales/de-CH.json'
import fr from '../locales/fr.json'
import it_ from '../locales/it.json'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }

async function tFor(lng) {
  const i18n = i18next.createInstance()
  await i18n.init({ lng, resources: { [lng]: { translation: LOCALES[lng] } }, interpolation: { escapeValue: false } })
  return i18n.t.bind(i18n)
}

// Match setup's roster line was English in every language ("(11 + 1 libero)",
// 28.11.2026): German nouns are capitalised, French writes libéro
describe('match setup roster line: players + liberos', () => {
  it.each([
    ['en', '(11 + 1 libero)', '(10 + 2 liberos)'],
    ['de', '(11 + 1 Libero)', '(10 + 2 Liberos)'],
    ['de-CH', '(11 + 1 Libero)', '(10 + 2 Liberos)'],
    ['fr', '(11 + 1 libéro)', '(10 + 2 libéros)'],
    ['it', '(11 + 1 libero)', '(10 + 2 liberi)']
  ])('%s', async (lng, one, two) => {
    const t = await tFor(lng)
    expect(t('matchSetup.rosterSplit', { players: 11, count: 1 })).toBe(one)
    expect(t('matchSetup.rosterSplit', { players: 10, count: 2 })).toBe(two)
  })
})

// Swiss Volley's French text: «premier arbitre», «second arbitre» (rules 23, 24)
describe('French referee titles', () => {
  it('no «2ème arbitre» left; the 2nd referee is «Second arbitre»', () => {
    expect(JSON.stringify(fr)).not.toMatch(/2(ème|e|nd) arbitre|1er arbitre/i)
    expect(fr.matchSetup.referee2).toBe('Second arbitre')
    expect(fr.matchEnd.referee2).toBe('Second arbitre')
    expect(fr.refereeDashboard.secondReferee).toBe('Second arbitre')
  })
})

// The "?" answers of retired features: team short names (#360), the scorer's
// date of birth (licence since 19.11.2026), the "TO" box and "Confirm time-out"
describe('help answers name what the app shows now', () => {
  it.each(Object.keys(LOCALES))('%s', (lng) => {
    const h = LOCALES[lng].contextHelp
    const texts = [h.matchSetup.a_loadSchedule, h.matchSetup.a_afterCoinToss].join(' ')
    expect(texts).not.toMatch(/short name|Kurzname|Churzn|nom court|noms courts|nome breve|nomi brevi/i)
    expect(h.matchSetup.a_officials).not.toMatch(/date of birth|Geburtsdatum|date de naissance|data di nascita/i)
    expect(h.scoreboard.a_timeout).not.toMatch(/«TO»|“TO”|« TM »|Confirm time-out|Auszeit bestätig|Confirmer temps-mort|Conferma timeout/)
    expect(h.scoreboard.a_timeout).toContain(LOCALES[lng].scoreboard.labels.timeoutFull)
    expect(h.scoreboard.a_timeout).toContain(LOCALES[lng].common.confirm)
  })
})
