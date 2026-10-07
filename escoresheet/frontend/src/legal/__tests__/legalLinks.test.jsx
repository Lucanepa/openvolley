import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { LEGAL_DOCS, LEGAL_LANGUAGES, LEGAL_PATHS, LEGAL_SITE, legalLanguage, legalUrl } from '../legalLinks'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

// Files outside src/, relative to this test (vite rewrites new URL(x, import.meta.url))
const HERE = dirname(fileURLToPath(import.meta.url))
const readRel = (rel) => readFileSync(join(HERE, rel), 'utf8')

// The app language under test; t() reads the English strings.
let language = 'en'
const lookup = (key) => key.split('.').reduce((o, k) => o?.[k], en)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => lookup(key) ?? key, i18n: { language, resolvedLanguage: language } })
}))

import LegalLinks, { LegalSentence } from '../LegalLinks'

describe('legal page URLs', () => {
  it('has a page for every document in every language, under openvolley.app', () => {
    expect(LEGAL_SITE).toBe('https://openvolley.app')
    for (const lang of LEGAL_LANGUAGES) {
      expect(Object.keys(LEGAL_PATHS[lang]).sort()).toEqual([...LEGAL_DOCS].sort())
    }
    const all = LEGAL_LANGUAGES.flatMap((l) => Object.values(LEGAL_PATHS[l]))
    expect(new Set(all).size).toBe(all.length)
  })

  it('uses the site\'s clean URLs (openvolley_home legal/build.mjs ROUTES)', () => {
    expect(legalUrl('privacy', 'de')).toBe('https://openvolley.app/datenschutz')
    expect(legalUrl('impressum', 'de')).toBe('https://openvolley.app/impressum')
    expect(legalUrl('terms', 'de')).toBe('https://openvolley.app/nutzungsbedingungen')
    expect(legalUrl('opensource', 'de')).toBe('https://openvolley.app/open-source')
    expect(legalUrl('impressum', 'en')).toBe('https://openvolley.app/en/imprint')
    expect(legalUrl('privacy', 'fr')).toBe('https://openvolley.app/fr/confidentialite')
    expect(legalUrl('impressum', 'it')).toBe('https://openvolley.app/it/note-legali')
  })

  it('maps the app languages: de-CH to German, unknown languages to English', () => {
    expect(legalLanguage('de-CH')).toBe('de')
    expect(legalLanguage('de')).toBe('de')
    expect(legalLanguage('fr-CH')).toBe('fr')
    expect(legalLanguage('it')).toBe('it')
    expect(legalLanguage('en')).toBe('en')
    expect(legalLanguage('rm')).toBe('en')
    expect(legalLanguage(undefined)).toBe('en')
    expect(() => legalUrl('cookies', 'en')).toThrow(/unknown legal document/)
  })

  it('the backend copy (its Docker build sees only backend/) is the same code', () => {
    const front = readRel('../legalLinks.js')
    const back = readRel('../../../../backend/lib/legalLinks.js')
    expect(back.endsWith(front)).toBe(true)
    expect(back.slice(0, back.length - front.length)).toMatch(/^(\/\/ .*\n)+\n$/)
  })
})

describe('static pages that cannot import the constant', () => {
  it('get.openvolley.app (deploy/pkgs/index.html) links all four pages with these URLs', () => {
    const html = readRel('../../../../deploy/pkgs/index.html')
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'))
    const hrefs = [...footer.matchAll(/href="(https:\/\/openvolley\.app\/[^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(LEGAL_DOCS.map((doc) => legalUrl(doc, 'en')))
  })
})

describe('legal strings', () => {
  it('every locale names the four pages and has the sign-up sentence with both links', () => {
    for (const [lng, data] of Object.entries({ en, de, 'de-CH': deCH, fr, it: it_ })) {
      for (const key of ['nav', ...LEGAL_DOCS]) expect(data.legal?.[key], `${lng}.${key}`).toBeTruthy()
      expect(data.legal.signUpConsent, lng).toMatch(/<terms>[^<]+<\/terms>.*<privacy>[^<]+<\/privacy>/)
      expect(JSON.stringify(data.legal), lng).not.toMatch(/ß/)
    }
  })
})

describe('LegalLinks', () => {
  it('links the pages in the app language, opening in the browser', () => {
    language = 'de-CH'
    render(<LegalLinks />)
    const links = [...screen.getByTestId('legal-links').querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://openvolley.app/datenschutz',
      'https://openvolley.app/nutzungsbedingungen',
      'https://openvolley.app/impressum',
      'https://openvolley.app/open-source'
    ])
    expect(links.map((a) => a.textContent)).toEqual(['Privacy policy', 'Terms of use', 'Legal notice', 'Open-source notice'])
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank')
      expect(a.getAttribute('rel')).toMatch(/noopener/)
    }
    expect(screen.getByRole('navigation', { name: 'Legal' })).toBeInTheDocument()
  })

  it('falls back to English for other languages and lists only the pages asked for', () => {
    language = 'es'
    render(<LegalLinks docs={['privacy', 'impressum']} />)
    const hrefs = [...screen.getByTestId('legal-links').querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['https://openvolley.app/en/privacy', 'https://openvolley.app/en/imprint'])
  })

  it('LegalSentence turns the marked words into links and keeps the rest as text', () => {
    language = 'fr'
    render(<LegalSentence i18nKey="legal.signUpConsent" data-testid="s" />)
    const p = screen.getByTestId('s')
    expect(p).toHaveTextContent('By creating an account you accept the terms of use and the privacy policy.')
    const links = [...p.querySelectorAll('a')]
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['terms of use', 'https://openvolley.app/fr/conditions'],
      ['privacy policy', 'https://openvolley.app/fr/confidentialite']
    ])
    expect(p.innerHTML).not.toMatch(/&lt;|<terms|<privacy/)
  })
})
