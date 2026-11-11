import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ArrowLeft, ClipboardList, FileText, House, KeyRound, Medal, ScrollText, Settings, ShieldCheck, Shirt, Trophy, Users } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { ConsoleShell, ConsolePanel, RowListCards, consoleHeaderBtn } from '../../ui'
import { PageLoadGate, PageSpinner } from './common'
import AccountsPanel from './AccountsPanel'
import InvitesPanel from './InvitesPanel'
import ClubsPanel from './ClubsPanel'
import MyClubPanel from './MyClubPanel'
import MyTeamsPanel from './MyTeamsPanel'
import SettingsPanel from './SettingsPanel'
import OfficialGamesPanel from './OfficialGamesPanel'
import ClosedMatchesPanel from './ClosedMatchesPanel'
import ScoresheetsPanel from './ScoresheetsPanel'
import AuditPanel from './AuditPanel'
import ActivityPanel from './ActivityPanel'
import SavedTeamsPanel from './SavedTeamsPanel'
import TournamentsPanel from './tournaments/TournamentsPanel'
import NotificationsBell from './NotificationsBell'
import { accessForApp } from '../../lib/access'
import { useManagerBrand } from '../../managerBrand'
import LegalLinks from '../../legal/LegalLinks'

// Each panel appears whole (owner 2026-11-11: "no race -> wait to load"):
// its first reads (usePanelData) behind the branded spinner (PageSpinner);
// later reloads keep the panel.
// A panel with sections of its own (My club, My teams) gates them itself.
function PanelGate({ children }) {
  return <PageLoadGate fallback={<PageSpinner />}>{children}</PageLoadGate>
}

const TABS = [
  { id: 'accounts', icon: Users, admin: true },
  { id: 'invites', icon: KeyRound, admin: true },
  // db/018: scorers score the home games of their own club (OpenVolley; the
  // OpenBeach brand's tab list leaves it out)
  { id: 'clubs', icon: House, admin: true },
  // db/020: a club manager's own club(s), whatever its roles (OpenVolley; the
  // OpenBeach brand's tab list leaves it out)
  { id: 'myclub', icon: House, clubManager: true },
  // db/023: the teams the account acts for (team managers, club managers),
  // whatever its roles (OpenVolley; the OpenBeach brand's tab list leaves it out)
  { id: 'myteams', icon: Shirt, teamManager: true },
  { id: 'games', icon: Trophy, admin: true },
  { id: 'matches', icon: ShieldCheck, admin: true },
  // every match's stored scoresheet PDF: admins and the sport's competition managers
  { id: 'scoresheets', icon: FileText, admin: false },
  { id: 'audit', icon: ScrollText, admin: true },
  // the scoring devices' activity log (db/016)
  { id: 'activity', icon: Activity, admin: true },
  { id: 'teams', icon: ClipboardList, admin: false },
  // OpenBeach only (plan phase T1): beach competition managers and the admin
  { id: 'tournaments', icon: Medal, admin: false, apps: ['beach'] },
  // db/021: OpenVolley's switches (send the final scoresheet), admins and
  // competition managers (the OpenBeach brand's tab list leaves it out)
  { id: 'settings', icon: Settings, admin: false, apps: ['indoor'] }
]

/**
 * The tabs an account sees: admins all of them, competition managers the
 * scoresheets and saved teams, club managers (access.managedClubs) My club,
 * team managers and club managers (access.managedTeams) My teams.
 * With a brand (src/managerBrand.js) only that brand's tabs, and the saved
 * teams by that app's role (OpenBeach: beach:competition_manager). Without
 * one (or OpenVolley's), exactly as before. A tab with `apps` (tournaments)
 * only in the console of those apps.
 */
export function manageTabsFor(access, brand = null) {
  if (!access) return []
  const own = accessForApp(access, brand?.app)
  return TABS
    .filter(tab => !brand?.tabs || brand.tabs.includes(tab.id))
    .filter(tab => !tab.apps || tab.apps.includes(brand?.app))
    .filter(tab => (tab.clubManager
      ? (access.managedClubs?.length > 0)
      : tab.teamManager
        ? (access.managedTeams?.length > 0)
        : tab.admin ? own.isAdmin : own.canManageTeams))
    .map(tab => tab.id)
}

/**
 * The manage console (admins and competition managers), full screen inside
 * the main app. Hiding tabs is cosmetic: every action is refused by the
 * server without the role.
 * `onClose` draws "Back to the app" (left out on manager.openvolley.app);
 * `headerActions` go before it in the header; `phoneTop` above the panel
 * below sm (what the phone's header has no room for).
 */
export default function ManageConsole({ tab, onTab, onClose, headerActions, phoneTop = null }) {
  const { t } = useTranslation()
  const { user, access } = useAuth()
  const brand = useManagerBrand()
  // the account lists, invites, audit and saved teams of this brand's app
  // (OpenVolley: ?app=indoor, OpenBeach: ?app=beach; saved teams only narrow for beach)
  const scope = brand.scope || undefined
  const allowed = useMemo(() => manageTabsFor(access, brand), [access, brand])
  // A tab's own page after a slash (My teams: '<team id>/<game number>', a
  // game's roster; owner 2026-11-10: "new page with url with the game id")
  // and every tab's pages the same way (usePanelRoute: competitions, teams,
  // clubs, people, accounts, games, matches, tournaments)
  const [tabId, ...tabRest] = String(tab || '').split('/')
  const current = allowed.includes(tabId) ? tabId : allowed[0]
  const subRoute = current === tabId ? tabRest.join('/') : ''
  // The page each tab was on: a hidden panel keeps it (and its unsaved
  // edits), and the tab's button opens it again
  const lastRoutes = useRef({})
  if (current) lastRoutes.current[current] = subRoute
  const routeOf = (id) => (id === current ? subRoute : lastRoutes.current[id] || '')
  const onRouteOf = (id) => (sub, opts) => onTab?.(sub ? `${id}/${sub}` : id, opts)
  const selectTab = (id) => {
    const last = lastRoutes.current[id]
    onTab?.(last && id !== current ? `${id}/${last}` : id)
  }
  // a page of another tab (a team of My club in My teams, say); null when this account has no such tab
  const navigate = (path, opts = { push: true }) => {
    const id = String(path || '').split('/')[0]
    if (!allowed.includes(id)) return false
    onTab?.(path, opts)
    return true
  }
  const canOpen = (id) => allowed.includes(id)
  const pageProps = (id) => ({ route: routeOf(id), onRoute: onRouteOf(id), navigate, canOpen })
  // Panels mount on first visit and then stay mounted (ConsolePanel); kept
  // during render, so the tab opened draws in the same frame (not one empty)
  const visitedRef = useRef(null)
  if (!visitedRef.current) visitedRef.current = new Set()
  if (current) visitedRef.current.add(current)
  const visited = visitedRef.current
  // "Activity" on a match (matches tab): the activity tab, filtered to it (#activity/<match>)
  const showActivity = allowed.includes('activity')
    ? (ext) => onTab?.(`activity/${encodeURIComponent(ext)}`, { push: true })
    : null
  if (!user || allowed.length === 0) {
    return (
      <div className="ov-kit flex min-h-screen flex-col items-center justify-center gap-4 bg-stone-100 p-6 text-center">
        <p className="text-sm text-stone-600">{t('manage.errors.forbidden')}</p>
        {onClose && (
          <button type="button" className={consoleHeaderBtn} onClick={onClose}>
            <ArrowLeft size={14} aria-hidden />{t('manage.backToApp')}
          </button>
        )}
      </div>
    )
  }

  const tabs = TABS.filter(x => allowed.includes(x.id)).map(x => ({
    id: x.id,
    label: t(`manage.tabs.${x.id}`),
    icon: <x.icon size={15} aria-hidden />
  }))

  // Above the scorer app's header (MainHeader, z 1000): at 900 it covered the
  // console's own header row, logo and "Back to the app" (owner 2026-10-24,
  // "cut off at the top"). Opened from the app (onClose), the console is a
  // dialog: Android Back leaves it like any other (appLifecycle closeOpenDialog).
  const inApp = !!onClose
  return (
    <div
      className="ov-kit fixed inset-0 z-[1100] overflow-y-auto bg-stone-100"
      data-testid="manage-console"
      {...(inApp ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('manage.title') } : {})}
    >
      <ConsoleShell
        // smaller on phones: the header's buttons (the bell too) fit at 360 px
        logo={<img src={brand.lockup} alt={brand.name} className="ov-ink h-[22px] w-auto sm:h-7" />}
        eyebrow={t('manage.title')}
        actions={<>
          {/* db/028: who signed up (admins, and the approvers of its requests) */}
          <NotificationsBell app={brand.app} onOpen={(target) => navigate(target, { push: true })} />
          {headerActions}
          {onClose && (
            <button type="button" className={consoleHeaderBtn} onClick={onClose} aria-label={t('manage.backToApp')} data-modal-close>
              <ArrowLeft size={14} aria-hidden />
              <span className="hidden sm:inline">{t('manage.backToApp')}</span>
            </button>
          )}
        </>}
        tabs={tabs}
        current={current}
        onSelect={selectTab}
        navLabel={t('manage.nav')}
        footer={<LegalLinks className="text-[11px] text-stone-400" />}
      >
        {phoneTop && <div className="mb-3 sm:hidden">{phoneTop}</div>}
        {/* every list of the console: one card per item (owner 2026-11-10) */}
        <RowListCards.Provider value>
        {visited.has('accounts') && <ConsolePanel id="accounts" current={current}><PanelGate><AccountsPanel selfId={user.id} selfIsSuperAdmin={!!access?.isSuperAdmin} app={scope} {...pageProps('accounts')} /></PanelGate></ConsolePanel>}
        {visited.has('invites') && <ConsolePanel id="invites" current={current}><PanelGate><InvitesPanel app={scope} /></PanelGate></ConsolePanel>}
        {visited.has('clubs') && <ConsolePanel id="clubs" current={current}><PanelGate><ClubsPanel {...pageProps('clubs')} /></PanelGate></ConsolePanel>}
        {visited.has('myclub') && <ConsolePanel id="myclub" current={current}><PanelGate><MyClubPanel clubs={access.managedClubs} {...pageProps('myclub')} /></PanelGate></ConsolePanel>}
        {visited.has('myteams') && <ConsolePanel id="myteams" current={current}><PanelGate><MyTeamsPanel teams={access.managedTeams} {...pageProps('myteams')} /></PanelGate></ConsolePanel>}
        {visited.has('settings') && <ConsolePanel id="settings" current={current}><PanelGate><SettingsPanel /></PanelGate></ConsolePanel>}
        {visited.has('games') && <ConsolePanel id="games" current={current}><PanelGate><OfficialGamesPanel {...pageProps('games')} /></PanelGate></ConsolePanel>}
        {visited.has('matches') && <ConsolePanel id="matches" current={current}><PanelGate><ClosedMatchesPanel onShowActivity={showActivity} {...pageProps('matches')} /></PanelGate></ConsolePanel>}
        {visited.has('scoresheets') && <ConsolePanel id="scoresheets" current={current}><PanelGate><ScoresheetsPanel app={brand.app} /></PanelGate></ConsolePanel>}
        {visited.has('audit') && <ConsolePanel id="audit" current={current}><PanelGate><AuditPanel app={scope} /></PanelGate></ConsolePanel>}
        {visited.has('activity') && <ConsolePanel id="activity" current={current}><PanelGate><ActivityPanel app={scope} initialMatch={(() => { try { return decodeURIComponent(routeOf('activity')) } catch { return routeOf('activity') } })()} /></PanelGate></ConsolePanel>}
        {visited.has('teams') && <ConsolePanel id="teams" current={current}><PanelGate><SavedTeamsPanel userId={user.id} sport={scope} {...pageProps('teams')} /></PanelGate></ConsolePanel>}
        {visited.has('tournaments') && <ConsolePanel id="tournaments" current={current}><PanelGate><TournamentsPanel {...pageProps('tournaments')} /></PanelGate></ConsolePanel>}
        </RowListCards.Provider>
      </ConsoleShell>
    </div>
  )
}
