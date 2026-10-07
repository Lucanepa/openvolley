import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MailWarning } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Banner, Notice } from '../../ui'

/**
 * "Email address not confirmed yet" with "Send a new link", for a signed-in
 * account whose address is unconfirmed (new accounts, when the server sends
 * confirmation emails). Nothing for confirmed or signed-out users.
 */
export default function EmailConfirmBanner({ className }) {
  const { t } = useTranslation()
  const { user, resendConfirmation } = useAuth()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { tone, text }

  if (!user || user.email_confirmed_at) return null

  const resend = async () => {
    if (busy) return
    setBusy(true)
    setResult(null)
    const res = await resendConfirmation()
    setBusy(false)
    if (!res?.error) {
      setResult(res?.data?.already_confirmed
        ? { tone: 'success', text: t('authEmail.alreadyConfirmed') }
        : { tone: 'success', text: t('authEmail.resent', { email: user.email }) })
      return
    }
    if (res.error.status === 429) return setResult({ tone: 'error', text: t('authEmail.tooManyAttempts') })
    if (res.error.network || res.error.status === 0) return setResult({ tone: 'error', text: t('authEmail.offline') })
    setResult({ tone: 'error', text: t('authEmail.resendUnavailable') })
  }

  return (
    <div className={className} data-testid="email-confirm-banner">
      <Banner tone="warning" icon={MailWarning} action={{ label: t('authEmail.resend'), onClick: resend, disabled: busy }}>
        {t('authEmail.notConfirmed')}
      </Banner>
      {result && <Notice tone={result.tone} className="mt-2">{result.text}</Notice>}
    </div>
  )
}
