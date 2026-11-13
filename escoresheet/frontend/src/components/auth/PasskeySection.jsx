import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Fingerprint, Trash2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { apiAuth } from '../../lib/apiClient'
import {
  isPasskeyAlreadyHere, isPasskeyCancel, markPasskeyHere, passkeysPossible, runPasskeySetUp
} from '../../lib/passkeys'
import { Button, confirmDialog, Field, FieldNote, IconButton, Input, toast } from '../../ui'
import { passkeyErrorText } from './passkeyErrors'

function shortDate(value, lang) {
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleDateString(lang || undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/**
 * Profile → Passkeys: the account's passkeys (one per device), adding one on
 * this device — with the password, which the server checks first — and
 * removing any. Removing is also the answer to the mail that says one was
 * added. Hidden where a passkey cannot work (the installed apps).
 */
export default function PasskeySection({ className }) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const [possible] = useState(() => passkeysPossible())
  const [entries, setEntries] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [adding, setAdding] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoadError('')
    const { data, error: listError } = await apiAuth.listPasskeys()
    if (listError) {
      setLoadError(passkeyErrorText(t, listError))
      return
    }
    setEntries(data?.passkeys || [])
  }

  useEffect(() => {
    if (possible && user) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [possible, user?.id])

  if (!possible || !user) return null

  const add = async (e) => {
    e.preventDefault()
    if (busy || !password) return
    setError('')
    setBusy(true)
    try {
      const { data, error: addError } = await apiAuth.addPasskey({ password, lang: i18n.language }, runPasskeySetUp)
      if (addError) {
        setError(passkeyErrorText(t, addError))
        return
      }
      markPasskeyHere(user.id, true)
      setEntries((list) => [...(list || []), data.passkey])
      setAdding(false)
      setPassword('')
      toast.success(t('passkeys.setUpDone'))
    } catch (err) {
      if (isPasskeyCancel(err)) return
      setError(isPasskeyAlreadyHere(err) ? t('passkeys.errors.alreadyHere') : passkeyErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entry) => {
    const ok = await confirmDialog({
      title: t('passkeys.remove'),
      message: t('passkeys.removeConfirm', { label: entry.label }),
      confirmLabel: t('passkeys.remove'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const { error: removeError } = await apiAuth.removePasskey(entry.id)
    if (removeError) {
      toast.error(passkeyErrorText(t, removeError))
      return
    }
    setEntries((list) => (list || []).filter((p) => p.id !== entry.id))
    toast.success(t('passkeys.removed'))
  }

  return (
    <section className={className} aria-labelledby="passkey-title" data-testid="passkey-section">
      <div id="passkey-title" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-stone-700">
        <Fingerprint size={15} aria-hidden="true" className="text-stone-400" />
        {t('passkeys.sectionTitle')}
      </div>
      <div className="rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
        <p className="m-0 text-xs text-stone-600">{t('passkeys.sectionHint')}</p>
        <FieldNote>{t('passkeys.ownDeviceOnly')}</FieldNote>
        {loadError && <p role="alert" className="m-0 mt-2 text-xs text-red-700">{loadError}</p>}
        {entries && entries.length === 0 && <p className="m-0 mt-2 text-sm text-stone-500">{t('passkeys.none')}</p>}
        {entries && entries.length > 0 && (
          <ul className="m-0 mt-2 list-none space-y-1.5 p-0" data-testid="passkey-list">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm font-medium text-stone-800">{entry.label}</p>
                  <p className="m-0 text-xs text-stone-500">
                    {[t('passkeys.addedOn', { date: shortDate(entry.created_at, i18n.language) }),
                      entry.last_used_at ? t('passkeys.lastUsed', { date: shortDate(entry.last_used_at, i18n.language) }) : ''
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <IconButton icon={Trash2} label={`${t('passkeys.remove')}: ${entry.label}`} onClick={() => remove(entry)} />
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <form onSubmit={add} className="mt-3 space-y-2">
            <Field label={t('passkeys.passwordPrompt')}>
              <Input size="lg" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            {error && <p role="alert" className="m-0 text-xs text-red-700">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="dark" size="xl" type="submit" className="rounded-lg font-medium" disabled={busy || !password} loading={busy}>
                {busy ? t('passkeys.waiting') : t('passkeys.setUp')}
              </Button>
              <Button variant="secondary" size="xl" type="button" className="rounded-lg font-medium" onClick={() => { setAdding(false); setPassword(''); setError('') }}>
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="dark" size="xl" className="rounded-lg font-medium" onClick={() => setAdding(true)} data-testid="passkey-add">
              {t('passkeys.add')}
            </Button>
          </div>
        )}
        <p className="m-0 mt-2 text-xs text-stone-400">{t('passkeys.privacy')}</p>
      </div>
    </section>
  )
}
