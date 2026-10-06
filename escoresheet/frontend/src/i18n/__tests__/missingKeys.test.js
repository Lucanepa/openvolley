import { describe, it, expect } from 'vitest'
import { extractKeys, findMissingKeys, hasKey } from '../../../scripts/check-i18n-keys.js'

// A key used in the code but missing from en.json shows up as its raw name,
// e.g. a "Notice" dialog reading "matchSetup.allowPopups" in the desktop app.
describe('translation keys used in the code', () => {
  it('all exist in en.json', () => {
    const missing = Object.fromEntries(findMissingKeys())
    expect(missing).toEqual({})
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

  it('accepts plural forms', () => {
    const messages = { a: { items_one: '1 item', items_other: '{{count}} items', plain: 'x' } }
    expect(hasKey(messages, 'a.items')).toBe(true)
    expect(hasKey(messages, 'a.plain')).toBe(true)
    expect(hasKey(messages, 'a.missing')).toBe(false)
    expect(hasKey(messages, 'a.plain.deeper')).toBe(false)
  })
})
