// The help's one source (helpSections.js): every section has its questions in
// every language the app ships, every screen of the app shows its sections,
// and the answers say what the app does (the numbers come from the code).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import deCH from '../../../i18n/locales/de-CH.json'
import fr from '../../../i18n/locales/fr.json'
import it_ from '../../../i18n/locales/it.json'
import { listSourceFiles } from '../../../../scripts/check-i18n-keys.js'
import { GHOST_CLICK_MS } from '../../../hooks/useConfirmAction'
import { BACKGROUND_HOME_MS } from '../../../utils/deviceSelfCheck'
import {
  HELP_SCREENS, HELP_SECTIONS, SECTION_IDS, VIDEO_LANGUAGES, helpSection, screensForSection,
  sectionVideo, sectionsForScreen, supportPageUrl, videoLanguage
} from '../helpSections'
import { HELP_VIDEOS } from '../helpVideos'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
const placeholders = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).sort()

// The ids the website, the support form (area) and the videos share
const IDS = [
  'home', 'setup', 'coin-toss', 'scoring', 'subs-timeouts', 'sanctions', 'set-end', 'match-end',
  'corrections', 'connections', 'referee', 'bench', 'livescore', 'handover', 'sync-offline', 'install-updates'
]

const PANEL_KEYS = ['helpButton', 'noHelp', 'showMe', 'moreHelp', 'contactSupport', 'videoLabel', 'videoOffline', 'videoUnavailable', 'videoOnSite']
  .map(k => `contextHelp.${k}`)

function allKeys() {
  const keys = new Set(PANEL_KEYS)
  for (const s of HELP_SECTIONS) {
    keys.add(s.titleKey)
    for (const item of s.faq) {
      keys.add(item.questionKey)
      keys.add(item.answerKey)
      if (item.tooltipKey) keys.add(item.tooltipKey)
    }
  }
  for (const screen of Object.values(HELP_SCREENS)) keys.add(screen.nameKey)
  return [...keys]
}

describe('help sections', () => {
  it('are the support sections, in their order', () => {
    expect(SECTION_IDS).toEqual(IDS)
    for (const s of HELP_SECTIONS) {
      expect(s.video, s.id).toBe(s.id)
      expect(helpSection(s.id)).toBe(s)
    }
    expect(helpSection('nope')).toBeNull()
  })

  it('each have 4 to 12 questions, each key once, a tooltip only with a "Show me" target', () => {
    const seen = new Set()
    for (const s of HELP_SECTIONS) {
      expect(s.faq.length, s.id).toBeGreaterThanOrEqual(4)
      expect(s.faq.length, s.id).toBeLessThanOrEqual(12)
      for (const item of s.faq) {
        expect(seen.has(item.questionKey), item.questionKey).toBe(false)
        seen.add(item.questionKey)
        expect(item.answerKey).toBe(item.questionKey.replace('.q_', '.a_'))
        expect(!!item.tooltipKey, item.questionKey).toBe(!!item.helpId)
      }
    }
  })

  it.each(Object.keys(LOCALES))('%s has every text of the help, with the same placeholders as English', (lng) => {
    const missing = []
    for (const key of allKeys()) {
      const value = get(LOCALES[lng], key)
      if (typeof value !== 'string' || !value.trim()) missing.push(key)
      else expect(placeholders(value), `${lng} ${key}`).toEqual(placeholders(get(en, key)))
    }
    expect(missing).toEqual([])
  })

  it.each(Object.keys(LOCALES))('%s has no text left in contextHelp that English lacks', (lng) => {
    const flat = (obj, prefix, out = []) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object') flat(v, `${prefix}.${k}`, out)
        else out.push(`${prefix}.${k}`)
      }
      return out
    }
    expect(flat(LOCALES[lng].contextHelp, 'contextHelp').filter(k => get(en, k) === undefined)).toEqual([])
  })

  it('point "Show me" at elements the app has', () => {
    // the app's source without this list itself
    const source = listSourceFiles().filter(f => !f.endsWith('helpSections.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n')
    for (const s of HELP_SECTIONS) {
      for (const item of s.faq.filter(i => i.helpId)) {
        expect(source.includes(`data-help-id="${item.helpId}"`) || source.includes(`'${item.helpId}'`), item.helpId).toBe(true)
      }
    }
  })

  it('say the numbers the app uses: the 450 ms double-tap guard and the 15 minutes to Home', () => {
    const minutes = String(BACKGROUND_HOME_MS / 60000)
    for (const [lng, messages] of Object.entries(LOCALES)) {
      expect(messages.contextHelp.scoring.a_doubleTap, lng).toContain(`${GHOST_CLICK_MS} ms`)
      expect(messages.contextHelp.home.a_backgroundHome, lng).toContain(minutes)
    }
  })
})

describe('help screens', () => {
  it('cover every screen and app of the scorer, referee, bench and livescore', () => {
    expect(Object.keys(HELP_SCREENS).sort()).toEqual([
      'bench', 'closedCopy', 'coinToss', 'connectTablets', 'home', 'liveCorrections', 'livescore',
      'manualAdjustments', 'matchEnd', 'matchSetup', 'referee', 'restore', 'scoreboard', 'takeBack'
    ])
    expect(HELP_SCREENS.referee.app).toBe('referee')
    expect(HELP_SCREENS.bench.app).toBe('bench')
    expect(HELP_SCREENS.livescore.app).toBe('livescore')
  })

  it('show known sections, the main one first, and every section is on a screen', () => {
    for (const [id, screen] of Object.entries(HELP_SCREENS)) {
      expect(screen.sections.length, id).toBeGreaterThan(0)
      expect(new Set(screen.sections).size, id).toBe(screen.sections.length)
      for (const s of screen.sections) expect(IDS, `${id}: ${s}`).toContain(s)
    }
    for (const s of IDS) expect(screensForSection(s).length, s).toBeGreaterThan(0)
    expect(HELP_SCREENS.scoreboard.sections.slice(0, 4)).toEqual(['scoring', 'subs-timeouts', 'sanctions', 'set-end'])
    expect(HELP_SCREENS.home.sections[0]).toBe('home')
    expect(HELP_SCREENS.matchSetup.sections[0]).toBe('setup')
    expect(HELP_SCREENS.coinToss.sections[0]).toBe('coin-toss')
    expect(HELP_SCREENS.matchEnd.sections[0]).toBe('match-end')
    expect(HELP_SCREENS.manualAdjustments.sections[0]).toBe('corrections')
    expect(HELP_SCREENS.liveCorrections.sections[0]).toBe('corrections')
    expect(HELP_SCREENS.connectTablets.sections[0]).toBe('connections')
    expect(HELP_SCREENS.restore.sections[0]).toBe('handover')
    expect(HELP_SCREENS.takeBack.sections[0]).toBe('handover')
    expect(HELP_SCREENS.referee.sections[0]).toBe('referee')
    expect(HELP_SCREENS.bench.sections[0]).toBe('bench')
    expect(HELP_SCREENS.livescore.sections[0]).toBe('livescore')
    // a section's main screen comes first
    expect(screensForSection('corrections')[0]).toBe('manualAdjustments')
    expect(sectionsForScreen('nope')).toEqual([])
  })
})

describe('help videos and links', () => {
  it('stream from openvolley.app/support/videos, with a subtitle track per website language', () => {
    expect(sectionVideo('set-end')).toEqual({
      src: 'https://openvolley.app/support/videos/set-end.mp4',
      poster: 'https://openvolley.app/support/videos/set-end.jpg',
      title: HELP_VIDEOS['set-end'].title,
      durationSec: HELP_VIDEOS['set-end'].durationSec,
      width: HELP_VIDEOS['set-end'].width,
      height: HELP_VIDEOS['set-end'].height,
      tracks: [
        { lang: 'en', label: 'English', src: 'https://openvolley.app/support/videos/set-end.en.vtt' },
        { lang: 'de', label: 'Deutsch', src: 'https://openvolley.app/support/videos/set-end.de.vtt' },
        { lang: 'fr', label: 'Français', src: 'https://openvolley.app/support/videos/set-end.fr.vtt' },
        { lang: 'it', label: 'Italiano', src: 'https://openvolley.app/support/videos/set-end.it.vtt' }
      ]
    })
    expect(VIDEO_LANGUAGES.map(v => v.lang)).toEqual(['en', 'de', 'fr', 'it'])
    expect(supportPageUrl('sync-offline')).toBe('https://openvolley.app/support#sync-offline')
  })

  it('are the recorded ones (helpVideos.js): each a section, with its title in every website language, its length and its subtitles', () => {
    const langs = VIDEO_LANGUAGES.map(v => v.lang)
    expect(Object.keys(HELP_VIDEOS).length).toBeGreaterThan(0)
    for (const [id, video] of Object.entries(HELP_VIDEOS)) {
      expect(SECTION_IDS, id).toContain(id)
      for (const lng of langs) expect(video.title[lng], `${id} ${lng}`).toMatch(/\S/)
      expect(video.durationSec, id).toBeGreaterThan(0)
      // a short how-to, not a lecture
      expect(video.durationSec, id).toBeLessThan(5 * 60)
      // a tablet (1280x800 and the subtitle band) or two side by side
      expect(video.width / video.height, id).toBeGreaterThan(1)
      expect(video.languages.every(l => langs.includes(l)), id).toBe(true)
      expect(sectionVideo(id).tracks.map(t => t.lang), id).toEqual(langs.filter(l => video.languages.includes(l)))
    }
  })

  it('a section without a recorded video has none; a video gets only the subtitles it was recorded with', () => {
    const saved = HELP_VIDEOS['set-end']
    try {
      delete HELP_VIDEOS['set-end']
      expect(sectionVideo('set-end')).toBeNull()
      HELP_VIDEOS['set-end'] = { ...saved, languages: ['it', 'en'] }
      expect(sectionVideo('set-end').tracks.map(t => t.lang)).toEqual(['en', 'it'])
    } finally {
      HELP_VIDEOS['set-end'] = saved
    }
    expect(sectionVideo('nope')).toBeNull()
    expect(sectionVideo('toString')).toBeNull()
  })

  it('show the subtitles of the app language; de-CH reads German', () => {
    expect(videoLanguage('de-CH')).toBe('de')
    expect(videoLanguage('fr')).toBe('fr')
    expect(videoLanguage('xx')).toBe('en')
    expect(videoLanguage(undefined)).toBe('en')
  })
})
