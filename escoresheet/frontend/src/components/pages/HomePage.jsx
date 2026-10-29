import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import SupportFeedbackModal from '../SupportFeedbackModal'
import LoginModal from '../auth/LoginModal'
import PendingApprovalBanner from '../auth/PendingApprovalBanner'
import CloudBlockNotice from '../CloudBlockNotice'
import { Download, LifeBuoy, Loader2, LogIn, Settings } from 'lucide-react'
import { Button, Card, cn, dayLabel, FOCUS_RING, Notice, Row, RowList, RowTool, SectionHeader, StatusPill } from '../../ui'
import { duplicateGameNumbers } from '../../utils/deviceMatches'
import { formatTakeOver, scoreText } from '../ScorerMovedModal'
import { isServedFromLocalServer } from '../../utils/backendConfig'
import { BRAND } from '../../brand'

const RELEASES_PAGE = 'https://github.com/Lucanepa/openvolley/releases'
const RELEASES_API = 'https://api.github.com/repos/Lucanepa/openvolley/releases?per_page=20'

// "desktop-v2.4.10" -> [2, 4, 10]. GitHub does not list the releases newest
// first (desktop-v2.4.9 came before desktop-v2.4.10), so the newest is the
// highest version, compared number by number.
const desktopVersion = tag => tag.slice('desktop-v'.length).split('.').map(n => parseInt(n, 10) || 0)
function isHigherVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}
export function newestDesktopRelease(releases) {
  return releases
    .filter(r => !r.draft && !r.prerelease && r.tag_name?.startsWith('desktop-v'))
    .reduce((best, r) => (!best || isHigherVersion(desktopVersion(r.tag_name), desktopVersion(best.tag_name)) ? r : best), null)
}

function detectDesktopOS() {
  const ua = navigator.userAgent
  if (/android|iphone|ipad|ipod|mobile|tablet/i.test(ua)) return null
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux/i.test(ua)) return 'linux'
  return null
}

// Already running inside the Electron/Tauri desktop app, or served by a local
// relay (the desktop app's own window loads http://localhost:5173 from it, and
// venue tablets/laptops have no internet) — no point offering the download.
function isInsideDesktopApp() {
  return typeof window !== 'undefined' &&
    (!!window.electronAPI || !!window.__TAURI__ || !!window.__TAURI_INTERNALS__ ||
      isServedFromLocalServer())
}

/**
 * The home screen (owner plan 2026-10-29, step 3). What a new match can be
 * follows the sign-in:
 *   - signed out where sign-in exists: Test match and Easy match only (never
 *     on the cloud), and a way to sign in for official games;
 *   - signed in: Official game first (today's home games of the account's
 *     clubs, or typed in: App's onOfficialGame), Test and Easy below;
 *   - no sign-in at all (offline mode, no cloud: the desktop app offline, a
 *     venue box): Official game typed in, as before, Test and Easy below.
 * The Continue card and the device's open matches always stay: a session
 * that ran out never strands a match being recorded.
 */
export default function HomePage({
  signedIn = false,
  signInAvailable = false,
  onOfficialGame,
  createNewTestMatch,
  testMatchLoading,
  createEasyMatch,
  easyMatchLoading = false,
  currentOfficialMatch,
  currentTestMatch,
  deviceMatches,
  continueMatch,
  continueTestMatch,
  showDeleteMatchModal,
  restartTestMatch,
  onOpenSettings,
  onRestoreMatch,
  // what the self-check found (App, SelfCheckNotice)
  selfCheckNotice = null,
  // the match Continue resumes (App): { home, away, score, lastSaved, state, unsent }
  continueInfo = null
}) {
  const { t, i18n } = useTranslation()
  const [supportFeedbackOpen, setSupportFeedbackOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  // Signed out where an account could sign in: no official game here
  const testOnly = signInAvailable && !signedIn
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
        const rel = newestDesktopRelease(releases)
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
    // Small vertical pad: the panel and the container around it pad already,
    // and the column is centred, so the pad only counts when it overflows.
    // A short window gets a smaller lockup (home-short); a wide but short one
    // (the desktop app's window, a laptop, a phone on its side) two columns,
    // brand and downloads left, the actions right (home-wide, tailwind.css).
    <div className="ov-kit flex w-full flex-1 flex-col items-center justify-center px-4 py-2">
      <div className="w-full max-w-md home-wide:grid home-wide:max-w-4xl home-wide:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] home-wide:grid-rows-[1fr_auto_auto_1fr] home-wide:gap-x-12">
        <div className="home-wide:col-start-1 home-wide:row-start-2">
          <h1 className="text-center text-2xl sm:text-3xl font-bold tracking-tight text-stone-900">{t('home.title')}</h1>
          <div className="my-4 flex justify-center home-short:my-2">
            <img src={BRAND.lockupStacked} alt="OpenVolley" className="ov-ink h-24 w-auto sm:h-28 home-short:h-16 sm:home-short:h-16" />
          </div>
        </div>

        <div className="home-wide:col-start-2 home-wide:row-span-4 home-wide:row-start-1 home-wide:self-center">
        <PendingApprovalBanner className="mb-4" />
        {selfCheckNotice}

        <Card className="w-full space-y-3">
          {/* Continue: the match in progress on this device, first and in one
              tap. Opening the app always lands here, never on a match (the
              owner, 2026-10-27, as the established e-scoresheets do): the
              card says which match, where it stands, when it was last saved
              and what the server said about it, so the scorer resumes the
              right one, and sees a copy closed on the server or scored on
              another device before opening it (read-only then). */}
          {(currentOfficialMatch || currentTestMatch) && (
            <div data-testid="continue-card" className="space-y-3 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
              {continueInfo && (
                <div className="px-1">
                  <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                    <span className="min-w-0 text-base font-semibold leading-snug text-stone-900">
                      {`${continueInfo.home || t('home.deviceMatches.home')} – ${continueInfo.away || t('home.deviceMatches.away')}`}
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <MatchStateChips state={continueInfo.state} unsent={continueInfo.unsent} />
                    </span>
                  </div>
                  <div className="mt-1 text-xl font-bold tabular-nums text-stone-900">{scoreText(t, continueInfo.score)}</div>
                  {continueInfo.lastSaved != null && (
                    <div className="mt-0.5 text-xs tabular-nums text-stone-500">
                      {t('home.continueCard.lastSaved', { time: formatTakeOver(continueInfo.lastSaved, i18n?.language) || '–' })}
                    </div>
                  )}
                </div>
              )}
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
            </div>
          )}

          {/* New match: Official game first when it can be scored here,
              Test and Easy below it (signed out: those two only) */}
          {!testOnly && (
            <Button
              variant="primary"
              block
              data-help-id="home-official-button"
              onClick={onOfficialGame}
              className="h-14 rounded-xl text-base font-semibold"
            >
              {t('home.officialMatch')}
            </Button>
          )}
          <div className={cn('grid gap-2', createEasyMatch && 'grid-cols-2')}>
            <Button
              variant={testOnly ? 'primary' : 'secondary'}
              block
              data-help-id="home-test-button"
              onClick={createNewTestMatch}
              disabled={testMatchLoading}
              aria-busy={testMatchLoading || undefined}
              className={cn('rounded-xl text-base font-semibold', testOnly ? 'h-14' : 'h-12')}
            >
              {testMatchLoading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {testMatchLoading ? t('home.preparing') : t('home.testMatch')}
            </Button>
            {createEasyMatch && (
              <Button
                variant="secondary"
                block
                data-help-id="home-easy-button"
                onClick={createEasyMatch}
                disabled={easyMatchLoading || testMatchLoading}
                aria-busy={easyMatchLoading || undefined}
                title={t('home.easyMatchHint', 'Unofficial · no rosters or signatures')}
                className={cn('rounded-xl text-base font-semibold', testOnly ? 'h-14' : 'h-12')}
              >
                {easyMatchLoading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {t('home.easyMatch', 'Easy match')}
              </Button>
            )}
          </div>
          {testOnly && (
            <div className="rounded-xl bg-stone-50 px-3 py-3 text-center" data-testid="home-sign-in-note">
              <p className="text-sm text-stone-600">{t('home.signInForOfficial')}</p>
              <Button variant="secondary" size="xl" icon={LogIn} onClick={() => setLoginOpen(true)} className="mt-2" data-testid="home-sign-in">
                {t('auth.login', 'Login')}
              </Button>
            </div>
          )}

          {/* The server refused this match for good (pending account, game
              already scored by someone else, closed): say why */}
          {currentOfficialMatch?.cloudBlock && <CloudBlockNotice match={currentOfficialMatch} />}

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

          {/* Restore Match: always, signed out too (a scorer whose device
              broke gets the match back with its game PIN or a backup file) */}
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

        {/* Two or more open official matches: the buttons above only reach the
            newest, this list reaches each one (utils/deviceMatches.js) */}
        {deviceMatches?.length > 1 && (
          <DeviceMatchList matches={deviceMatches} onContinue={continueMatch} onDelete={showDeleteMatchModal} />
        )}

        {/* One above the other on a phone: side by side, "Support & feedback"
            broke onto two lines beside its icon */}
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
          <Button variant="secondary" size="xl" block onClick={onOpenSettings} icon={Settings}>
            {t('home.options')}
          </Button>
          <Button variant="ghost" size="xl" block onClick={() => setSupportFeedbackOpen(true)} icon={LifeBuoy} className="bg-white">
            {t('supportFeedback.button')}
          </Button>
        </div>
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
            <div className="mt-5 flex flex-col items-center gap-2 text-center home-wide:col-start-1 home-wide:row-start-3 home-wide:mt-2">
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
        {testOnly && <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />}
      </div>
    </div>
  )
}

const STATUS_PILL_TONE = { scheduled: 'neutral', live: 'planned', ended: 'todo', approved: 'todo' }

// What the server said about a copy (utils/deviceSelfCheck copyState), and
// whether it holds changes the server does not have yet
const MATCH_STATE_TONE = { here: 'done', moved: 'attention', closed: 'brand', unchecked: 'neutral' }

function MatchStateChips({ state, unsent = 0 }) {
  const { t } = useTranslation()
  return (
    <>
      {state && (
        <span data-testid="match-state" className="inline-flex">
          <StatusPill tone={MATCH_STATE_TONE[state] || 'neutral'}>{t(`home.matchState.${state}`)}</StatusPill>
        </span>
      )}
      {unsent > 0 && (
        <span data-testid="match-state" className="inline-flex">
          <StatusPill tone="todo">{t('home.matchState.unsent')}</StatusPill>
        </span>
      )}
    </>
  )
}

function DeviceMatchList({ matches, onContinue, onDelete }) {
  const { t } = useTranslation()
  const twice = duplicateGameNumbers(matches)
  return (
    <Card className="w-full" aria-labelledby="device-matches-title">
      <SectionHeader as="h2" title={<span id="device-matches-title">{t('home.deviceMatches.title')}</span>} count={matches.length} />
      {[...twice].map(game => (
        <Notice key={game} tone="warning" className="mt-3">{t('home.deviceMatches.duplicateNotice', { game })}</Notice>
      ))}
      <RowList className="mt-1">
        {matches.map(m => {
          // the same game twice, or two copies of one match (the self-check)
          const duplicate = (!!m.gameN && twice.has(m.gameN)) || m.duplicate === true
          const title = m.home || m.away
            ? `${m.home || t('home.deviceMatches.home')} – ${m.away || t('home.deviceMatches.away')}`
            : t('home.deviceMatches.noTeams')
          return (
            <Row
              key={m.id}
              tone={duplicate ? 'amber' : 'stone'}
              title={title}
              meta={
                <>
                  {m.gameN && <span className="tabular-nums">{t('home.deviceMatches.game', { game: m.gameN })}</span>}
                  {m.createdAt && <span className="tabular-nums">{dayLabel(m.createdAt, { year: true })}</span>}
                  {m.cloudBlock && <span>{t('home.deviceMatches.notSynced')}</span>}
                </>
              }
              // on their own line under the title: beside it they squeezed
              // the team names on a phone
              chips={
                <>
                  <StatusPill tone={STATUS_PILL_TONE[m.status] || 'neutral'}>
                    {t(`home.deviceMatches.status.${m.status}`, { defaultValue: t('home.deviceMatches.status.scheduled') })}
                  </StatusPill>
                  {duplicate && <StatusPill tone="attention">{t('home.deviceMatches.sameGame')}</StatusPill>}
                  <MatchStateChips state={m.state} unsent={m.unsent} />
                </>
              }
              toolsIndent="pl-[0.875rem] sm:pl-[1.125rem]"
              tools={
                <>
                  <RowTool primary onClick={() => onContinue(m.id)}>{t('home.deviceMatches.continue')}</RowTool>
                  <RowTool className="text-red-700 hover:bg-red-50" onClick={() => onDelete(m.id)}>{t('home.deviceMatches.delete')}</RowTool>
                </>
              }
            />
          )
        })}
      </RowList>
    </Card>
  )
}
