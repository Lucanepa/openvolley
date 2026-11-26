// The walkthrough's chapters and steps (walkthroughSteps.js): every step is
// complete, says what it is in every language, and points at a control (or
// says on purpose that it shows the card alone)
import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import deCH from '../../../i18n/locales/de-CH.json'
import fr from '../../../i18n/locales/fr.json'
import it_ from '../../../i18n/locales/it.json'
import { CHAPTERS, STEPS, firstStepOfChapter, stepsOfChapter } from '../walkthroughSteps'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
const SCREENS = ['home', 'matchSetup', 'rosterEditor', 'coinToss', 'scoreboard', 'matchEnd']
// the steps that show the card alone (no control to point at)
const CARD_ONLY = ['rosterMore', 'set5Skip']

describe('walkthrough steps', () => {
  it('has the owner\'s eight chapters in order, each with steps', () => {
    expect(CHAPTERS.map(c => c.id)).toEqual(['home', 'setup', 'rosters', 'coinToss', 'set1', 'setEnd', 'set5', 'matchEnd'])
    for (let c = 0; c < CHAPTERS.length; c++) {
      expect(stepsOfChapter(c).length, CHAPTERS[c].id).toBeGreaterThan(0)
      expect(STEPS[firstStepOfChapter(c)].chapter).toBe(c)
    }
    // the chapters follow each other
    expect(STEPS.map(s => s.chapter)).toEqual([...STEPS.map(s => s.chapter)].sort((a, b) => a - b))
  })

  it('gives every step an id, a screen, a way on and a way to get there', () => {
    expect(new Set(STEPS.map(s => s.id)).size).toBe(STEPS.length)
    for (const s of STEPS) {
      expect(SCREENS, s.id).toContain(s.screen)
      expect(['click', 'next'], s.id).toContain(s.advance)
      expect(typeof s.prepare, s.id).toBe('function')
      if (CARD_ONLY.includes(s.id)) expect(s.target, s.id).toBeNull()
      else expect(s.target, s.id).toBeTruthy()
      // a step that goes on with a tap has something to tap
      if (s.advance === 'click') expect(s.click || s.target, s.id).toBeTruthy()
    }
  })

  it('points at both layouts of the scoring screen (tablet and phone)', () => {
    const covers = (spec, layout) => {
      if (!spec) return false
      if (spec.tablet || spec.phone) return !!spec[layout]
      return true // one spec for both: a control both layouts have (help id, dialog)
    }
    for (const s of STEPS.filter(x => x.screen === 'scoreboard' && x.target)) {
      expect(covers(s.target, 'tablet'), `${s.id} tablet`).toBe(true)
      expect(covers(s.target, 'phone'), `${s.id} phone`).toBe(true)
    }
  })

  it.each(Object.keys(LOCALES))('%s has every text of the walkthrough', (lng) => {
    const w = LOCALES[lng].walkthrough
    expect(w, lng).toBeTruthy()
    for (const c of CHAPTERS) expect(w.chapters?.[c.id], `${lng} chapter ${c.id}`).toBeTruthy()
    for (const s of STEPS) {
      expect(w.steps?.[s.id]?.title, `${lng} ${s.id}.title`).toBeTruthy()
      expect(w.steps?.[s.id]?.text, `${lng} ${s.id}.text`).toBeTruthy()
    }
    // the same keys as English, nothing more or less
    const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort()
    expect(keys(w)).toEqual(keys(en.walkthrough))
  })

  it('names the app\'s buttons as the app shows them (en)', () => {
    const w = en.walkthrough.steps
    expect(w.homeTest.title).toBe(en.home.testMatch)
    expect(w.homeRestore.title).toBe(en.home.restoreMatch)
    expect(w.setupEditRoster.title).toBe(en.matchSetup.editRoster)
    expect(w.rosterSaved.title).toBe(en.savedTeams.load)
    expect(w.rosterClub.title).toBe(en.clubPlayers.add)
    expect(w.rosterChoose.title).toBe(en.playerPool.open)
    expect(w.rosterRemote.title).toBe(en.matchSetup.remote)
    expect(w.tossConfirm.title).toBe(en.coinToss.confirmResult)
    expect(w.set1Lineups.text).toContain(en.scoreboard.lineup)
    expect(w.set5Switch.text).toContain(en.scoreboard.buttons.switchCourts)
    expect(w.endComplete.title).toBe(en.matchEnd.title)
  })
})
