import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, WifiOff } from 'lucide-react'
import KitModal from './KitModal'
import { errorKeyOf } from '../../lib/accountApi'
import { AppSpinner, Banner, Button, EmptyInset, Field, Input, Notice, SkeletonRows, Textarea, StatusPill, usePanelShown } from '../../ui'

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
 * A panel's own pages (owner 2026-11-10: "make sure every page there gets
 * their own page (team, club, game, player etc)"). The console keeps them in
 * the URL after the tab: #<tab>/<route>, e.g. #teams/<competition>/<team>.
 * Returns [segments (decoded), go(segments | route string, { push })];
 * opening a page pushes a history entry (the browser's Back returns), a
 * redirect (a page deleted, say) replaces it. Without onRoute (a panel on its
 * own, as in tests) the panel keeps the route itself.
 */
export function usePanelRoute(route, onRoute) {
  const [own, setOwn] = useState('')
  const current = onRoute ? String(route || '') : own
  const go = useCallback((next, opts = { push: true }) => {
    const path = Array.isArray(next) ? next.filter((x) => x != null && x !== '').map((x) => encodeURIComponent(String(x))).join('/') : String(next || '')
    if (onRoute) onRoute(path, opts)
    else setOwn(path)
  }, [onRoute])
  const segments = current.split('/').filter(Boolean).map((x) => {
    try { return decodeURIComponent(x) } catch { return x }
  })
  return [segments, go]
}

/**
 * A page of the URL whose thing is not (yet) there: loading, the read's
 * error, or gone (deleted, another account's, a link from before), with the
 * way back to the list.
 */
export function PageMissing({ loading = false, error = null, onBack, backLabel }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  return (
    <section data-testid="page-missing">
      {onBack && <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} className="mb-3">{backLabel}</Button>}
      {error ? <Notice>{errorText(error)}</Notice> : loading ? <SkeletonRows rows={4} pill={false} /> : <EmptyInset>{t('manage.pageNotFound')}</EmptyInset>}
    </section>
  )
}

// PageLoadGate's registry: the first reads of a page under it
const PageLoad = createContext(null)

/**
 * Load data for a panel: { data, error, loading, stale, reload }. The previous
 * data stays on screen while reloading (no flash of the empty state).
 * reload({ quiet: true }) is a background refresh: no loading state, and a
 * failed read keeps what is shown.
 * What is kept belongs to its deps: with new deps (another filter, another
 * team) the panel is loading and has no data until the new read answers, so
 * neither the empty state nor the previous selection's list is drawn under
 * the new one ("No accounts found." before the accounts, owner 2026-11-11).
 * `stale` is the previous deps' data meanwhile, for a panel that wants it.
 * @param {() => Promise<{data: any, error: object|null}>} fetcher
 */
export function usePanelData(fetcher, deps = [], { enabled = true } = {}) {
  // one token per set of deps: the state says whose read it holds
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const key = useMemo(() => ({}), deps)
  const [state, setState] = useState({ key: null, data: null, error: null, loading: enabled })
  const seq = useRef(0)
  const reload = useCallback(async (opts) => {
    const quiet = opts?.quiet === true
    const my = ++seq.current
    if (!quiet) setState(s => ({ ...s, loading: true }))
    const res = await fetcher()
    if (my !== seq.current) return res
    // a quiet refresh keeps what is shown on a failed read (or no answer)
    if (quiet && (!res || res.error)) {
      setState(s => ({ ...s, loading: false }))
      return res
    }
    // a failed read keeps the data of the same deps (the panel shows the error)
    const error = res?.error || null
    setState(s => ({ key, data: error ? (s.key === key ? s.data : null) : (res?.data ?? null), error, loading: false }))
    return res
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    if (enabled) reload()
  }, [reload, enabled])
  // The console keeps a tab mounted once opened: shown again, it refreshes
  // quietly (owner 2026-11-10: the officials' licences saved in My teams were
  // not in Competitions, which still showed its first load)
  const shown = usePanelShown()
  const seen = useRef(shown)
  useEffect(() => {
    if (shown === seen.current) return
    seen.current = shown
    if (enabled) reload({ quiet: true })
  }, [shown, enabled, reload])
  // under a PageLoadGate: this read holds the page until its first answer
  const gate = useContext(PageLoad)
  const first = enabled && (state.key !== key || (state.loading && state.data == null && !state.error))
  const token = useRef(null)
  if (!token.current) token.current = {}
  useEffect(() => {
    if (!gate || !first) return
    const me = token.current
    gate.add(me)
    return () => gate.done(me)
  }, [gate, first])
  if (state.key !== key) return { data: null, error: null, loading: enabled, stale: state.data, reload }
  return { data: state.data, error: state.error, loading: state.loading, stale: null, reload }
}

/**
 * One page that appears whole (owner 2026-11-11: the console "doesn't look
 * loaded together"): the sections below it mount at once, hidden, and show
 * together once every usePanelData among them has its first answer (or
 * failed); `fallback` (a skeleton) meanwhile. Later reloads do not hide the
 * page again. After `timeoutMs` the page shows anyway (a read that hangs).
 */
export function PageLoadGate({ fallback = null, className = '', timeoutMs = 10000, children }) {
  const pending = useRef(new Set())
  const [open, setOpen] = useState(false)
  // after the commit's effects (StrictMode's second mount re-adds what its
  // cleanup took), so a read registering in the same commit is counted
  const check = useCallback(() => {
    queueMicrotask(() => { if (pending.current.size === 0) setOpen(true) })
  }, [])
  const registry = useMemo(() => ({
    add: (id) => { pending.current.add(id) },
    done: (id) => { pending.current.delete(id); check() }
  }), [check])
  useEffect(() => {
    check()
    const timer = setTimeout(() => setOpen(true), timeoutMs)
    return () => clearTimeout(timer)
  }, [check, timeoutMs])
  return (
    <PageLoad.Provider value={open ? null : registry}>
      {!open && fallback}
      <div className={[open ? '' : 'hidden', className].filter(Boolean).join(' ')} data-loading={open ? undefined : 'true'}>{children}</div>
    </PageLoad.Provider>
  )
}

/**
 * A console page's wait (PageLoadGate's fallback): the branded spinner at the
 * size of the console's sign-in wait (ManagerApp), faded in after a moment so
 * a quick answer shows no flash (owner 2026-11-11: "no race -> wait to load").
 */
export function PageSpinner({ className = 'py-20' }) {
  const { t } = useTranslation()
  return (
    <div className={`flex justify-center ${className}`} data-testid="panel-loading">
      <AppSpinner size={72} label={t('common.loading')} className="ov-spinner-late" />
    </div>
  )
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
// `level` 2: a section under the panel's own heading (My club's members and codes)
export function PanelHead({ title, level = 1, children }) {
  const H = level === 2 ? 'h2' : 'h1'
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <H className={level === 2 ? 'm-0 text-lg font-semibold tracking-tight text-stone-900' : 'm-0 text-xl font-bold tracking-tight text-stone-900 sm:text-2xl'}>{title}</H>
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
