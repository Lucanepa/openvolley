// A team without a name is shown by its side: common.homeTeam / common.awayTeam
// (fr «Local» / «Visiteur»). common.home is the Home row of the menu (fr
// «Accueil», de «Startseite»): the team fallback used it, so a nameless home
// team read «Accueil» on a French screen and the German menu row read «Heim».
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { extractUses, listSourceFiles, FRONTEND_DIR } from '../../../scripts/check-i18n-keys.js'
import en from '../locales/en.json'
import de from '../locales/de.json'
import deCH from '../locales/de-CH.json'
import fr from '../locales/fr.json'
import it_ from '../locales/it.json'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }

describe('team name fallback', () => {
  it('has a side word in every language, apart from the Home menu row', () => {
    const words = Object.fromEntries(Object.entries(LOCALES).map(([lng, m]) => [lng, [m.common.homeTeam, m.common.awayTeam, m.common.home]]))
    expect(words).toEqual({
      en: ['Home', 'Away', 'Home'],
      de: ['Heim', 'Gast', 'Startseite'],
      'de-CH': ['Heim', 'Gascht', 'Startsiite'],
      fr: ['Local', 'Visiteur', 'Accueil'],
      it: ['Casa', 'Ospite', 'Home']
    })
  })

  it('common.home is used only by the menu, common.away nowhere', () => {
    const users = { 'common.home': new Set(), 'common.away': new Set() }
    for (const file of listSourceFiles()) {
      for (const { key } of extractUses(fs.readFileSync(file, 'utf8')).keys) {
        if (users[key]) users[key].add(path.relative(FRONTEND_DIR, file))
      }
    }
    expect([...users['common.home']]).toEqual(['src/components/MainHeader.jsx'])
    expect([...users['common.away']]).toEqual([])
  }, 30000) // reads every source file
})
