/**
 * The legal pages (privacy policy, terms of use, legal notice, open-source
 * notice) on openvolley.app, in DE/EN/FR/IT; German is the binding version.
 * The one place for these URLs: the apps, the manager sites, the backend
 * (status page, emails) and the download page all link here.
 *
 * The pages are built by the openvolley_home site (legal/build.mjs, its
 * ROUTES) from escoresheet/docs/legal/<lang>/*.md; keep the two in step.
 * The backend keeps a copy, backend/lib/legalLinks.js, because its Docker
 * build sees only escoresheet/backend; src/legal/__tests__/legalLinks.test.js
 * fails when the two differ.
 */

export const LEGAL_SITE = 'https://openvolley.app'

/** The documents, in the order the apps list them. */
export const LEGAL_DOCS = ['privacy', 'terms', 'impressum', 'opensource']

export const LEGAL_LANGUAGES = ['de', 'en', 'fr', 'it']

export const LEGAL_PATHS = {
  de: { privacy: '/datenschutz', terms: '/nutzungsbedingungen', impressum: '/impressum', opensource: '/open-source' },
  en: { privacy: '/en/privacy', terms: '/en/terms', impressum: '/en/imprint', opensource: '/en/open-source' },
  fr: { privacy: '/fr/confidentialite', terms: '/fr/conditions', impressum: '/fr/mentions-legales', opensource: '/fr/open-source' },
  it: { privacy: '/it/privacy', terms: '/it/condizioni', impressum: '/it/note-legali', opensource: '/it/open-source' }
}

/**
 * The language of the legal pages for an app language: de, de-CH -> de;
 * fr -> fr; it -> it; English and every other language -> en.
 */
export function legalLanguage(lng) {
  const base = String(lng || '').toLowerCase().split(/[-_]/)[0]
  return LEGAL_LANGUAGES.includes(base) ? base : 'en'
}

/** Absolute URL of one legal page in the reader's language. */
export function legalUrl(doc, lng) {
  const path = LEGAL_PATHS[legalLanguage(lng)][doc]
  if (!path) throw new Error(`unknown legal document: ${doc}`)
  return LEGAL_SITE + path
}
