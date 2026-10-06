import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ClipboardList, KeyRound, ScrollText, ShieldCheck, Trophy, Users } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { ConsoleShell, ConsolePanel, consoleHeaderBtn } from '../../ui'
import AccountsPanel from './AccountsPanel'
import InvitesPanel from './InvitesPanel'
import OfficialGamesPanel from './OfficialGamesPanel'
import ClosedMatchesPanel from './ClosedMatchesPanel'
import AuditPanel from './AuditPanel'
import SavedTeamsPanel from './SavedTeamsPanel'

const TABS = [
  { id: 'accounts', icon: Users, admin: true },
  { id: 'invites', icon: KeyRound, admin: true },
  { id: 'games', icon: Trophy, admin: true },
  { id: 'matches', icon: ShieldCheck, admin: true },
  { id: 'audit', icon: ScrollText, admin: true },
  { id: 'teams', icon: ClipboardList, admin: false }
]

/** The tabs an account sees: admins all six, competition managers saved teams. */
export function manageTabsFor(access) {
  if (!access) return []
  return TABS.filter(tab => (tab.admin ? access.isAdmin : access.canManageTeams)).map(tab => tab.id)
}

/**
 * The manage console (admins and competition managers), full screen inside
 * the main app. Hiding tabs is cosmetic: every action is refused by the
 * server without the role.
 * `onClose` draws "Back to the app" (left out on manager.openvolley.app);
 * `headerActions` go before it in the header.
 */
export default function ManageConsole({ tab, onTab, onClose, headerActions }) {
  const { t } = useTranslation()
  const { user, access } = useAuth()
  const allowed = useMemo(() => manageTabsFor(access), [access])
  const current = allowed.includes(tab) ? tab : allowed[0]
  // Panels mount on first visit and then stay mounted (ConsolePanel)
  const [visited, setVisited] = useState(() => new Set(current ? [current] : []))
  useEffect(() => {
    if (current && !visited.has(current)) setVisited(v => new Set([...v, current]))
  }, [current, visited])

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

  return (
    <div className="ov-kit fixed inset-0 z-[900] overflow-y-auto bg-stone-100" data-testid="manage-console">
      <ConsoleShell
        logo={<img src={`${import.meta.env.BASE_URL}openvolley_no_bg.png`} alt="OpenVolley" className="h-7 w-auto" />}
        eyebrow={t('manage.title')}
        actions={<>
          {headerActions}
          {onClose && (
            <button type="button" className={consoleHeaderBtn} onClick={onClose} aria-label={t('manage.backToApp')}>
              <ArrowLeft size={14} aria-hidden />
              <span className="hidden sm:inline">{t('manage.backToApp')}</span>
            </button>
          )}
        </>}
        tabs={tabs}
        current={current}
        onSelect={onTab}
        navLabel={t('manage.nav')}
      >
        {visited.has('accounts') && <ConsolePanel id="accounts" current={current}><AccountsPanel selfId={user.id} /></ConsolePanel>}
        {visited.has('invites') && <ConsolePanel id="invites" current={current}><InvitesPanel /></ConsolePanel>}
        {visited.has('games') && <ConsolePanel id="games" current={current}><OfficialGamesPanel /></ConsolePanel>}
        {visited.has('matches') && <ConsolePanel id="matches" current={current}><ClosedMatchesPanel /></ConsolePanel>}
        {visited.has('audit') && <ConsolePanel id="audit" current={current}><AuditPanel /></ConsolePanel>}
        {visited.has('teams') && <ConsolePanel id="teams" current={current}><SavedTeamsPanel userId={user.id} /></ConsolePanel>}
      </ConsoleShell>
    </div>
  )
}
