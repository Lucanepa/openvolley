import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IdCard } from 'lucide-react'
import { Button, cn, Field, FOCUS_RING, Input, toast } from '../../ui'
import { useAuth } from '../../contexts/AuthContext'
import { PROFILE_NOT_SAVED } from './profileWrite'
import { licenceInput, licenceOk, licenceValue } from './licenceNumber'
import { clearLicenceAsk, currentLicenceAsk, postponeLicenceAsk, subscribeLicenceAsk } from './licenceAsk'
import { currentPasskeyOffer, subscribePasskeyOffer } from './passkeyOffer'

/**
 * "Your licence number?" — for an account without one (owner 23.11.2026:
 * sign-up needs it now; the accounts made before are asked at their next
 * sign-in, licenceAsk.js). Shown once the profile is known and has no
 * licence number, after the passkey offer when there is one. Save writes the
 * profile's licence number only; Later waits for the next sign-in.
 */
export default function LicenceAskHost() {
  const { t } = useTranslation()
  const { user, profile, updateLicenceNumber } = useAuth()
  const [ask, setAsk] = useState(() => currentLicenceAsk())
  const [passkeyOffer, setPasskeyOffer] = useState(() => currentPasskeyOffer())
  const [licence, setLicence] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => subscribeLicenceAsk((next) => { setAsk(next); setError('') }), [])
  useEffect(() => subscribePasskeyOffer(setPasskeyOffer), [])

  // Asked for another account (signed out, someone else signed in) or one
  // that has a licence number meanwhile: nothing to ask
  const forUser = !!ask && !!user?.id && ask.userId === user.id
  const has = !!profile?.license_number
  useEffect(() => {
    if (ask && profile && (has || (user?.id && ask.userId !== user.id))) clearLicenceAsk()
  }, [ask, profile, has, user?.id])

  if (!forUser || !profile || has || passkeyOffer) return null

  const save = async (e) => {
    e?.preventDefault?.()
    if (busy) return
    if (!licenceValue(licence)) { setError(t('auth.licenceNumberRequired')); return }
    if (!licenceOk(licence)) { setError(t('auth.licenceNumberInvalid')); return }
    setBusy(true)
    const { error: saveError } = await updateLicenceNumber(licenceValue(licence))
    setBusy(false)
    if (saveError) {
      setError(saveError.code === PROFILE_NOT_SAVED ? t('auth.profileNotSaved') : (saveError.message || t('auth.profileNotSaved')))
      return
    }
    toast.success(t('auth.licenceAsk.saved'))
    setLicence('')
    clearLicenceAsk()
  }

  const later = () => {
    if (busy) return
    setLicence('')
    postponeLicenceAsk(user.id)
  }

  const quietLink = cn('inline-flex min-h-11 w-full items-center justify-center rounded-lg text-sm text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING)

  return (
    <div className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm" style={{ zIndex: 2000 }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="licence-ask-title"
        data-testid="licence-ask"
        onSubmit={save}
        noValidate
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-stone-200/70 bg-white p-6 text-center shadow-card-lg"
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
        <IdCard size={34} className="mx-auto text-red-600" aria-hidden="true" />
        <p id="licence-ask-title" className="mt-3 text-base font-semibold text-stone-900">{t('auth.licenceAsk.title')}</p>
        <p className="mt-2 text-sm text-stone-600">{t('auth.licenceAsk.body')}</p>
        <div className="mt-4 text-left">
          <Field label={t('auth.licenceNumber')} hint={t('auth.licenceNumberHint')} error={error}>
            <Input
              size="lg"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={licence}
              onChange={(e) => { setLicence(licenceInput(e.target.value)); setError('') }}
              autoComplete="off"
              autoFocus
              required
              aria-required="true"
              data-testid="licence-ask-input"
            />
          </Field>
        </div>
        <Button type="submit" variant="hero" block disabled={busy} loading={busy} className="mt-4" data-testid="licence-ask-save">
          {t('auth.licenceAsk.save')}
        </Button>
        <button type="button" onClick={later} disabled={busy} className={quietLink} data-testid="licence-ask-later">
          {t('auth.licenceAsk.later')}
        </button>
      </form>
    </div>
  )
}
