import { describe, it, expect } from 'vitest'
import deCH from '../locales/de-CH.json'

// de-CH writes the device "Grät" in its Swiss German strings and "Gerät" in
// the ones in standard German (review of #37: the two were mixed in the
// dialect strings, "S Testspiil uf dem Gerät ...").

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out.push([key, String(v)])
  }
  return out
}

// Words only the Swiss German strings use
const DIALECT = /\b(uf|isch|nöd|däm|dem Grät|bruucht|Kei|cha|lauft|Spiil|Sitzig|Mälded|glöscht|Wiiterfahre)\b/

describe('de-CH: the device', () => {
  it('is "Grät" in every Swiss German string', () => {
    const mixed = flatten(deCH).filter(([, v]) => DIALECT.test(v) && /Gerät/.test(v)).map(([k]) => k)
    expect(mixed).toEqual([])
  })
})
