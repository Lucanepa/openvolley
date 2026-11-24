import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LogOut, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { apiAuth } from '../../lib/apiClient'
import { isPasskeyCancel, passkeysPossible } from '../../lib/passkeys'
import { Button, Checkbox, Field, FieldNote, Input, toast } from '../../ui'
import { confirmErrorText, withConfirmation } from './confirmIdentity'

function shortDateTime(value, lang) {
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString(lang || undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Profile → Sign-in and devices: a new password (with the current one),
 * where the account is signed in, and "sign out everywhere", which can
 * remove the passkeys too: a lost or shared device that holds one would
 * otherwise sign straight back in (backend lib/auth.js).
 */
export default function AccountSecuritySection({ className }) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const [passkeyHere] = useState(() => passkeysPossible())
  const [sessions, setSessions] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [mode, setMode] = useState(null) // 'password' | 'everywhere' | null
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [removePasskeys, setRemovePasskeys] = useState(true)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoadError('')
    const { data, error: listError } = await apiAuth.listSessions()
    if (listError) {
      setLoadError(t('accountSecurity.sessionsLoadFailed'))
      return
    }
    setSessions(data?.sessions || [])
  }

  useEffect(() => {
    if (user) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  if (!user) return null

  const close = () => {
    setMode(null)
    setCurrent('')
    setNext('')
    setRepeat('')
    setPassword('')
    setError('')
    setRemovePasskeys(true)
  }

  const changePassword = async (e) => {
    e.preventDefault()
    if (busy) return
    if (next !== repeat) {
      setError(t('auth.passwordsDoNotMatch', 'Passwords do not match'))
      return
    }
    setError('')
    setBusy(true)
    try {
      const { error: changeError } = await apiAuth.changePassword({ password: current, newPassword: next })
      if (changeError) {
        setError(confirmErrorText(t, changeError))
        return
      }
      close()
      toast.success(t('accountSecurity.passwordChanged'))
      void load()
    } finally {
      setBusy(false)
    }
  }

  const signOutEverywhere = async (usePasskey) => {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const run = ({ password: pw }) => apiAuth.signOutEverywhere({ removePasskeys, password: pw })
      const { data, error: outError } = removePasskeys
        ? await withConfirmation({ password, usePasskey }, run)
        : await run({})
      if (outError) {
        setError(confirmErrorText(t, outError))
        return
      }
      close()
      toast.success(data?.removed_passkeys
        ? t('accountSecurity.signedOutEverywherePasskeys')
        : t('accountSecurity.signedOutEverywhere'))
      void load()
    } catch (err) {
      if (!isPasskeyCancel(err)) setError(confirmErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={className} aria-labelledby="account-security-title" data-testid="account-security">
      <div id="account-security-title" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-stone-700">
        <ShieldCheck size={15} aria-hidden="true" className="text-stone-400" />
        {t('accountSecurity.title')}
      </div>
      <div className="rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
        <p className="m-0 text-xs font-medium text-stone-600">{t('accountSecurity.sessionsTitle')}</p>
        {loadError && <p role="alert" className="m-0 mt-1 text-xs text-red-700">{loadError}</p>}
        {sessions && sessions.length > 0 && (
          <ul className="m-0 mt-2 list-none space-y-1.5 p-0" data-testid="session-list">
            {sessions.map((s) => (
              <li key={s.id} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
                <p className="m-0 text-sm font-medium text-stone-800">
                  {s.current ? t('accountSecurity.thisDevice') : t('accountSecurity.otherDevice')}
                </p>
                <p className="m-0 text-xs text-stone-500">
                  {[t('accountSecurity.signedInAt', { date: shortDateTime(s.created_at, i18n.language) }),
                    s.last_seen_at ? t('accountSecurity.lastActive', { date: shortDateTime(s.last_seen_at, i18n.language) }) : ''
                  ].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        )}

        {mode === 'password' && (
          <form onSubmit={changePassword} className="mt-3 space-y-2" data-testid="change-password-form">
            <Field label={t('accountSecurity.currentPassword')}>
              <Input size="lg" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </Field>
            <Field label={t('authEmail.newPassword')}>
              <Input size="lg" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            </Field>
            <Field label={t('authEmail.repeatPassword')}>
              <Input size="lg" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
            </Field>
            <FieldNote>{t('authEmail.passwordHint')}</FieldNote>
            <FieldNote>{t('accountSecurity.changePasswordHint')}</FieldNote>
            {error && <p role="alert" className="m-0 text-xs text-red-700">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="dark" size="xl" type="submit" className="rounded-lg font-medium" disabled={busy || !current || !next || !repeat} loading={busy}>
                {t('accountSecurity.changePassword')}
              </Button>
              <Button variant="secondary" size="xl" type="button" className="rounded-lg font-medium" onClick={close}>
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </form>
        )}

        {mode === 'everywhere' && (
          <form onSubmit={(e) => { e.preventDefault(); void signOutEverywhere(false) }} className="mt-3 space-y-2" data-testid="sign-out-everywhere-form">
            <p className="m-0 text-xs text-stone-600">{t('accountSecurity.signOutEverywhereHint')}</p>
            <Checkbox label={t('accountSecurity.removePasskeysToo')} checked={removePasskeys} onChange={(e) => setRemovePasskeys(e.target.checked)} />
            {removePasskeys && (
              <Field label={t('accountSecurity.confirmPassword')}>
                <Input size="lg" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            )}
            {error && <p role="alert" className="m-0 text-xs text-red-700">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" size="xl" type="submit" className="rounded-lg font-medium" disabled={busy || (removePasskeys && !password)} loading={busy}>
                {t('accountSecurity.signOutEverywhere')}
              </Button>
              {removePasskeys && passkeyHere && (
                <Button variant="secondary" size="xl" type="button" className="rounded-lg font-medium" disabled={busy} onClick={() => void signOutEverywhere(true)}>
                  {t('accountSecurity.usePasskey')}
                </Button>
              )}
              <Button variant="secondary" size="xl" type="button" className="rounded-lg font-medium" onClick={close}>
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </form>
        )}

        {!mode && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="xl" className="rounded-lg font-medium" onClick={() => setMode('password')} data-testid="change-password">
              {t('accountSecurity.changePassword')}
            </Button>
            <Button variant="secondary" size="xl" className="rounded-lg font-medium" icon={LogOut} onClick={() => setMode('everywhere')} data-testid="sign-out-everywhere">
              {t('accountSecurity.signOutEverywhere')}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
