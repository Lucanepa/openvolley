import { useTranslation } from 'react-i18next'
import { KNOWN_ROLES } from '../../lib/access'

const CHIP = 'inline-flex items-center whitespace-nowrap rounded border px-1.5 py-[3px] text-[11px] font-semibold leading-none'
const TONE = {
  scorer: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  referee: 'border-sky-200 bg-sky-50 text-sky-700',
  competition_manager: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  admin: 'border-stone-900 bg-stone-900 text-white',
  super_admin: 'border-stone-900 bg-stone-900 text-white',
  pending: 'border-amber-300 bg-amber-50 text-amber-800'
}

/** Square role chips of an account; an amber "Pending approval" chip without a role. */
export default function RoleChips({ roles = [], pending = false, className = '' }) {
  const { t } = useTranslation()
  const known = (roles || []).filter(r => KNOWN_ROLES.includes(r))
  return (
    <span className={`flex flex-wrap gap-1 ${className}`}>
      {pending || known.length === 0
        ? <span className={`${CHIP} ${TONE.pending}`}>{t('access.roles.pending')}</span>
        : known.map(r => <span key={r} className={`${CHIP} ${TONE[r]}`}>{t(`access.roles.${r}`)}</span>)}
    </span>
  )
}
