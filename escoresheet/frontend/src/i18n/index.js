import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import fr from './locales/fr.json'
import it from './locales/it.json'
import de from './locales/de.json'

// Get saved language or detect from browser
const getSavedLanguage = () => {
  const saved = localStorage.getItem('language')
  if (saved && ['en', 'fr', 'it', 'de'].includes(saved)) {
    return saved
  }
  // Try to detect from browser
  const browserLang = navigator.language?.split('-')[0]
  if (['fr', 'it', 'de'].includes(browserLang)) {
    return browserLang
  }
  return 'en'
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      it: { translation: it },
      de: { translation: de }
    },
    lng: getSavedLanguage(),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false // React already escapes values
    }
  })

// Save language preference when changed
i18n.on('languageChanged', (lng) => {
  localStorage.setItem('language', lng)
})

export default i18n
