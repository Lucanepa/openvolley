import { useTranslation } from 'react-i18next'
import { ADMIN_ROLES, BEACH_ROLES, KNOWN_ROLES, plainRole } from '../../lib/access'

const CHIP = 'inline-flex items-center whitespace-nowrap rounded border px-1.5 py-[3px] text-[11px] font-semibold leading-none'
const TONE = {
  scorer: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  referee: 'border-sky-200 bg-sky-50 text-sky-700',
  competition_manager: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  club_manager: 'border-violet-200 bg-violet-50 text-violet-700',
  team_manager: 'border-violet-200 bg-violet-50 text-violet-700',
  admin: 'border-stone-900 bg-stone-900 text-white',
  super_admin: 'border-stone-900 bg-stone-900 text-white',
  pending: 'border-amber-300 bg-amber-50 text-amber-800'
}

/**
 * Square role chips of an account. Managing a club (db/020) or a team
 * (db/023) is no entry of profiles.roles (it is per club / per team), but it
 * shows as a role here, "Club manager" / "Team manager" (`manages`: { clubs,
 * teams }, the lists or counts), so an account is never drawn as without a
 * role while it manages something (owner 2026-11-11: "Pending approval" on a
 * team manager while the Pending list was empty; "standardize that").
 * The amber "Pending approval" chip: `pending` and nothing managed.
 * `app` 'beach' (the OpenBeach manager): the beach roles (by their plain names)
 * and the admin roles; otherwise the indoor ones, as before (OpenBeach has no
 * club or team managers).
 */
export default function RoleChips({ roles = [], pending = false, manages = null, app, className = '' }) {
  const { t } = useTranslation()
  const shown = app === 'beach' ? [...BEACH_ROLES, ...ADMIN_ROLES] : KNOWN_ROLES
  const known = (roles || []).filter(r => shown.includes(r)).map(plainRole)
  const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)
  if (app !== 'beach' && count(manages?.clubs) > 0) known.push('club_manager')
  if (app !== 'beach' && count(manages?.teams) > 0) known.push('team_manager')
  return (
    <span className={`flex flex-wrap gap-1 ${className}`}>
      {pending && known.length === 0
        ? <span className={`${CHIP} ${TONE.pending}`}>{t('access.roles.pending')}</span>
        : known.map(r => <span key={r} className={`${CHIP} ${TONE[r]}`}>{t(`access.roles.${r}`)}</span>)}
    </span>
  )
}
