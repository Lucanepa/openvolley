// A key written twice in the same object of a locale file is legal JSON, and
// JSON.parse keeps only the last one: the texts of the first block vanish
// without an error. A merge of two branches that both add the same new
// namespace (e.g. two `"update": {…}` blocks) does exactly that.
import { describe, it, expect } from 'vitest'
import en from '../locales/en.json?raw'
import de from '../locales/de.json?raw'
import deCH from '../locales/de-CH.json?raw'
import fr from '../locales/fr.json?raw'
import it_ from '../locales/it.json?raw'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }

/** Every key path that appears more than once in the same object. */
function duplicateKeys(text) {
  const dups = []
  const stack = [] // objects: { keys, path, expectKey }; arrays: { array, path }
  let lastKey = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { s += text[j] + text[j + 1]; j += 2 } else { s += text[j]; j++ }
      }
      const top = stack[stack.length - 1]
      if (top && !top.array && top.expectKey) {
        if (top.keys.has(s)) dups.push([...top.path, s].join('.'))
        top.keys.add(s)
        top.expectKey = false
        lastKey = s
      }
      i = j
      continue
    }
    const top = stack[stack.length - 1]
    const childPath = top ? (top.array ? top.path : [...top.path, lastKey]) : []
    if (c === '{') stack.push({ keys: new Set(), path: childPath, expectKey: true })
    else if (c === '[') stack.push({ array: true, path: childPath })
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',' && top && !top.array) top.expectKey = true
  }
  return dups
}

describe('locale files', () => {
  it('finds a key written twice', () => {
    expect(duplicateKeys('{"a":{"x":"1"},"b":["{\\"a\\""],"a":{"y":"2"}}')).toEqual(['a'])
    expect(duplicateKeys('{"u":{"k":"1","k":"2"},"v":{"k":"3"}}')).toEqual(['u.k'])
    expect(duplicateKeys('{"a":[{"k":1},{"k":2}],"b":"a"}')).toEqual([])
  })

  for (const [lang, text] of Object.entries(LOCALES)) {
    it(`${lang}: no key twice in the same object`, () => {
      expect(duplicateKeys(text)).toEqual([])
    })
  }
})
