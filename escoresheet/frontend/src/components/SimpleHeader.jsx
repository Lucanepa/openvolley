import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Maximize, Menu, X } from 'lucide-react'
import i18n from '../i18n'
import { ClipboardIcon, TrashIcon } from './icons'
import { clearCachesAndReload } from '../hooks/useServiceWorker'
import { cn } from '../ui/cn.js'
import { toast } from '../ui/uiStore.js'
import { SwitchTrack } from '../ui/Switch.jsx'
import { SegmentedControl } from '../ui/SegmentedControl.jsx'
import {
  HEADER_BAR, HEADER_BTN, HEADER_BTN_ON, HEADER_TITLE, MENU_PANEL, MENU_SECTION, MENU_ROW, MENU_SUBROW,
  MENU_ROW_ON, MENU_ROW_DANGER, MENU_NEST, MENU_SEP, MENU_ICON, MENU_COUNT, itemTone, toastLang
} from './chromeClasses'

// Flag SVG components for language selector
const FlagGB = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="42" fill="#012169" />
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#fff" strokeWidth="7" />
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#C8102E" strokeWidth="4" clipPath="url(#gbClip)" />
    <path d="M30,0 V42 M0,21 H60" stroke="#fff" strokeWidth="12" />
    <path d="M30,0 V42 M0,21 H60" stroke="#C8102E" strokeWidth="7" />
  </svg>
)

const FlagIT = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#009246" />
    <rect x="20" width="20" height="42" fill="#fff" />
    <rect x="40" width="20" height="42" fill="#CE2B37" />
  </svg>
)

const FlagDE = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="14" fill="#000" />
    <rect y="14" width="60" height="14" fill="#DD0000" />
    <rect y="28" width="60" height="14" fill="#FFCE00" />
  </svg>
)

const FlagFR = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#002395" />
    <rect x="20" width="20" height="42" fill="#fff" />
    <rect x="40" width="20" height="42" fill="#ED2939" />
  </svg>
)

const FlagCH = () => (
  <svg width="14" height="14" viewBox="0 0 32 32" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="32" height="32" fill="#ff0000" />
    <rect x="14" y="6" width="4" height="20" fill="#fff" />
    <rect x="6" y="14" width="20" height="4" fill="#fff" />
  </svg>
)

const languages = [
  { code: 'en', Flag: FlagGB, label: 'EN' },
  { code: 'it', Flag: FlagIT, label: 'IT' },
  { code: 'de', Flag: FlagDE, label: 'DE' },
  { code: 'de-CH', Flag: FlagCH, label: 'DE' },
  { code: 'fr', Flag: FlagFR, label: 'FR' }
]

/**
 * SimpleHeader - 3-column header for all dashboard apps
 * Left: Title/version
 * Middle: Hamburger menu (collapsible)
 * Right: Fullscreen button
 *
 * volleyui chrome: white bar with a stone hairline, kit header buttons, the
 * menu as a white anchored dropdown with 48 px rows, the optional toggle as a
 * kit segmented pill (slate-900 when on).
 */
export default function SimpleHeader({
  title,
  version,
  menuItems = [], // Array of { icon, label, onClick, active, color, toggle, badge, badgeColor, disabled, divider }
  onFullscreen,
  isFullscreen = false,
  toggleOptions // Optional: segmented toggle [{ label: '1 REF', active: false, onClick }, { label: '2 REF', active: true, onClick }]
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [versionExpanded, setVersionExpanded] = useState(false)
  const [languageExpanded, setLanguageExpanded] = useState(false)
  const [confirmingClearCache, setConfirmingClearCache] = useState(false)
  const currentVersion = version || __APP_VERSION__

  const handleClearCache = async () => {
    try {
      // Keeps ?match=&team= on reload; refuses when the server is unreachable
      if (!(await clearCachesAndReload())) {
        toast.error(t('options.alerts.clearCacheNeedsServer', 'Cannot clear the cache while the server is unreachable: the app could not be reloaded afterwards.'), { lang: toastLang() })
      }
    } catch (error) {
      console.error('Error clearing cache:', error)
      toast.error(t('options.alerts.failedToClearCache', { error: error.message }), { lang: toastLang() })
    }
  }

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e) => {
      if (!e.target.closest('.simple-header-menu')) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [menuOpen])

  const currentLanguage = languages.find(l => l.code === i18n.language)
  const CurrentFlag = currentLanguage ? currentLanguage.Flag : FlagGB
  const activeToggle = toggleOptions ? toggleOptions.findIndex(o => o.active) : -1

  return (
    <div
      className={cn(HEADER_BAR, 'flex items-center justify-between')}
      style={{ height: '40px', minHeight: '40px', maxHeight: '40px', padding: '0 12px' }}
    >
      {/* LEFT: Title/Version or Toggle */}
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-2">
        {/* Segmented Toggle (like LOCAL/REMOTE) */}
        {toggleOptions && toggleOptions.length > 0 ? (
          <div className="ov-kit">
            <SegmentedControl
              variant="pill"
              ariaLabel={t('refereeDashboard.view', 'View')}
              options={toggleOptions.map((option, idx) => ({ value: String(idx), label: option.label }))}
              value={activeToggle >= 0 ? String(activeToggle) : ''}
              onChange={(v) => toggleOptions[Number(v)]?.onClick?.()}
            />
          </div>
        ) : title ? (
          <span className={HEADER_TITLE}>
            {title}
          </span>
        ) : null}
      </div>

      {/* MIDDLE: Hamburger Menu */}
      <div className="simple-header-menu relative flex flex-none items-center justify-center">
        {/* Always show hamburger - at minimum has language, version, and clear cache */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen(!menuOpen)
          }}
          aria-expanded={menuOpen}
          className={cn(HEADER_BTN, 'min-w-11 px-3', menuOpen && HEADER_BTN_ON)}
          aria-label={t('header.menu')}
          title={t('header.menu')}
        >
          {menuOpen ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
        </button>

        {/* Dropdown Menu */}
        {menuOpen && (
          <>
            {/* Backdrop */}
            <div
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0"
              style={{ zIndex: 998 }}
            />
            <div
              className={cn('absolute left-1/2 top-full mt-1.5 flex w-max min-w-[220px] max-w-[280px] -translate-x-1/2 flex-col', MENU_PANEL)}
              style={{ zIndex: 1000 }}
            >
              {menuItems.map((item, index) => {
                // Divider
                if (item.divider) {
                  return <div key={`divider-${index}`} className={MENU_SEP} />
                }

                // Section header
                if (item.header) {
                  return (
                    <div key={`header-${index}`} className={MENU_SECTION}>
                      {item.header}
                    </div>
                  )
                }

                const tone = itemTone(item.color)
                const danger = tone.className === 'text-red-600'

                return (
                  <button
                    type="button"
                    key={index}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!item.disabled && item.onClick) {
                        item.onClick()
                      }
                      if (!item.keepOpen) {
                        setMenuOpen(false)
                      }
                    }}
                    disabled={item.disabled}
                    aria-pressed={item.active !== undefined ? !!item.active : undefined}
                    className={cn(
                      MENU_ROW,
                      danger ? MENU_ROW_DANGER : tone.className,
                      item.active && 'bg-stone-100 font-semibold'
                    )}
                    style={tone.style}
                  >
                    {item.icon && <span className={cn(MENU_ICON, tone.className || 'text-stone-400')}>{item.icon}</span>}
                    <span className="flex-1">{item.label}</span>

                    {/* Badge */}
                    {item.badge && (
                      <span className={MENU_COUNT}>
                        {item.badge}
                      </span>
                    )}

                    {/* Toggle switch: on/off that applies immediately (kit Switch look) */}
                    {item.toggle !== undefined && (
                      <SwitchTrack checked={!!item.toggle} className={item.toggle ? 'bg-emerald-500' : undefined} />
                    )}

                    {/* Submenu arrow */}
                    {item.submenu && (
                      <ChevronRight size={14} aria-hidden="true" className="text-stone-400" />
                    )}
                  </button>
                )
              })}

              {/* Language selector */}
              {menuItems.length > 0 && <div className={MENU_SEP} />}
              <button
                type="button"
                aria-expanded={languageExpanded}
                onClick={(e) => {
                  e.stopPropagation()
                  setLanguageExpanded(!languageExpanded)
                }}
                className={cn(MENU_ROW, languageExpanded && 'bg-stone-100')}
              >
                <span className={MENU_ICON}><CurrentFlag /></span>
                <span className="flex-1">{t('header.language', 'Language')}</span>
                <ChevronDown size={14} aria-hidden="true" className={cn('text-stone-400 transition-transform', languageExpanded && 'rotate-180')} />
              </button>

              {/* Language options */}
              {languageExpanded && (
                <div className={MENU_NEST}>
                  {languages.map((lang) => (
                    <button
                      type="button"
                      key={lang.code}
                      aria-pressed={i18n.language === lang.code}
                      onClick={(e) => {
                        e.stopPropagation()
                        i18n.changeLanguage(lang.code)
                        setLanguageExpanded(false)
                      }}
                      className={cn(MENU_SUBROW, i18n.language === lang.code && MENU_ROW_ON)}
                    >
                      <span className="flex w-5 items-center justify-center"><lang.Flag /></span>
                      <span>{lang.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Version info at bottom */}
              <div className={MENU_SEP} />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setVersionExpanded(!versionExpanded)
                }}
                className={cn(MENU_ROW, 'text-stone-500')}
              >
                <span className={MENU_ICON}><ClipboardIcon size={13} /></span>
                <span className="flex-1 tabular-nums">Version {currentVersion}</span>
              </button>

              {/* Clear Cache */}
              <div className={MENU_SEP} />
              {!confirmingClearCache ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmingClearCache(true)
                  }}
                  className={cn(MENU_ROW, MENU_ROW_DANGER)}
                >
                  <span className={cn(MENU_ICON, 'text-red-500')}><TrashIcon size={13} /></span>
                  <span className="flex-1">{t('options.clearCache', 'Clear Cache')}</span>
                </button>
              ) : (
                <div className="px-3 py-2">
                  <div className="mb-2 text-sm font-medium text-stone-800">
                    {t('options.clearCacheConfirm', 'Clear cache and reload?')}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmingClearCache(false)
                      }}
                      className={cn(HEADER_BTN, 'h-10 flex-1 border-stone-300 text-sm text-stone-700')}
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleClearCache()
                      }}
                      className={cn(HEADER_BTN, 'h-10 flex-1 border-red-600 bg-red-600 text-sm font-semibold text-white hover:bg-red-700')}
                    >
                      {t('common.yes', 'Yes')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* RIGHT: Fullscreen Button */}
      <div className="flex flex-1 basis-0 items-center justify-end gap-2">
        {onFullscreen && (
          <button
            type="button"
            onClick={onFullscreen}
            aria-pressed={isFullscreen}
            className={cn(HEADER_BTN, 'w-9 px-0', isFullscreen && HEADER_BTN_ON)}
            aria-label={isFullscreen ? t('header.exitFullscreen', 'Exit Fullscreen') : t('header.fullscreen', 'Fullscreen')}
            title={isFullscreen ? t('header.exitFullscreen', 'Exit Fullscreen') : t('header.fullscreen', 'Fullscreen')}
          >
            <Maximize size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
