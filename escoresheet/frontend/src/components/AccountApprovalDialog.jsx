import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ShieldCheck } from 'lucide-react'
import { db } from '../db/db'
import { approvalsApi, errorKeyOf } from '../lib/accountApi'
import {
  ROLE_TO_SLOT, resultTriples, officialFor, officialName, recallApprovalEmail, deviceId, pendingSyncJobsFor
} from '../domain/accountApproval'
import { PIN_INPUT_PROPS } from './auth/ApprovalPinSection'
import KitModal from './manage/KitModal'
import { Button, Field, FormError, Input } from '../ui'

export const SYNC_WAIT_MS = 10000
const SYNC_POLL_MS = 300

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wait until the sync queue holds no unsent job of this match (its sets and
 * events must be on the server before it can bind an approval to the result).
 * Asks the queue to flush first. Resolves true when clear, false after
 * timeoutMs.
 */
export async function waitForMatchSync(seedKey, {
  timeoutMs = SYNC_WAIT_MS,
  readQueue = () => db.sync_queue.toArray(),
  onWaiting = () => {},
  pause = sleep
} = {}) {
  const pending = async () => {
    try { return pendingSyncJobsFor(await readQueue(), seedKey).length } catch { return 0 }
  }
  if (await pending() === 0) return true
  onWaiting()
  try { window.dispatchEvent(new Event('sync-queue-write')) } catch { /* no window */ }
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await pause(SYNC_POLL_MS)
    if (await pending() === 0) return true
  }
  return false
}

/** The email the dialog starts with (spec 4.5): officials entry, own (scorer), remembered, empty. */
export function initialApprovalEmail({ match, role, userEmail }) {
  const official = officialFor(match, role)
  if (official?.email) return String(official.email)
  if (role === 'scorer' && userEmail) return userEmail
  return recallApprovalEmail(officialName(official)) || ''
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * "Approve as <role>": the official types the email of their account and
 * their personal approval PIN on the scoring device (account-approval spec
 * 4.5). Online only. The PIN lives in this dialog's state until the request
 * settles and is never logged or stored.
 *
 * onApproved(record, { email }) is called after a 200; the parent writes the
 * record to Dexie and closes the dialog.
 */
export default function AccountApprovalDialog({ open, onClose, match, role, roleLabel, sets, userEmail, onApproved }) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState(null) // 'syncing' | null
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    if (!open) return
    setEmail(initialApprovalEmail({ match, role, userEmail }))
    setPin('')
    setError('')
    setBusy(false)
    setPhase(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role])

  // Closing drops the PIN at once
  useEffect(() => { if (!open) setPin('') }, [open])

  const slot = ROLE_TO_SLOT[role]
  const entered = officialName(officialFor(match, role))
  const trimmedEmail = email.trim().toLowerCase()
  const valid = EMAIL_RE.test(trimmedEmail) && trimmedEmail.length <= 254 && pin.length > 0

  const lockedText = (err) => {
    const d = err?.details || {}
    if (d.disabled) return t('approval.errors.pinDisabled')
    const minutes = Math.max(1, Math.ceil(Number(d.retry_after_sec || 0) / 60))
    return t('approval.errors.pinLocked', { minutes })
  }

  const submit = async (e) => {
    e?.preventDefault?.()
    if (!valid || busy || !slot || !match?.seed_key) return
    // The PIN goes into this one request and nowhere else
    const typedPin = pin
    setBusy(true)
    setError('')

    const send = async () => {
      const synced = await waitForMatchSync(match.seed_key, { onWaiting: () => alive.current && setPhase('syncing') })
      if (alive.current) setPhase(null)
      if (!synced) return { error: { code: 'OV_RESULT_NOT_SYNCED' } }
      // The finished sets as they are now in Dexie (not the render's copy)
      let current = sets
      try { current = await db.sets.where('matchId').equals(match.id).toArray() } catch { /* keep the props */ }
      return approvalsApi.approve({
        external_id: match.seed_key,
        slot,
        email: trimmedEmail,
        pin: typedPin,
        result: { sets: resultTriples(current) },
        device_id: deviceId()
      })
    }

    let res = await send()
    if (res.error?.code === 'OV_RESULT_NOT_SYNCED') res = await send()

    if (!alive.current) return
    setPin('')
    setBusy(false)
    setPhase(null)
    if (res.error) {
      setError(res.error.code === 'OV_APPROVAL_PIN_LOCKED'
        ? lockedText(res.error)
        : t(errorKeyOf(res.error, { context: 'approval' })))
      return
    }
    const record = res.data?.approval
    if (!record) {
      setError(t('manage.errors.generic'))
      return
    }
    await onApproved?.(record, { email: trimmedEmail, entered })
  }

  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={!busy}
      size="sm"
      icon={ShieldCheck}
      title={t('approval.dialogTitle', { role: roleLabel })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="xl" className="font-medium" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="xl" loading={busy} disabled={!valid || busy} onClick={submit} data-testid="account-approval-submit">
          {t('approval.approve')}
        </Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3" noValidate data-testid="account-approval-form">
        {entered && (
          <p className="m-0 pb-1 text-sm text-stone-600" data-testid="account-approval-entered">
            {t('approval.officialEntered', { name: entered })}
          </p>
        )}
        <Field label={t('approval.email')}>
          <Input
            size="lg"
            type="email"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={e => { setEmail(e.target.value); setError('') }}
            disabled={busy}
            data-autofocus={email ? undefined : true}
            required
          />
        </Field>
        <Field label={t('approval.pinLabel')} hint={t('approval.pinHint')}>
          <Input
            size="lg"
            {...PIN_INPUT_PROPS}
            className="font-mono tracking-[0.3em]"
            value={pin}
            onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }}
            disabled={busy}
            data-autofocus={email ? true : undefined}
            required
          />
        </Field>
        {phase === 'syncing' && (
          <p role="status" className="m-0 flex items-center gap-1.5 text-xs text-stone-500">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />{t('approval.syncing')}
          </p>
        )}
        <FormError>{error}</FormError>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </KitModal>
  )
}
