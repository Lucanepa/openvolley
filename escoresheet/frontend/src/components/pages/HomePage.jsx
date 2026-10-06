import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import SupportFeedbackModal from '../SupportFeedbackModal'
import UserButton from '../auth/UserButton'
import { ChevronDown, Download, LifeBuoy, Loader2, Settings } from 'lucide-react'
import { Button, Card, cn, FOCUS_RING, FOCUS_RING_INSET } from '../../ui'

const RELEASES_PAGE = 'https://github.com/Lucanepa/openvolley/releases'
const RELEASES_API = 'https://api.github.com/repos/Lucanepa/openvolley/releases?per_page=20'

function detectDesktopOS() {
  const ua = navigator.userAgent
  if (/android|iphone|ipad|ipod|mobile|tablet/i.test(ua)) return null
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux/i.test(ua)) return 'linux'
  return null
}

// Already running inside the Electron/Tauri desktop app — no point offering the download.
function isInsideDesktopApp() {
  return typeof window !== 'undefined' &&
    (!!window.electronAPI || !!window.__TAURI__ || !!window.__TAURI_INTERNALS__)
}

export default function HomePage({
  favicon,
  newMatchMenuOpen,
  setNewMatchMenuOpen,
  createNewOfficialMatch,
  createNewTestMatch,
  testMatchLoading,
  currentOfficialMatch,
  currentTestMatch,
  continueMatch,
  continueTestMatch,
  showDeleteMatchModal,
  restartTestMatch,
  onOpenSettings,
  onRestoreMatch
}) {
  const { t } = useTranslation()
  const [supportFeedbackOpen, setSupportFeedbackOpen] = useState(false)
  const desktopOS = useMemo(() => detectDesktopOS(), [])
  const inDesktopApp = useMemo(() => isInsideDesktopApp(), [])

  // Direct installer links from the newest desktop-v* GitHub release. On any
  // failure (offline, rate limit, no release yet) the section falls back to
  // linking the releases page.
  const [desktopApp, setDesktopApp] = useState(null)
  useEffect(() => {
    if (!desktopOS || inDesktopApp) return
    let cancelled = false
    fetch(RELEASES_API)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(releases => {
        if (cancelled || !Array.isArray(releases)) return
        const rel = releases.find(r => !r.draft && !r.prerelease && r.tag_name?.startsWith('desktop-v'))
        if (!rel) return
        const asset = ext => rel.assets?.find(a => a.name?.toLowerCase().endsWith(ext))?.browser_download_url
        setDesktopApp({
          version: rel.tag_name.replace('desktop-v', ''),
          exe: asset('.exe'),
          appimage: asset('.appimage'),
          deb: asset('.deb'),
          page: rel.html_url
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [desktopOS, inDesktopApp])

  return (
    <div className="ov-kit flex w-full flex-1 flex-col items-center justify-center px-4 py-6 sm:py-8">
      <div className="w-full max-w-md">
        <h1 className="text-center text-2xl sm:text-3xl font-bold tracking-tight text-stone-900">{t('home.title')}</h1>
        <div className="my-4 flex justify-center">
          <img src={`${import.meta.env.BASE_URL}openvolley_no_bg.png`} alt="Openvolley" className="h-28 w-auto sm:h-32" />
        </div>

        <Card className="w-full space-y-3">
          {/* New Match button with its menu (pushes the stack down) */}
          <div className="space-y-2">
            <Button
              variant="primary"
              block
              data-help-id="home-new-match-button"
              aria-expanded={newMatchMenuOpen}
              onClick={() => setNewMatchMenuOpen(!newMatchMenuOpen)}
              className="h-14 rounded-xl text-base font-semibold"
              iconRight={<ChevronDown size={18} aria-hidden="true" className={cn('transition-transform', newMatchMenuOpen && 'rotate-180')} />}
            >
              {t('home.newMatch')}
            </Button>

            {newMatchMenuOpen && (
              // Flat sunken block under the CTA: no border, no shadow inside the Card.
              <div className="overflow-hidden rounded-xl bg-stone-50 divide-y divide-stone-200/70">
                <button
                  type="button"
                  onClick={() => {
                    setNewMatchMenuOpen(false)
                    createNewOfficialMatch()
                  }}
                  className={cn('w-full min-h-12 inline-flex items-center justify-center gap-3 px-4 py-3 text-base font-semibold text-stone-800 hover:bg-stone-100 transition-colors', FOCUS_RING_INSET)}
                >
                  {t('home.officialMatch')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewMatchMenuOpen(false)
                    createNewTestMatch()
                  }}
                  disabled={testMatchLoading}
                  aria-busy={testMatchLoading || undefined}
                  className={cn('w-full min-h-12 inline-flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold text-amber-800 hover:bg-amber-50 transition-colors disabled:cursor-not-allowed disabled:opacity-60', FOCUS_RING_INSET)}
                >
                  {testMatchLoading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                  {testMatchLoading ? t('home.preparing') : t('home.testMatch')}
                </button>
              </div>
            )}
          </div>

          {/* Continue Match - only when there is a match */}
          {(currentOfficialMatch || currentTestMatch) && (
            <Button
              variant="dark"
              block
              data-help-id="home-continue-button"
              onClick={() => {
                if (currentOfficialMatch) {
                  continueMatch(currentOfficialMatch.id)
                } else if (currentTestMatch) {
                  continueTestMatch()
                }
              }}
              className="h-14 rounded-xl text-base font-semibold"
            >
              {t('home.continueMatch')}
            </Button>
          )}

          {/* Delete Match - only when there is a match */}
          {(currentOfficialMatch || currentTestMatch) && (
            <Button
              variant="danger-soft"
              block
              data-help-id="home-delete-button"
              onClick={() => {
                if (currentOfficialMatch) {
                  showDeleteMatchModal()
                } else if (currentTestMatch) {
                  restartTestMatch()
                }
              }}
              className="h-12 rounded-xl text-base shadow-none"
            >
              {t('home.deleteMatch')}
            </Button>
          )}

          {/* Restore Match */}
          <Button
            variant="secondary"
            block
            data-help-id="home-restore-button"
            onClick={onRestoreMatch}
            className="h-12 rounded-xl text-base"
          >
            {t('home.restoreMatch')}
          </Button>

          {/* Game PIN (if any) */}
          {currentOfficialMatch?.gamePin && (
            <div className="rounded-xl border border-stone-200/70 bg-stone-50/60 px-4 py-3 text-center">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">{t('home.gamePin')}</div>
              <div className="mt-0.5 font-mono text-xl font-bold tracking-[0.3em] tabular-nums text-stone-900">
                {currentOfficialMatch.gamePin}
              </div>
            </div>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="xl" block onClick={onOpenSettings} icon={Settings}>
            {t('home.options')}
          </Button>
          <Button variant="ghost" size="xl" block onClick={() => setSupportFeedbackOpen(true)} icon={LifeBuoy} className="bg-white">
            {t('supportFeedback.button')}
          </Button>
        </div>

        {/* Downloads (desktop app + server) - desktop browsers only, hidden inside the app */}
        {desktopOS && !inDesktopApp && (() => {
          const appHref =
            (desktopOS === 'windows' && desktopApp?.exe) ||
            (desktopOS === 'linux' && desktopApp?.appimage) ||
            desktopApp?.page || RELEASES_PAGE
          const appLabel = t('home.downloadApp', 'Download the desktop app — offline scoretable + tablet server') +
            (desktopApp?.version ? ` (v${desktopApp.version})` : '')
          const quietLink = 'text-xs text-stone-600 underline decoration-stone-300 underline-offset-2 hover:text-stone-800 hover:decoration-stone-500 transition-colors'
          return (
            <div className="mt-5 flex flex-col items-center gap-2 text-center">
              <a
                href={appHref}
                target="_blank"
                rel="noopener noreferrer"
                className={cn('inline-flex min-h-11 max-w-full items-start gap-2 rounded-lg px-2 py-2.5 text-left text-sm text-stone-600 hover:text-stone-900 transition-colors', FOCUS_RING)}
              >
                <Download size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-stone-400" />
                <span>{appLabel}</span>
              </a>
              {desktopOS === 'linux' && desktopApp?.deb && (
                <a href={desktopApp.deb} target="_blank" rel="noopener noreferrer" className={quietLink}>
                  {t('home.downloadAppDeb', 'or get the .deb package')}
                </a>
              )}
              <a href={RELEASES_PAGE} target="_blank" rel="noopener noreferrer" className={quietLink}>
                {t('home.downloadServer', 'Download server — referee without internet')}
              </a>
            </div>
          )
        })()}

        {/* Support & Feedback Modal */}
        <SupportFeedbackModal
          open={supportFeedbackOpen}
          onClose={() => setSupportFeedbackOpen(false)}
          currentPage="mainPage"
        />
      </div>
    </div>
  )
}
