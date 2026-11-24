import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import InviteCodeForm from './InviteCodeForm'

/**
 * Amber "waiting for approval" banner with the invite-code field. Shown to a
 * signed-in account without a recognised role (HomePage, ProfileModal).
 */
export default function PendingApprovalBanner({ className = '' }) {
  const { t } = useTranslation()
  // Outside an AuthProvider (isolated renders) there is no account: no banner.
  // (useAuth throws without a provider; it is still called on every render.)
  let auth = null
  try { auth = useAuth() } catch { auth = null }
  const user = auth?.user
  const access = auth?.access
  if (!user || !access?.known || !access.isPending) return null
  return (
    <div className={`ov-kit ${className}`}>
      <section
        aria-labelledby="ov-pending-title"
        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-amber-900"
        data-testid="pending-approval-banner"
      >
        <div className="flex items-start gap-2">
          <Clock size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700" />
          <div className="min-w-0 flex-1">
            <h3 id="ov-pending-title" className="text-sm font-semibold text-amber-900">{t('access.pendingTitle')}</h3>
            <p className="mt-0.5 text-xs text-amber-900/90">{t('access.pendingBody')}</p>
            <InviteCodeForm className="mt-3" />
          </div>
        </div>
      </section>
    </div>
  )
}
