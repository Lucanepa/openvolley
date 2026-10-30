/**
 * Manager console: the audit log names every entry (owner, 30.10.2026: the
 * club entries of #46 showed "club.managers", "club.update", "club.create",
 * "club_rule.set" as their title) and says which club it was about.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const api = vi.hoisted(() => ({ admin: {} }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin }))

import AuditPanel, { auditActionLabel, auditDetailsLine, readableAction } from '../manage/AuditPanel'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
// fileURLToPath(import.meta.url) as a string: under jsdom, new URL() is
// jsdom's and fileURLToPath refuses it (the check this replaces in
// ManagerBeach.test.jsx caught that error and passed without reading anything)
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../backend')
const HAS_BACKEND = existsSync(join(BACKEND, 'lib', 'accounts.js'))

const ACTION = '([a-z_]+\\.[a-z_]+)'
/**
 * Every audit action the backend can write: lib/accounts.js AUDIT_ACTIONS
 * (accounts.audit and approvals.audit refuse any other), plus the literals
 * written past that list: `action: '…'` (lib/), audit('…') (lib/auth.js),
 * audit(client, user.id, '…') (lib/beachTournaments.js) and the database
 * triggers' INSERT INTO public.audit_log (db/*.sql).
 */
function backendActions() {
  const read = (...p) => readFileSync(join(BACKEND, ...p), 'utf8')
  const block = read('lib', 'accounts.js').match(/export const AUDIT_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] || ''
  const listed = [...block.replace(/\/\/.*$/gm, '').matchAll(/'([a-z_.]+)'/g)].map(m => m[1])
  const written = new Set()
  const js = [...readdirSync(join(BACKEND, 'lib')).filter(f => f.endsWith('.js')).map(f => read('lib', f)), read('server.js')]
  for (const src of js) {
    for (const re of [new RegExp(`\\baction:\\s*'${ACTION}'`, 'g'), new RegExp(`\\baudit\\(\\s*'${ACTION}'`, 'g'), new RegExp(`\\baudit\\([^'()]*?,\\s*'${ACTION}'`, 'g')]) {
      for (const m of src.matchAll(re)) written.add(m[1])
    }
  }
  for (const f of readdirSync(join(BACKEND, 'db')).filter(f => f.endsWith('.sql'))) {
    for (const m of read('db', f).matchAll(new RegExp(`INSERT INTO public\\.audit_log[^;]*?VALUES\\s*\\([^,]+,\\s*'${ACTION}'`, 'g'))) written.add(m[1])
  }
  return { listed, written: [...written] }
}

describe.skipIf(!HAS_BACKEND)('every audit action of the backend has a name', () => {
  const { listed, written } = HAS_BACKEND ? backendActions() : { listed: [], written: [] }
  const all = [...new Set([...listed, ...written])].sort()

  it('the scan sees the list and each way of writing an entry', () => {
    expect(listed.length).toBeGreaterThan(40)
    for (const a of ['account.join', 'club.create', 'club.update', 'club.managers', 'club_rule.set']) expect(listed).toContain(a)
    // accounts.audit({ action }), a call over several lines, auth.js, beachTournaments.js, a trigger
    for (const a of ['club.managers', 'match.scorer_device', 'account.password_reset', 'tournament.create', 'match.close', 'match.approval_void']) expect(written).toContain(a)
    // whatever is written goes through the list (the API's ?action= filter takes only those)
    expect(written.filter(a => !listed.includes(a))).toEqual([])
  })

  it.each(Object.keys(LOCALES))('%s labels every one of them', (lng) => {
    const labels = LOCALES[lng].manage.audit.actions
    expect(all.filter(a => !labels[a.replace(/\./g, '_')])).toEqual([])
  })
})

describe('the audit log screen', () => {
  const KSC = '6f1c2a9b-0000-4000-8000-00000000c1ab'
  const at = (min) => `2026-10-30T09:${String(min).padStart(2, '0')}:00Z`
  const actor = { actor_name: 'Ada Admin', actor_email: 'ada@example.ch' }
  let t

  beforeAll(async () => {
    await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } })
    t = i18n.t.bind(i18n)
  })
  beforeEach(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  })
  afterEach(() => cleanup())

  const show = async (entries) => {
    api.admin.listAudit = vi.fn(async () => ({ data: { entries, next_before: null }, error: null, status: 200 }))
    render(<AuditPanel app="indoor" />)
    await screen.findByText(auditActionLabel(entries[0].action, t))
  }

  it('the four entries of the screenshot: their names and their club, no code', async () => {
    await show([
      { id: 4, at: at(4), action: 'club.managers', ...actor, details: { club_id: KSC, before: [], after: ['u-1', 'u-2'] }, club_name: 'KSC Wiedikon' },
      { id: 3, at: at(3), action: 'club.update', ...actor, details: { club_id: KSC, teams: ['KSC Wiedikon H1'] }, club_name: 'KSC Wiedikon' },
      { id: 2, at: at(2), action: 'club.create', ...actor, details: { club_id: KSC, name: 'KSC Wiedikon', teams: [] }, club_name: 'KSC Wiedikon' },
      { id: 1, at: at(1), action: 'club_rule.set', ...actor, details: { enabled: true }, club_name: null }
    ])
    for (const title of ['Club managers changed', 'Club details changed', 'Club created', 'Club rule switched']) {
      expect(screen.getByText(title)).toBeInTheDocument()
    }
    expect(screen.getByText('KSC Wiedikon · 2 managers')).toBeInTheDocument()
    expect(screen.getAllByText('KSC Wiedikon')).toHaveLength(2)
    expect(screen.getByText('The club rule is on')).toBeInTheDocument()
    const text = document.body.textContent
    for (const code of ['club.managers', 'club.update', 'club.create', 'club_rule.set', 'manage.audit']) expect(text).not.toContain(code)
  })

  it('an action this build has no name for yet reads as words, never as its code', async () => {
    await show([{ id: 1, at: at(1), action: 'club.future_thing', ...actor, details: {} }])
    expect(screen.getByText('Club future thing')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('club.future_thing')
    expect(readableAction('club_rule.set')).toBe('Club rule set')
    expect(readableAction(null)).toBe('')
    expect(auditActionLabel('club.managers')).toBe('Club managers')
    expect(auditActionLabel('club.managers', t)).toBe('Club managers changed')
  })

  it('details of the other new entries', () => {
    const line = (action, details, more = {}) => auditDetailsLine({ action, details, ...more }, { t })
    // an entry listed by an older backend: no club_name, nothing breaks
    expect(line('club.managers', { club_id: KSC, before: ['u-1'], after: [] })).toBe('0 managers')
    expect(line('club.managers', { club_id: KSC, after: ['u-1'] }, { club_name: 'KSC Wiedikon' })).toBe('KSC Wiedikon · 1 manager')
    expect(line('club.contact', { club_id: KSC, set: true }, { club_name: 'KSC Wiedikon' })).toBe('KSC Wiedikon')
    expect(line('club.member_remove', { club_id: KSC }, { club_name: 'KSC Wiedikon' })).toBe('KSC Wiedikon')
    // a deleted club: its name from the entry itself
    expect(line('club.delete', { club_id: KSC, name: 'VBC Gone', scorers: 3 })).toBe('VBC Gone · Scorers: 3')
    // renamed: the club's name once
    expect(line('club.update', { club_id: KSC, name: 'KSC Wiedikon' }, { club_name: 'KSC Wiedikon' })).toBe('KSC Wiedikon')
    expect(line('account.clubs', { before: [], after: [KSC, 'x'], names: ['KSC Wiedikon', 'VBC Other'] })).toBe('KSC Wiedikon, VBC Other')
    expect(line('account.clubs', { before: [KSC], after: [], names: [] })).toBe('No club')
    expect(line('account.clubs', { invite_id: 'i-1', joined: KSC }, { club_name: 'KSC Wiedikon' })).toBe('+ KSC Wiedikon')
    expect(line('club_rule.set', { enabled: false })).toBe('The club rule is off')
    expect(line('settings.final_email', { send_final_email: true })).toBe('Final scoresheets are now sent by email')
    expect(line('settings.final_email', { send_final_email: false })).toBe('Final scoresheets are no longer sent')
    expect(line('match.final_mail', { recipients: 3, corrected: true, game_n: 4711 })).toBe('#4711 · 3 recipients · corrected')
    expect(line('match.final_mail', { recipients: 1, corrected: false, game_n: 4711 })).toBe('#4711 · 1 recipient')
    expect(line('activity.delete', { match: 'match_1', account: null, rows: 12 })).toBe('match_1 · 12 entries')
    expect(line('activity.delete', { match: null, account: 'u-1', rows: 1 })).toBe('1 entry')
    // a club's invite code: its club after the label and role
    expect(line('invite.create', { invite_id: 'i-1', label: 'H1 scorers', role: 'scorer', club_id: KSC }, { club_name: 'KSC Wiedikon' })).toBe('H1 scorers · scorer · KSC Wiedikon')
    // without t: English, no key
    expect(auditDetailsLine({ action: 'match.final_mail', details: { recipients: 2, game_n: 1 } })).toBe('#1 · 2 recipients')
  })
})
