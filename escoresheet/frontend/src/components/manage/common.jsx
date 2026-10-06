import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WifiOff } from 'lucide-react'
import KitModal from './KitModal'
import { errorKeyOf } from '../../lib/accountApi'
import { Banner, Button, Field, Input, Textarea, StatusPill } from '../../ui'

/** navigator.onLine, following the online/offline events. */
export function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

/** The lang argument of the kit's Zürich date helpers. */
export function useKitLang() {
  const { i18n } = useTranslation()
  const lang = String(i18n?.language || 'de').slice(0, 2).toUpperCase()
  return ['DE', 'EN', 'FR', 'IT'].includes(lang) ? lang : 'DE'
}

/**
 * Load data for a panel: { data, error, loading, reload }. The previous data
 * stays on screen while reloading (no flash of the empty state).
 * @param {() => Promise<{data: any, error: object|null}>} fetcher
 */
export function usePanelData(fetcher, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled })
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const my = ++seq.current
    setState(s => ({ ...s, loading: true }))
    const res = await fetcher()
    if (my !== seq.current) return res
    setState({ data: res.error ? null : res.data, error: res.error || null, loading: false })
    return res
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    if (enabled) reload()
  }, [reload, enabled])
  return { ...state, reload }
}

export function OfflineBanner({ online }) {
  const { t } = useTranslation()
  if (online) return null
  return <Banner tone="warning" icon={WifiOff} className="mb-3">{t('manage.errors.offline')}</Banner>
}

/** Inline error under an action (text-red-600 text-xs font-medium). */
export function InlineError({ error, className = '' }) {
  if (!error) return null
  return <p role="alert" className={`text-xs font-medium text-red-600 ${className}`}>{error}</p>
}

/** The text of an API error for this console. */
export function useErrorText() {
  const { t } = useTranslation()
  return (error) => (error ? t(errorKeyOf(error)) : '')
}

/** Panel title row: a page title and the panel's actions. */
export function PanelHead({ title, children }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="m-0 text-xl font-bold tracking-tight text-stone-900 sm:text-2xl">{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

const STATUS_TONES = { setup: 'neutral', live: 'brand', ended: 'todo', approved: 'planned', final: 'done' }

/** A match status as a round pill with its word. */
export function MatchStatusPill({ status }) {
  const { t } = useTranslation()
  if (!status) return null
  return <StatusPill tone={STATUS_TONES[status] || 'neutral'}>{t(`manage.status.${status}`, status)}</StatusPill>
}

/** Account display name: first + last name, else the email. */
export function personName(first, last, email) {
  const name = `${first || ''} ${last || ''}`.trim()
  return name || email || ''
}

/**
 * A decision dialog with one required reason (reopen, release game).
 * onSubmit(reason) resolves to an error text or null.
 */
export function ReasonModal({ open, title, body, label, confirmLabel, tone = 'danger', onClose, onSubmit }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) { setReason(''); setError(''); setBusy(false) }
  }, [open])
  const valid = reason.trim().length >= 3
  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    const err = await onSubmit(reason.trim())
    setBusy(false)
    if (err) setError(err)
  }
  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      title={title}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant={tone === 'danger' ? 'danger' : 'dark'} size="lg" onClick={submit} loading={busy} disabled={!valid || busy} data-testid="reason-confirm">
          {confirmLabel}
        </Button>
      </>}
    >
      {body && <p className="mb-3 text-sm text-stone-600">{body}</p>}
      <Field label={label}>
        <Textarea rows={3} value={reason} onChange={e => { setReason(e.target.value); setError('') }} maxLength={500} required />
      </Field>
      <InlineError error={error} className="mt-1.5" />
    </KitModal>
  )
}

/** A one-field form dialog (add editor by email). */
export function InputModal({ open, title, label, type = 'text', confirmLabel, onClose, onSubmit }) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) { setValue(''); setError(''); setBusy(false) }
  }, [open])
  const submit = async (e) => {
    e?.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    const err = await onSubmit(value.trim())
    setBusy(false)
    if (err) setError(err)
  }
  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      decision
      title={title}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="dark" size="lg" onClick={submit} loading={busy} disabled={!value.trim() || busy}>{confirmLabel}</Button>
      </>}
    >
      <form onSubmit={submit}>
        <Field label={label}>
          <Input type={type} value={value} onChange={e => { setValue(e.target.value); setError('') }} autoFocus required />
        </Field>
        <InlineError error={error} className="mt-1.5" />
      </form>
    </KitModal>
  )
}
