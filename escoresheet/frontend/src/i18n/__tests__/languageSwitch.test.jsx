// Choosing a language in a running app (header menu, the manager's select):
// only the first language is in the bundle at start, every other one is
// loaded after the switch (src/i18n loadLocale). The screen has to show it
// once it is there, without a reload; it kept the old language before.
import { describe, it, expect } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useTranslation } from 'react-i18next'
import i18n from '../index.js'
import fr from '../locales/fr.json'
import deCH from '../locales/de-CH.json'
import en from '../locales/en.json'

function Probe() {
  const { t } = useTranslation()
  return <p data-testid="probe">{t('common.cancel')}</p>
}

describe('switching the language', () => {
  it('shows the new language once its bundle is loaded, and remembers it', async () => {
    expect(i18n.language).toBe('en')
    expect(i18n.hasResourceBundle('fr', 'translation')).toBe(false)
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe(en.common.cancel)

    await act(async () => { await i18n.changeLanguage('fr') })
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe(fr.common.cancel))
    expect(localStorage.getItem('language')).toBe('fr')

    await act(async () => { await i18n.changeLanguage('de-CH') })
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe(deCH.common.cancel))
    // a key Swiss German leaves out comes from English (de-CH, de, en)
    expect(i18n.languages).toEqual(['de-CH', 'de', 'en'])
    expect(i18n.t('modal.cancel')).toBe(en.modal.cancel)
  })
})
