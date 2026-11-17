import { Suspense, lazy, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ArrowLeft, CircleHelp, ClipboardList, Database, FileText, SquareTerminal, House, KeyRound, Medal, ScrollText, Settings, ShieldCheck, Shirt, Trophy, Users } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { ConsoleShell, ConsolePanel, RowListCards, cn, consoleHeaderBtn } from '../../ui'
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
import DataPanel from './DataPanel'
// the SQL tab brings the code editor (CodeMirror): loaded when the tab first opens
const SqlPanel = lazy(() => import('./sql/SqlPanel'))
import SavedTeamsPanel from './SavedTeamsPanel'
import TournamentsPanel from './tournaments/TournamentsPanel'
import NotificationsBell from './NotificationsBell'
import { accessForApp } from '../../lib/access'
import { useManagerBrand } from '../../managerBrand'
import LegalLinks from '../../legal/LegalLinks'
import ContextualHelpPanel from '../help/ContextualHelpPanel'
import { manageHelpScreen } from '../help/helpSections'

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
  { id: 'settings', icon: Settings, admin: false, apps: ['indoor'] },
  // every table of the database, one row at a time (lib/dataAdmin.js): super
  // admins only (a generic editor can change any role); the OpenBeach brand's
  // tab list leaves it out
  { id: 'data', icon: Database, superAdmin: true },
  // a Postgres console (lib/sqlWorkspace.js): super admins only, like Data
  { id: 'sql', icon: SquareTerminal, superAdmin: true }
]

/**
 * The tabs an account sees: admins all of them (Data: super admins only), competition managers the
 * scoresheets and saved teams, club managers (access.managedClubs) My club,
 * team managers and club managers (access.managedTeams) My teams.
 * With a brand (src/managerBrand.js) only that brand's tabs, and the saved
 * teams by that app's role (OpenBeach: beach:competition_manager). Without
 * one (or OpenVolley's), exactly as before. A tab with `apps` (tournaments)
 * only in the console of those apps.
 */
// My club is a tree (owner 2026-11-15): its own page (the contact address) and
// one page per part, #myclub/<club id>/<part>; a person of the licence lists
// is a page of Licences (#myclub/<club id>/person/<id>)
export const MYCLUB_PARTS = ['requests', 'members', 'teams', 'licences', 'invites', 'api']
const partOf = (route) => {
  const kind = String(route || '').split('/')[1] || ''
  return kind === 'person' ? 'licences' : MYCLUB_PARTS.includes(kind) ? kind : ''
}

// My teams is a tree too: the team's own page shows everything, and each part
// has its own page, #myteams/<team id>/<part> (a game's roster is
// #myteams/<team id>/<game number>)
export const MYTEAMS_PARTS = ['requests', 'squad', 'games']
const teamPartOf = (route) => {
  const kind = String(route || '').split('/')[1] || ''
  return MYTEAMS_PARTS.includes(kind) ? kind : ''
}

// The list tabs are trees by their filter (owner 2026-11-17: "tree nav for
// all"): the first is the default. The filter is part of the URL as
// #<tab>/@<filter>[/<page>], so a page of a tab keeps it and a link opens it.
const FILTER_CHILDREN = {
  accounts: { options: ['pending', 'all'], label: (t, id, extra) => id === 'pending' && extra?.pending ? `${t('manage.accounts.filterPending')} (${extra.pending})` : t(id === 'pending' ? 'manage.accounts.filterPending' : 'manage.accounts.filterAll') },
  matches: { options: ['closed', 'open', 'all'], label: (t, id) => t(`manage.matches.filter${id[0].toUpperCase()}${id.slice(1)}`) },
  scoresheets: { options: ['all', 'closed', 'open'], label: (t, id) => t(`manage.matches.filter${id[0].toUpperCase()}${id.slice(1)}`) },
  // the sport switch of Saved teams (OpenBeach's console has no indoor)
  teams: { options: ['indoor', 'beach'], label: (t, id) => t(id === 'indoor' ? 'savedTeams.sportIndoor' : 'savedTeams.sportBeach'), when: (brand) => brand?.app !== 'beach' }
}
const filterSplit = (id, subRoute) => {
  const spec = FILTER_CHILDREN[id]
  if (!spec) return { filter: '', rest: subRoute }
  const [first = '', ...more] = String(subRoute || '').split('/')
  const name = first.startsWith('@') ? first.slice(1) : ''
  return { filter: spec.options.includes(name) ? name : spec.options[0], rest: name ? more.join('/') : subRoute, explicit: !!name }
}

export function manageTabsFor(access, brand = null) {
  if (!access) return []
  const own = accessForApp(access, brand?.app)
  return TABS
    .filter(tab => !brand?.tabs || brand.tabs.includes(tab.id))
    .filter(tab => !tab.apps || tab.apps.includes(brand?.app))
    .filter(tab => (tab.superAdmin
      ? !!access.isSuperAdmin
      : tab.clubManager
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
  // waiting sign-ups, reported by the accounts panel, for the tree's Pending label
  const [pendingAccounts, setPendingAccounts] = useState(null)
  // the account lists, invites, audit and saved teams of this brand's app
  // (OpenVolley: ?app=indoor, OpenBeach: ?app=beach; saved teams only narrow for beach)
  const scope = brand.scope || undefined
  const allowed = useMemo(() => manageTabsFor(access, brand), [access, brand])
  // The "?" (OpenVolley's console only: the help is the indoor app's)
  const [helpOpen, setHelpOpen] = useState(false)
  const hasHelp = brand.app === 'indoor'
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
  const routeOf = (id) => filterSplit(id, id === current ? subRoute : lastRoutes.current[id] || '').rest
  const onRouteOf = (id) => (sub, opts) => {
    // a list tab keeps its filter in the URL (FILTER_CHILDREN)
    const f = id === current ? filterSplit(id, subRoute) : { explicit: false }
    const base = f.explicit ? `${id}/@${f.filter}` : id
    onTab?.(sub ? `${base}/${sub}` : base, opts)
  }
  const selectTab = (id) => {
    const last = lastRoutes.current[id]
    // the open tab's own button is its own page: My club's first page, not the part it was on
    if (id === 'myclub' && id === current) {
      const club = subRoute.split('/')[0]
      onTab?.(club ? `myclub/${club}` : 'myclub')
      return
    }
    onTab?.(last && id !== current ? `${id}/${last}` : id)
  }
  const filterOf = (id) => filterSplit(id, id === current ? subRoute : lastRoutes.current[id] || '').filter
  const myClubId = () => subRoute.split('/')[0] || access.managedClubs?.[0]?.id || ''
  const selectChild = (id, child) => {
    if (id === 'myclub') onTab?.(`myclub/${encodeURIComponent(myClubId())}/${child}`)
    else if (id === 'myteams') {
      const team = subRoute.split('/')[0] || access.managedTeams?.[0]?.id || ''
      onTab?.(`myteams/${encodeURIComponent(team)}/${child}`)
    } else if (FILTER_CHILDREN[id]) onTab?.(`${id}/@${child}`)
  }
  // a page of another tab (a team of My club in My teams, say); null when this account has no such tab
  const navigate = (path, opts = { push: true }) => {
    const id = String(path || '').split('/')[0]
    if (!allowed.includes(id)) return false
    onTab?.(path, opts)
    return true
  }
  // a notice about a club (a sign-up waits for a yes) opens that club's Requests
  const openTarget = (target) => navigate(/^myclub\/[^/]+$/.test(String(target || '')) ? `${target}/requests` : target, { push: true })
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
    icon: <x.icon size={15} aria-hidden />,
    ...(x.id === 'myclub' ? { children: MYCLUB_PARTS.map((part) => ({ id: part, label: t(`manage.myClub.nav.${part}`) })) } : {}),
    ...(x.id === 'myteams' ? { children: MYTEAMS_PARTS.map((part) => ({ id: part, label: t(`manage.myTeams.nav.${part}`) })) } : {}),
    ...(FILTER_CHILDREN[x.id] && (FILTER_CHILDREN[x.id].when?.(brand) ?? true) && !(x.id === 'teams' && scope === 'beach')
      ? { children: FILTER_CHILDREN[x.id].options.map((id) => ({ id, label: FILTER_CHILDREN[x.id].label(t, id, { pending: pendingAccounts }) })) }
      : {})
  }))
  const currentFilter = current && FILTER_CHILDREN[current] ? filterOf(current) : ''

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
          <NotificationsBell app={brand.app} onOpen={openTarget} />
          {hasHelp && (
            <button
              type="button"
              className={cn(consoleHeaderBtn, 'shrink-0 px-2')}
              onClick={() => setHelpOpen(open => !open)}
              aria-pressed={helpOpen}
              aria-label={t('contextHelp.helpButton', 'Help')}
              title={t('contextHelp.helpButton', 'Help')}
              data-testid="manage-help"
            >
              <CircleHelp size={16} aria-hidden />
            </button>
          )}
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
        currentChild={current === 'myclub' ? partOf(subRoute) : current === 'myteams' ? teamPartOf(subRoute) : currentFilter}
        onSelectChild={selectChild}
        navLabel={t('manage.nav')}
        footer={<LegalLinks className="text-[11px] text-stone-400" />}
      >
        {phoneTop && <div className="mb-3 sm:hidden">{phoneTop}</div>}
        {/* every list of the console: one card per item (owner 2026-11-10) */}
        <RowListCards.Provider value>
        {visited.has('accounts') && <ConsolePanel id="accounts" current={current}><PanelGate><AccountsPanel onPendingCount={setPendingAccounts} filter={filterOf('accounts')} selfId={user.id} selfIsSuperAdmin={!!access?.isSuperAdmin} app={scope} {...pageProps('accounts')} /></PanelGate></ConsolePanel>}
        {visited.has('invites') && <ConsolePanel id="invites" current={current}><PanelGate><InvitesPanel app={scope} /></PanelGate></ConsolePanel>}
        {visited.has('clubs') && <ConsolePanel id="clubs" current={current}><PanelGate><ClubsPanel {...pageProps('clubs')} /></PanelGate></ConsolePanel>}
        {visited.has('myclub') && <ConsolePanel id="myclub" current={current}><PanelGate><MyClubPanel clubs={access.managedClubs} {...pageProps('myclub')} /></PanelGate></ConsolePanel>}
        {visited.has('myteams') && <ConsolePanel id="myteams" current={current}><PanelGate><MyTeamsPanel teams={access.managedTeams} {...pageProps('myteams')} /></PanelGate></ConsolePanel>}
        {visited.has('settings') && <ConsolePanel id="settings" current={current}><PanelGate><SettingsPanel /></PanelGate></ConsolePanel>}
        {visited.has('games') && <ConsolePanel id="games" current={current}><PanelGate><OfficialGamesPanel {...pageProps('games')} /></PanelGate></ConsolePanel>}
        {visited.has('matches') && <ConsolePanel id="matches" current={current}><PanelGate><ClosedMatchesPanel state={filterOf('matches')} onShowActivity={showActivity} {...pageProps('matches')} /></PanelGate></ConsolePanel>}
        {visited.has('scoresheets') && <ConsolePanel id="scoresheets" current={current}><PanelGate><ScoresheetsPanel state={filterOf('scoresheets')} app={brand.app} canRebuild={accessForApp(access, brand?.app).isAdmin === true} /></PanelGate></ConsolePanel>}
        {visited.has('audit') && <ConsolePanel id="audit" current={current}><PanelGate><AuditPanel app={scope} /></PanelGate></ConsolePanel>}
        {visited.has('activity') && <ConsolePanel id="activity" current={current}><PanelGate><ActivityPanel app={scope} initialMatch={(() => { try { return decodeURIComponent(routeOf('activity')) } catch { return routeOf('activity') } })()} /></PanelGate></ConsolePanel>}
        {visited.has('teams') && <ConsolePanel id="teams" current={current}><PanelGate><SavedTeamsPanel sportFilter={scope === 'beach' ? null : filterOf('teams')} userId={user.id} sport={scope} {...pageProps('teams')} /></PanelGate></ConsolePanel>}
        {visited.has('data') && <ConsolePanel id="data" current={current}><PanelGate><DataPanel {...pageProps('data')} /></PanelGate></ConsolePanel>}
        {visited.has('sql') && <ConsolePanel id="sql" current={current}><Suspense fallback={<PageSpinner />}><SqlPanel /></Suspense></ConsolePanel>}
        {visited.has('tournaments') && <ConsolePanel id="tournaments" current={current}><PanelGate><TournamentsPanel {...pageProps('tournaments')} /></PanelGate></ConsolePanel>}
        </RowListCards.Provider>
      </ConsoleShell>
      {hasHelp && (
        <ContextualHelpPanel
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          screen={manageHelpScreen(current, current === 'myclub' ? partOf(subRoute) : '')}
        />
      )}
    </div>
  )
}
