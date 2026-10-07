import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, WifiOff } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { approvalPinApi, errorKeyOf } from '../../lib/accountApi'
import { getCloudApiUrl } from '../../utils/backendConfig'
import { PIN_RE, isWeakPin, formatApprovalTime } from '../../domain/accountApproval'
import { askConfirm } from '../../utils/askConfirm.js'
import KitModal from '../manage/KitModal'
import { Button, Field, FormError, Input, toast } from '../../ui'

/**
 * Attributes of every approval-PIN field: masked, numeric keypad, never
 * autofilled or remembered by the browser.
 */
export const PIN_INPUT_PROPS = Object.freeze({
  type: 'password',
  inputMode: 'numeric',
  pattern: '[0-9]*',
  maxLength: 6,
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false
})

const STATUS_CACHE_KEY = 'ov.approvalPinStatus'

// The last status this account saw (no secret in it), for the offline view.
function readCachedStatus(userId) {
  try {
    const raw = localStorage.getItem(STATUS_CACHE_KEY)
    const cached = raw ? JSON.parse(raw) : null
    return cached && cached.userId === userId ? cached.status : null
  } catch {
    return null
  }
}
function writeCachedStatus(userId, status) {
  try { localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify({ userId, status })) } catch { /* storage blocked */ }
}

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

/** The roles that may hold an approval PIN (spec decision 3). */
export const APPROVAL_PIN_ROLES = ['referee', 'scorer']

/**
 * Profile → "Approval PIN" (account-approval spec 4.4). Shown to referee and
 * scorer accounts in cloud mode when the server offers the feature. The
 * account password confirms every change; the PIN never leaves the dialog
 * state and is cleared as soon as the request settles.
 */
export default function ApprovalPinSection({ className = '' }) {
  const { t } = useTranslation()
  const { user, access } = useAuth()
  const userId = user?.id || null
  const hasRole = !!access?.roles?.some(r => APPROVAL_PIN_ROLES.includes(r))
  const cloud = !!getCloudApiUrl('/api/account/approval-pin')
  const [status, setStatus] = useState(() => (userId ? readCachedStatus(userId) : null))
  const [online, setOnline] = useState(isOnline)
  const [dialog, setDialog] = useState(null) // 'set' | 'remove' | null

  const load = useCallback(async () => {
    if (!userId || !hasRole || !cloud || !isOnline()) return
    const { data, error } = await approvalPinApi.status()
    if (error) {
      if (error.code === 'OV_APPROVAL_UNAVAILABLE' || error.code === 'OV_DB_NOT_CONFIGURED') setStatus({ available: false })
      return
    }
    if (data) {
      setStatus(data)
      writeCachedStatus(userId, data)
    }
  }, [userId, hasRole, cloud])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const on = () => { setOnline(true); load() }
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [load])

  if (!userId || !hasRole || !cloud || !status?.available) return null

  const lockedUntil = status.locked_until && new Date(status.locked_until).getTime() > Date.now() ? status.locked_until : null
  const emailConfirmed = !!user?.email_confirmed_at
  const eligible = status.eligible !== false

  let line
  if (!eligible) {
    line = <span className="text-stone-500">{t(emailConfirmed ? 'approval.pin.ineligible.role' : 'approval.pin.ineligible.email')}</span>
  } else if (status.disabled) {
    line = <span className="font-medium text-red-700">{t('approval.pin.disabled')}</span>
  } else if (lockedUntil) {
    line = <span className="font-medium text-amber-700">{t('approval.pin.lockedUntil', { time: formatApprovalTime(lockedUntil) })}</span>
  } else if (status.set) {
    line = <span className="text-emerald-700">{t('approval.pin.setOn', { date: formatApprovalTime(status.set_at) })}</span>
  } else {
    line = <span className="text-stone-500">{t('approval.pin.notSet')}</span>
  }

  const canEdit = online && eligible

  return (
    <section className={className} aria-labelledby="approval-pin-title" data-testid="approval-pin-section">
      <div id="approval-pin-title" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-stone-700">
        <KeyRound size={15} aria-hidden="true" className="text-stone-400" />
        {t('approval.pin.title')}
      </div>
      <div className="rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
        <p className="m-0 text-xs text-stone-600">{t('approval.pin.explainer')}</p>
        <p className="m-0 mt-2 text-sm tabular-nums" data-testid="approval-pin-status">{line}</p>
        {!online && (
          <p className="m-0 mt-1 flex items-center gap-1.5 text-xs text-stone-500">
            <WifiOff size={13} aria-hidden="true" />{t('approval.pin.needsInternet')}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="dark" size="xl" className="rounded-lg font-medium" disabled={!canEdit} onClick={() => setDialog('set')}>
            {t(status.set && !status.disabled ? 'approval.pin.change' : 'approval.pin.set')}
          </Button>
          {status.set && (
            <Button variant="secondary" size="xl" className="rounded-lg font-medium" disabled={!online} onClick={() => setDialog('remove')}>
              {t('approval.pin.remove')}
            </Button>
          )}
        </div>
      </div>
      <PinDialog
        mode={dialog}
        changing={!!status.set && !status.disabled}
        onClose={() => setDialog(null)}
        onDone={(next) => {
          setDialog(null)
          if (next) {
            const merged = { ...status, ...next, locked_until: null, disabled: false }
            setStatus(merged)
            writeCachedStatus(userId, merged)
          }
          load()
        }}
      />
    </section>
  )
}

function PinDialog({ mode, changing, onClose, onDone }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [touched, setTouched] = useState(false)

  // Never keep a password or PIN beyond the dialog
  useEffect(() => {
    setPassword(''); setPin(''); setPin2(''); setError(''); setBusy(false); setTouched(false)
  }, [mode])

  const removing = mode === 'remove'
  const pinError = removing || !touched
    ? ''
    : !PIN_RE.test(pin) ? t('approval.errors.pinFormat')
      : isWeakPin(pin) ? t('approval.errors.pinWeak')
        : pin2 && pin2 !== pin ? t('approval.pin.mismatch') : ''
  const valid = password.length > 0 && (removing || (PIN_RE.test(pin) && !isWeakPin(pin) && pin === pin2))

  const errorText = (err) => {
    if (err?.code === 'OV_EMAIL_UNCONFIRMED') return t('approval.pin.ineligible.email')
    if (err?.code === 'OV_APPROVAL_ROLE_REQUIRED') return t('approval.pin.ineligible.role')
    return t(errorKeyOf(err))
  }

  const submit = async (e) => {
    e?.preventDefault?.()
    setTouched(true)
    if (!valid || busy) return
    if (removing) {
      const ok = await askConfirm({ title: t('approval.pin.removeConfirmTitle'), message: t('approval.pin.removeConfirmBody'), confirmLabel: t('approval.pin.remove'), tone: 'danger' })
      if (!ok) return
    }
    setBusy(true)
    setError('')
    const res = removing
      ? await approvalPinApi.remove({ password })
      : await approvalPinApi.set({ password, pin })
    // The secrets are spent either way
    setPassword(''); setPin(''); setPin2(''); setTouched(false)
    setBusy(false)
    if (res.error) {
      setError(errorText(res.error))
      return
    }
    toast.success(t(removing ? 'approval.pin.removed' : 'approval.pin.saved'))
    onDone(removing ? { set: false, set_at: null } : { set: true, set_at: res.data?.set_at ?? new Date().toISOString() })
  }

  const title = removing ? t('approval.pin.removeTitle') : t(changing ? 'approval.pin.changeTitle' : 'approval.pin.setTitle')

  return (
    <KitModal
      open={!!mode}
      zIndex={2200}
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      title={title}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button
          variant={removing ? 'danger' : 'positive'}
          size="lg"
          loading={busy}
          disabled={!valid || busy}
          onClick={submit}
          data-testid="approval-pin-submit"
        >
          {removing ? t('approval.pin.remove') : t('approval.pin.save')}
        </Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Field label={t('approval.pin.currentPassword')} hint={t('approval.pin.passwordHint')}>
          <Input
            size="lg"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError('') }}
            data-autofocus
            required
          />
        </Field>
        {!removing && (
          <>
            <Field label={t('approval.pin.newPin')} hint={pinError ? undefined : t('approval.pin.rule')} error={pinError || undefined}>
              <Input
                size="lg"
                {...PIN_INPUT_PROPS}
                className="font-mono tracking-[0.3em]"
                value={pin}
                onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }}
                onBlur={() => pin && setTouched(true)}
                required
              />
            </Field>
            <Field label={t('approval.pin.repeatPin')}>
              <Input
                size="lg"
                {...PIN_INPUT_PROPS}
                className="font-mono tracking-[0.3em]"
                value={pin2}
                onChange={e => { setPin2(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }}
                onBlur={() => pin2 && setTouched(true)}
                required
              />
            </Field>
          </>
        )}
        <FormError>{error}</FormError>
        {/* Enter submits */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </KitModal>
  )
}
