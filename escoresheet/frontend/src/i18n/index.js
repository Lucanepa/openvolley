import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const localeLoaders = {
  en: () => import('./locales/en.json'),
  fr: () => import('./locales/fr.json'),
  it: () => import('./locales/it.json'),
  de: () => import('./locales/de.json'),
  'de-CH': () => import('./locales/de-CH.json')
}

const supportedLngs = Object.keys(localeLoaders)

// Get saved language or detect from browser
const getSavedLanguage = () => {
  const saved = localStorage.getItem('language')
  if (saved && supportedLngs.includes(saved)) {
    return saved
  }
  // Try to detect from browser
  const browserLang = navigator.language?.split('-')[0]
  if (['fr', 'it', 'de'].includes(browserLang)) {
    return browserLang
  }
  return 'en'
}

const loadLocale = async (lng) => {
  if (i18n.hasResourceBundle(lng, 'translation')) return
  const mod = await localeLoaders[lng]?.()
  if (mod) {
    i18n.addResourceBundle(lng, 'translation', mod.default || mod)
  }
}

const initialLng = getSavedLanguage()

// Load the initial language synchronously via eager import, then init
const initModule = await localeLoaders[initialLng]()
const initialResource = initModule.default || initModule

i18n
  .use(initReactI18next)
  .init({
    resources: {
      [initialLng]: { translation: initialResource }
    },
    lng: initialLng,
    fallbackLng: 'en',
    supportedLngs,
    interpolation: {
      escapeValue: false // React already escapes values
    }
  })

// Load fallback language in background if not already loaded
if (initialLng !== 'en') {
  loadLocale('en')
}

// Lazy-load locale bundles on language change
i18n.on('languageChanged', (lng) => {
  localStorage.setItem('language', lng)
  loadLocale(lng)
})

export default i18n
