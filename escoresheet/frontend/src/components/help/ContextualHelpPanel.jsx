import { useContext, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, CircleHelp, ExternalLink, LifeBuoy, VideoOff, X } from 'lucide-react'
import FAQItem from './FAQItem'
import { HELP_SCREENS, sectionsForScreen, sectionVideo, supportPageUrl, videoLanguage } from './helpSections'
import SupportFeedbackModal from '../SupportFeedbackModal'
import ScaleContext, { ScaleProvider } from '../../contexts/ScaleContext'
import { openAppWindow } from '../../utils/openAppWindow'
import { Button, FOCUS_RING } from '../../ui/Button.jsx'
import { IconButton } from '../../ui/IconButton.jsx'
import { cn } from '../../ui/cn.js'
import { backdropDismiss } from '../../ui/backdropDismiss.js'

// Above the dialogs a help button opens it over (ScorerMovedModal and
// ClosedOnServerModal are at 3000), and the support form above the panel
const PANEL_Z = 3100
const SUPPORT_Z = 3200

// Online as far as this device knows: the browser's network state and the
// scorer's Offline switch (App keeps it in localStorage). The videos stream
// from openvolley.app only then.
function readOnline() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  try {
    return localStorage.getItem('offlineMode') !== 'true'
  } catch {
    return true
  }
}

function useOnline(open) {
  const [online, setOnline] = useState(readOnline)
  useEffect(() => {
    const update = () => setOnline(readOnline())
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      window.removeEventListener('storage', update)
    }
  }, [])
  // the Offline switch of this tab fires no event: read again on opening
  useEffect(() => {
    if (open) setOnline(readOnline())
  }, [open])
  return online
}

// The bench and livescore pages have no ScaleProvider; the support form's
// layout hook needs one
function WithScale({ children }) {
  const scale = useContext(ScaleContext)
  return scale ? children : <ScaleProvider>{children}</ScaleProvider>
}

/** "More help": the section on openvolley.app/support, outside the app. */
function SupportPageLink({ id, children, className }) {
  const href = supportPageUrl(id)
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault()
        openAppWindow(href)
      }}
      className={className}
    >
      {children}
    </a>
  )
}

/**
 * The section's video, streamed from openvolley.app only while online:
 * offline, or when the file is not there (yet), a line and the link instead.
 * Nothing loads before Play (preload none); never autoplay. Subtitles in
 * every language, the app's own on by default.
 */
function HelpVideo({ id, title, online, lang }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const video = sectionVideo(id)

  // The poster is made with the video: when it is missing, so is the video.
  // A plain image request, so the box never shows a dead player.
  useEffect(() => {
    if (!online || typeof Image === 'undefined') return undefined
    let live = true
    const probe = new Image()
    probe.onerror = () => { if (live) setFailed(true) }
    probe.src = video.poster
    return () => {
      live = false
      probe.onerror = null
    }
  }, [online, video.poster])

  if (!online || failed) {
    return (
      <div data-testid="help-video-offline" className="mx-2 mb-2 flex items-start gap-2.5 rounded-lg bg-stone-50 px-3 py-2.5 text-xs leading-relaxed text-stone-600">
        <VideoOff size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-stone-400" />
        <span className="min-w-0">
          {online ? t('contextHelp.videoUnavailable') : t('contextHelp.videoOffline')}{' '}
          <SupportPageLink id={id} className="font-medium text-stone-800 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-500">
            {t('contextHelp.videoOnSite')}
          </SupportPageLink>
        </span>
      </div>
    )
  }

  return (
    <div className="px-2 pb-2">
      <video
        data-testid="help-video"
        className="aspect-video w-full rounded-lg bg-stone-900"
        controls
        preload="none"
        playsInline
        // the subtitle files come from openvolley.app: a cross-origin <track>
        // loads only as a CORS request
        crossOrigin="anonymous"
        poster={video.poster}
        src={video.src}
        aria-label={t('contextHelp.videoLabel', { section: title })}
        onError={() => setFailed(true)}
      >
        {video.tracks.map(track => (
          <track key={track.lang} kind="subtitles" srcLang={track.lang} label={track.label} src={track.src} default={track.lang === lang} />
        ))}
      </video>
    </div>
  )
}

// volleyui side sheet: white panel with a stone hairline and shadow-xl,
// eyebrow screen name under a text-base title, the round × close. Each of
// the screen's sections (helpSections.js) folds open: its video, its
// questions as flat rows with stone-100 dividers, More help and Contact
// support. The main section is open. Slides in from the right; Escape and
// the phone backdrop close it. A dialog while open (aria-modal): no scoring
// key acts under it, Android's Back closes it, and a kit dialog it was
// opened over leaves it the keyboard.
export default function ContextualHelpPanel({ open, onClose, screen, currentPage, onShowMe }) {
  const { t, i18n } = useTranslation()
  const titleId = useId()
  const panelRef = useRef(null)
  const screenId = screen || currentPage
  const sections = sectionsForScreen(screenId)
  const mainSection = sections[0]?.id || null
  const pageName = HELP_SCREENS[screenId] ? t(HELP_SCREENS[screenId].nameKey) : screenId
  const online = useOnline(open)
  const lang = videoLanguage(i18n?.language)
  const [openSections, setOpenSections] = useState(() => new Set(mainSection ? [mainSection] : []))
  // the section whose Contact support is open (its id is the form's area)
  const [supportArea, setSupportArea] = useState(null)

  // Each opening (and another screen) starts on the main section
  useEffect(() => {
    if (open) setOpenSections(new Set(mainSection ? [mainSection] : []))
  }, [open, screenId, mainSection])

  // The keyboard goes to the panel
  useEffect(() => {
    if (open) panelRef.current?.focus?.()
  }, [open])

  // ESC to close (the support form on top keeps it)
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !supportArea) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, supportArea])

  const toggleSection = (id) => setOpenSections(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <>
      {/* Backdrop - only on narrow screens to dismiss */}
      {open && (
        <div
          {...backdropDismiss(onClose)}
          className="no-print fixed inset-0 bg-slate-900/40"
          style={{
            zIndex: PANEL_Z - 1,
            display: window.innerWidth < 500 ? 'block' : 'none'
          }}
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={open ? 'true' : undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="help-panel"
        className="ov-kit no-print fixed bottom-0 right-0 top-0 flex flex-col border-l border-stone-200 bg-white text-stone-800 outline-none"
        style={{
          width: window.innerWidth < 500 ? '100%' : 360,
          zIndex: PANEL_Z,
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          // visibility follows the slide out, so the closed panel's rows leave
          // the tab order; on the way in it is visible at once (the keyboard
          // goes to the panel: hidden, it would not take the focus)
          transition: open ? 'transform 0.3s ease-out' : 'transform 0.3s ease-out, visibility 0.3s',
          visibility: open ? 'visible' : 'hidden',
          boxShadow: open ? '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)' : 'none'
        }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
          <div className="min-w-0">
            <div id={titleId} className="flex items-center gap-2 text-base font-bold text-stone-900">
              <CircleHelp size={18} className="shrink-0 text-stone-400" aria-hidden="true" />
              {t('contextHelp.helpButton', 'Help')}
            </div>
            <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400">
              {pageName}
            </div>
          </div>
          {/* data-modal-close: Android's Back closes the panel with it (appLifecycle.js) */}
          <IconButton variant="close" label={t('modal.close', 'Close')} icon={X} onClick={onClose} className="-mr-2" data-modal-close="" />
        </div>

        {/* The screen's sections */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {sections.length > 0 ? (
            <div className="space-y-1">
              {sections.map(section => {
                const expanded = openSections.has(section.id)
                const title = t(section.titleKey)
                return (
                  <section key={section.id} data-testid={`help-section-${section.id}`} aria-label={title}>
                    <button
                      type="button"
                      onClick={() => toggleSection(section.id)}
                      aria-expanded={expanded}
                      className={cn('flex min-h-12 w-full items-center justify-between gap-2 rounded-lg px-2 py-2.5 text-left text-sm font-semibold text-stone-900 transition-colors hover:bg-stone-50', expanded && 'bg-stone-50', FOCUS_RING)}
                    >
                      <span className="min-w-0">{title}</span>
                      <ChevronDown size={16} aria-hidden="true" className={cn('shrink-0 text-stone-400 transition-transform', expanded && 'rotate-180')} />
                    </button>
                    {expanded && (
                      <div className="pt-2 pb-1">
                        {open && <HelpVideo id={section.id} title={title} online={online} lang={lang} />}
                        <div className="divide-y divide-stone-100">
                          {section.faq.map(item => (
                            <FAQItem
                              key={item.questionKey}
                              questionKey={item.questionKey}
                              answerKey={item.answerKey}
                              helpId={item.helpId}
                              tooltipKey={item.tooltipKey}
                              onShowMe={onShowMe}
                            />
                          ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 px-2 pt-2 pb-3">
                          <SupportPageLink
                            id={section.id}
                            className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100', FOCUS_RING)}
                          >
                            <ExternalLink size={15} aria-hidden="true" className="text-stone-400" />
                            {t('contextHelp.moreHelp')}
                          </SupportPageLink>
                          <Button variant="secondary" size="sm" icon={LifeBuoy} onClick={() => setSupportArea(section.id)}>
                            {t('contextHelp.contactSupport')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          ) : (
            <div className="px-4 py-14 text-center text-sm font-medium text-stone-500">
              {t('contextHelp.noHelp', 'No help available for this page.')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-stone-100 px-4 py-3 text-center text-[11px] text-stone-400">
          OpenVolley eScoresheet
        </div>
      </div>

      {/* Contact support: the support form with the section as its area,
          above the panel and any dialog under it */}
      {supportArea && (
        <div style={{ position: 'relative', zIndex: SUPPORT_Z }}>
          <WithScale>
            <SupportFeedbackModal
              open={true}
              onClose={() => setSupportArea(null)}
              area={supportArea}
              currentPage={supportArea}
            />
          </WithScale>
        </div>
      )}
    </>
  )
}
