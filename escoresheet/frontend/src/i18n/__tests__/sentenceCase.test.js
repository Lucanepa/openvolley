import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import en from '../locales/en.json'
import de from '../locales/de.json'
import deCH from '../locales/de-CH.json'
import fr from '../locales/fr.json'
import it_ from '../locales/it.json'
import { displaySetNumber } from '../../utils/matchFormat'

// /volleyui copy rule: labels, buttons, titles, menu and options rows are
// sentence case. Only the first word (and proper nouns, acronyms, product
// and key names) carries a capital.

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out.push([key, String(v)])
  }
  return out
}

// Words that keep their capital mid-label.
const PROPER = new Set([
  'Chrome', 'Edge', 'Supabase', 'WebSocket', 'WiFi', 'German', 'English', 'French', 'Italian',
  'Swiss', 'Escape', 'Enter', 'Space', 'Esc', 'Bluetooth',
])

// Title-Cased words after the first one, ignoring placeholders, words after a
// sentence end, a colon, an arrow or an opening quote, and words with inner
// capitals or all caps (PIN, TO, JSON, eScoresheet).
function titleCaseWords(value) {
  const masked = value.replace(/\{\{[^}]*\}\}/g, (s) => 'x'.repeat(s.length))
  const bad = []
  for (const m of masked.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    const word = m[0]
    if (!/^\p{Lu}[\p{Ll}'’-]+$/u.test(word) || PROPER.has(word)) continue
    const before = masked.slice(0, m.index)
    if (/^[^\p{L}\p{N}]*$/u.test(before)) continue
    const gap = before.match(/[^\p{L}\p{N}]*$/u)[0]
    if (/[.!?:→\n]/.test(gap) || /(^|\s)["“«']\s*$/.test(gap)) continue
    // numbered option: "2 - Very limited functionality"
    if (/^\s*\d+$/.test(before.slice(0, before.length - gap.length)) && /[-–]/.test(gap)) continue
    bad.push(word)
  }
  return bad
}

describe('sentence case labels (en)', () => {
  const known = {
    'home.newMatch': 'New match',
    'home.restoreMatch': 'Restore match',
    'matchSetup.title': 'Match setup',
    'matchSetup.editRoster': 'Edit roster',
    'matchSetup.homeTeam': 'Home team',
    'coinToss.confirmResult': 'Confirm coin toss result',
    'matchEnd.title': 'Match complete',
    'matchEnd.approveParams': 'Confirm and approve',
    'matchEnd.reopenLastSet': 'Reopen last set',
    'matchEnd.manualAdjustments': 'Manual adjustments',
    'matchEnd.editRemarks': 'Edit remarks',
    'benchDashboard.selectTeam': 'Select your team',
    'connection.connectToServer': 'Connect to server',
    'options.checkAccidentalRallyStart': 'Check accidental rally start',
  }

  it.each(Object.entries(known))('%s stays sentence case', (key, expected) => {
    expect(get(en, key)).toBe(expected)
  })

  it('has no Title Case in short labels', () => {
    const offenders = flatten(en)
      // labels: up to 8 words and no full sentence inside. Help prose
      // (contextHelp) names on-screen labels ("Tap Undo") and is left out.
      .filter(([k]) => !k.startsWith('contextHelp.'))
      .filter(([, v]) => v.split(/\s+/).length <= 8 && !/[.!?]\s+\S/.test(v))
      .map(([k, v]) => [k, v, titleCaseWords(v)])
      .filter(([, , bad]) => bad.length > 0)
      .map(([k, v, bad]) => `${k}: "${v}" (${bad.join(', ')})`)
    expect(offenders).toEqual([])
  })
})

describe('set 5 titles show the real set number', () => {
  const locales = { en, de, 'de-CH': deCH, fr, it: it_ }
  const keys = ['scoreboard.buttons.confirmSet5Setup', 'scoreboard.modals.set5ChooseSideService']

  it.each(Object.keys(locales))('%s has a {{number}} placeholder in each set 5 title', (lng) => {
    for (const key of keys) {
      const value = get(locales[lng], key)
      expect(value, `${lng} ${key}`).toContain('{{number}}')
      expect(value, `${lng} ${key}`).not.toMatch(/\b5\b/)
    }
  })

  it('reads set 3 in best-of-3 and set 5 in best-of-5', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
    expect(i18n.t(keys[0], { number: displaySetNumber(5, 3) })).toBe('Confirm set 3 setup')
    expect(i18n.t(keys[1], { number: displaySetNumber(5, 3) })).toBe('Set 3 - choose side and service')
    expect(i18n.t(keys[0], { number: displaySetNumber(5, 5) })).toBe('Confirm set 5 setup')
  })
})
