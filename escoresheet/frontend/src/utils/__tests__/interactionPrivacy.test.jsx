// What the interaction log (utils/eventCapture -> comprehensiveLogger) keeps
// of typing and taps: never the text typed into a field (fe-ui-rest-3), never
// the PIN that opens an encrypted backup (fe-diagnostics-privacy-2), and no
// player's name or date of birth from a tap on the Player pool
// (gap-fe-unread-dialogs-2). The log goes into "Download logs", the
// match-end ZIP and the support diagnostics.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts?.n != null ? `${key} ${opts.n}` : key), i18n: { language: 'en' } })
}))

import { installGlobalEventCapture, uninstallGlobalEventCapture, redactScreenText } from '../eventCapture'
import { initComprehensiveLogger, getBufferedLogs, isSecretEntry } from '../comprehensiveLogger'
import BackupUnlockDialog from '../../components/BackupUnlockDialog'
import PlayerPoolModal from '../../components/PlayerPoolModal'
import { buildPlayerPool } from '../../domain/playerPool'

// the entries of the running test
let before = new Set()
const logged = () => getBufferedLogs().filter(e => e.category === 'ui' && !before.has(e.id))
const ofType = (type) => logged().filter(e => e.type === type)

beforeAll(() => {
  initComprehensiveLogger(null, null)
  installGlobalEventCapture()
})
afterAll(() => uninstallGlobalEventCapture())
beforeEach(() => { before = new Set(getBufferedLogs().map(e => e.id)) })
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function typeInto(el, text) {
  for (const ch of text) {
    fireEvent.keyDown(el, { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}` })
    el.value = (el.value || '') + ch
    fireEvent.input(el, { target: { value: el.value } })
  }
  fireEvent.change(el, { target: { value: el.value } })
}

describe('typing into a field', () => {
  it('keeps which field and how long, never the keys or the value', () => {
    const el = document.createElement('input')
    el.type = 'email'
    el.name = 'inviteEmail'
    document.body.appendChild(el)
    typeInto(el, 'anna@example.ch')
    const text = JSON.stringify(logged())
    expect(text).not.toContain('anna@example.ch')
    expect(text).not.toContain('example')
    const keys = ofType('keydown').map(e => e.payload)
    expect(keys.length).toBe(15)
    expect(keys.every(k => k.key.length === 1 && !/[a-z@.]/i.test(k.key) && k.code == null)).toBe(true)
    // input is throttled: whichever were kept say how long, not what
    expect(ofType('input').length).toBeGreaterThan(0)
    expect(ofType('input').every(e => Number.isInteger(e.payload.valueLength) && e.payload.value === undefined)).toBe(true)
    expect(ofType('change').at(-1).payload.value).toBeUndefined()
    expect(ofType('change').at(-1).payload.valueLength).toBe(15)
    // the field is still named
    expect(ofType('keydown')[0].target.name).toBe('inviteEmail')
  })

  it('a date of birth typed into a text field is not kept', () => {
    const el = document.createElement('input')
    el.type = 'text'
    document.body.appendChild(el)
    typeInto(el, '14.03.2012')
    const text = JSON.stringify(logged())
    expect(text).not.toContain('14.03.2012')
    expect(text).not.toMatch(/"key":"\d"/)
    expect(text).not.toMatch(/Digit\d/)
  })

  it('named keys and a key outside any field (a shortcut) stay as they are', () => {
    const el = document.createElement('input')
    document.body.appendChild(el)
    fireEvent.keyDown(el, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' })
    const [enter, shortcut] = ofType('keydown').map(e => e.payload)
    expect(enter).toMatchObject({ key: 'Enter', code: 'Enter' })
    expect(shortcut).toMatchObject({ key: 'a', code: 'KeyA' })
  })

  it('a select keeps the option chosen, a checkbox whether it is ticked', () => {
    const sel = document.createElement('select')
    for (const v of ['warn', 'error']) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = v
      sel.appendChild(o)
    }
    const box = document.createElement('input')
    box.type = 'checkbox'
    document.body.append(sel, box)
    fireEvent.change(sel, { target: { value: 'error' } })
    fireEvent.click(box)
    const changes = ofType('change').map(e => e.payload)
    expect(changes[0]).toMatchObject({ value: 'error' })
    expect(changes.at(-1)).toMatchObject({ checked: true })
  })
})

describe('the PIN of an encrypted backup file', () => {
  it('is not in the log, neither its digits nor the value', () => {
    render(<BackupUnlockDialog envelope={{ format: 'openvolley-encrypted-backup', formatVersion: 1, readable: { gameN: 4711 }, slots: [], ciphertext: '' }} onOpened={() => {}} onCancel={() => {}} />)
    const field = screen.getByPlaceholderText('000000')
    for (const d of '482913') fireEvent.keyDown(field, { key: d, code: `Digit${d}` })
    fireEvent.input(field, { target: { value: '482913' } })
    fireEvent.change(field, { target: { value: '482913' } })
    const text = JSON.stringify(logged())
    expect(text).not.toContain('482913')
    expect(text).not.toMatch(/Digit\d/)
    expect(ofType('keydown').map(e => e.payload.key).join('')).not.toContain('4829')
    // a secret field: not even how long the PIN is, and no export keeps the entries
    expect(ofType('keydown').every(e => e.payload.key === '[REDACTED]')).toBe(true)
    expect(ofType('input').every(e => e.payload.valueLength == null)).toBe(true)
    expect(logged().filter(e => ['keydown', 'input', 'change'].includes(e.type)).every(isSecretEntry)).toBe(true)
  })
})

describe('a tap on the Player pool', () => {
  it('keeps no name and no date of birth', () => {
    const pool = buildPlayerPool({ saved: [{ number: 9, lastName: 'Sample', firstName: 'Minor', dob: '14.03.2012', libero: '', isCaptain: false, isLfp: false }] })
    render(<PlayerPoolModal open pool={pool} onApply={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('player-pool-name'))
    fireEvent.click(screen.getByText('14.03.2012'))
    fireEvent.click(screen.getByTestId('player-pool-row'))
    const text = JSON.stringify(logged())
    expect(ofType('click').length).toBeGreaterThan(0)
    expect(text).not.toContain('14.03.2012')
    expect(text).not.toMatch(/sample/i)
    expect(text).not.toContain('Minor')
  })
})

describe('clicked text (screenText)', () => {
  it('a date in a label is left out, and so is an email address; scores, times and shirt numbers stay', () => {
    expect(redactScreenText('9SAMPLE Minor14.03.2012')).toBe('9SAMPLE Minor[date]')
    expect(redactScreenText('born 2012-03-14')).toBe('born [date]')
    expect(redactScreenText('14/03/2012')).toBe('[date]')
    expect(redactScreenText('born 1.3.2012, 2nd')).toBe('born [date], 2nd')
    expect(redactScreenText('Coach anna.muster@example.ch')).toBe('Coach [email]')
    expect(redactScreenText('25:23 · #7 · Set 2 · 18:30')).toBe('25:23 · #7 · Set 2 · 18:30')
    expect(redactScreenText('v3.1.2')).toBe('v3.1.2')
    expect(redactScreenText('OpenVolley 3.1.20')).toBe('OpenVolley 3.1.20')
  })
})
