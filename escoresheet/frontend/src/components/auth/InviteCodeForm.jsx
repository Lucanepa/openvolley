import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { formatInviteCode, errorKeyOf } from '../../lib/accountApi'
import { Button, Input, toast } from '../../ui'

/**
 * Invite-code field + "Redeem code" button (same height). Uppercase,
 * monospace, grouped as the user types. The error shows inline; success
 * toasts once the server granted the role.
 */
export default function InviteCodeForm({ onRedeemed, autoFocus = false, className = '' }) {
  const { t } = useTranslation()
  const { redeemInvite } = useAuth()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const clean = code.replace(/[^0-9A-Z]/g, '')
  const submit = async (e) => {
    e.preventDefault()
    if (busy || clean.length < 12) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError(t('access.errors.offline'))
      return
    }
    setBusy(true)
    setError('')
    const { data, error: err } = await redeemInvite(code)
    setBusy(false)
    if (err) {
      const key = errorKeyOf(err)
      setError(t(key === 'manage.errors.offline' ? 'access.errors.offline' : key))
      return
    }
    setCode('')
    toast.success(t('access.redeemed'))
    onRedeemed?.(data)
  }

  return (
    <form onSubmit={submit} className={className} noValidate>
      <label className="mb-1 block text-xs font-medium text-stone-600" htmlFor="ov-invite-code">{t('access.inviteCodeLabel')}</label>
      <div className="flex flex-col gap-2 min-[420px]:flex-row">
        <Input
          id="ov-invite-code"
          size="md"
          value={code}
          onChange={e => { setCode(formatInviteCode(e.target.value)); setError('') }}
          placeholder={t('access.inviteCodePlaceholder')}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus={autoFocus}
          invalid={!!error}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? 'ov-invite-code-error' : undefined}
          // Side by side from 420px: the field takes the room the button leaves
          // (a fixed w-56 wrapped "Redeem code" onto two lines in a 320px card)
          className="font-mono uppercase tracking-[0.2em] min-[420px]:min-w-0 min-[420px]:max-w-56 min-[420px]:flex-1"
        />
        <Button type="submit" size="md" loading={busy} disabled={busy || clean.length < 12} className="shrink-0 whitespace-nowrap">
          {busy ? t('access.redeeming') : t('access.redeem')}
        </Button>
      </div>
      {error && <p id="ov-invite-code-error" role="alert" className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
    </form>
  )
}
