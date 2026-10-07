// The toast's dismiss button speaks the app's language in all five locales
// (it used to say "Meldung schliessen" to French and Italian users).
import { describe, it, expect, afterEach } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { ToastStack } from '../Toast.jsx'
import { toast } from '../index.js'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }

async function instance(lng) {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    resources: Object.fromEntries(Object.entries(LOCALES).map(([k, v]) => [k, { translation: v }])),
    interpolation: { escapeValue: false }
  })
  return i18n
}

describe('Toast dismiss label', () => {
  afterEach(async () => {
    await act(async () => { toast.clear() })
    cleanup()
  })

  it.each([
    ['en', 'Dismiss notification'],
    ['de', 'Meldung schliessen'],
    ['de-CH', 'Meldig schliesse'],
    ['fr', 'Fermer la notification'],
    ['it', 'Chiudi la notifica']
  ])('%s: %s', async (lng, label) => {
    const i18n = await instance(lng)
    render(<I18nextProvider i18n={i18n}><ToastStack /></I18nextProvider>)
    // the old per-toast lang ('DE' default) no longer decides the label
    await act(async () => { toast.success('Saved.', { lang: 'DE' }) })
    expect(screen.getByTestId('toast-dismiss')).toHaveAttribute('aria-label', label)
  })

  it('every locale has its own label', () => {
    const labels = Object.values(LOCALES).map((l) => l.common.dismissNotification)
    expect(labels.every(Boolean)).toBe(true)
    expect(new Set([LOCALES.fr.common.dismissNotification, LOCALES.it.common.dismissNotification, LOCALES.de.common.dismissNotification]).size).toBe(3)
  })
})
