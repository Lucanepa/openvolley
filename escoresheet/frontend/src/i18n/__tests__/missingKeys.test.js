import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractKeys, extractUses, findMissingKeys, findMissingKeysByLocale, hasKey, hasPrefix, LOCALES } from '../../../scripts/check-i18n-keys.js'

// A key used in the code but missing from en.json shows up as its raw name,
// e.g. a "Notice" dialog reading "matchSetup.allowPopups" in the desktop app;
// one missing from another language shows English in the middle of it.
describe('translation keys used in the code', () => {
  it('all exist in en.json', () => {
    const missing = Object.fromEntries(findMissingKeys())
    expect(missing).toEqual({})
  }, 30000) // reads every source file: more than the 5 s default on a busy machine

  it('all exist in every language the app ships', () => {
    expect(LOCALES).toEqual(['en', 'de', 'de-CH', 'fr', 'it'])
    const byLocale = findMissingKeysByLocale()
    const missing = Object.fromEntries(Object.entries(byLocale).map(([lng, m]) => [lng, [...m.keys()].sort()]))
    expect(missing).toEqual({})
  })

  it('reports the missing keys per locale, a template parent only when the object is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-i18n-'))
    try {
      fs.mkdirSync(path.join(root, 'src/i18n/locales'), { recursive: true })
      const write = (lng, messages) => fs.writeFileSync(path.join(root, 'src/i18n/locales', `${lng}.json`), JSON.stringify(messages))
      write('en', { a: { b: 'x' }, c: { role: { referee: 'R' } } })
      write('de', { a: { b: 'y' }, c: { role: {} } })   // parent there: no child is checked
      write('fr', { a: {}, c: {} })
      const file = path.join(root, 'src/x.jsx')
      fs.writeFileSync(file, "t('a.b')\nt(`c.role.${r}`)\n")
      const byLocale = findMissingKeysByLocale({ locales: ['en', 'de', 'fr'], files: [file], root })
      expect(Object.keys(byLocale)).toEqual(['fr'])
      expect(Object.fromEntries(byLocale.fr)).toEqual({ 'a.b': ['src/x.jsx:1'], 'c.role.*': ['src/x.jsx:2'] })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads literal keys from t() calls', () => {
    const src = [
      "t('matchSetup.allowPopups')",
      't("a.b", { count })',
      "i18n.t('x.y.z', 'Default')",
      "t(`dynamic.${key}`)",
      "t(someVar)",
      "split('a.b')",
      "t('Not a key')",
    ].join('\n')
    expect(extractKeys(src).map(k => k.key)).toEqual(['matchSetup.allowPopups', 'a.b', 'x.y.z'])
    expect(extractKeys(src).map(k => k.line)).toEqual([1, 2, 3])
  })

  it('reads both arms of a ternary, not its condition', () => {
    const src = [
      "t(isHome ? 'coinToss.teamA' : 'coinToss.teamB')",
      "t(role === 'coach.x' ? 'a.coach' : 'a.captain', 'Default')",
      "t(fn(a, 'x.y') ? \"b.one\" : `b.two`)",
      "t(a?.b ? 'c.d' : 'c.e')",
    ].join('\n')
    expect(extractKeys(src).map(k => k.key)).toEqual([
      'coinToss.teamA', 'coinToss.teamB',
      'a.coach', 'a.captain',
      'b.one', 'b.two',
      'c.d', 'c.e',
    ])
  })

  it('reports the parent of a template-literal key', () => {
    const src = [
      't(`tabletStatus.role.${role.role}`, role.label)',
      't(`plain.key`)',
      't(`${ns}.x`)',
      't(ok ? `s.${a}` : \'s.fixed\')',
      "t('a.b', `default ${x}`)",
    ].join('\n')
    const { keys, prefixes } = extractUses(src)
    expect(prefixes).toEqual([{ prefix: 'tabletStatus.role', line: 1 }, { prefix: 's', line: 4 }])
    expect(keys.map(k => k.key)).toEqual(['plain.key', 's.fixed', 'a.b'])
    const messages = { tabletStatus: { title: 'x', role: { referee: 'Referee' } } }
    expect(hasPrefix(messages, 'tabletStatus.role')).toBe(true)
    expect(hasPrefix(messages, 'tabletStatus.status')).toBe(false)
    expect(hasPrefix(messages, 'tabletStatus.title')).toBe(false) // a string, not an object
  })

  it('accepts plural forms', () => {
    const messages = { a: { items_one: '1 item', items_other: '{{count}} items', plain: 'x' } }
    expect(hasKey(messages, 'a.items')).toBe(true)
    expect(hasKey(messages, 'a.plain')).toBe(true)
    expect(hasKey(messages, 'a.missing')).toBe(false)
    expect(hasKey(messages, 'a.plain.deeper')).toBe(false)
  })
})
