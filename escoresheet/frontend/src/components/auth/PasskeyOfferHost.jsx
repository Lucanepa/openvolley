import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Fingerprint } from 'lucide-react'
import { Button, cn, FOCUS_RING, Notice, toast } from '../../ui'
import { apiAuth } from '../../lib/apiClient'
import { dismissPasskeyOffer, isPasskeyAlreadyHere, isPasskeyCancel, markPasskeyHere, runPasskeySetUp } from '../../lib/passkeys'
import { passkeyErrorText } from './passkeyErrors'
import { clearPasskeyOffer, currentPasskeyOffer, subscribePasskeyOffer } from './passkeyOffer'

/**
 * "Fingerprint next time?" — shown once after a password sign-in on a device
 * that can keep a passkey (LoginModal decides, passkeyOffer.js carries it
 * here). Set up: the server checks the password just typed, then the device's
 * sheet. Not now: remembered for this account in this browser.
 */
export default function PasskeyOfferHost() {
  const { t, i18n } = useTranslation()
  const [offer, setOffer] = useState(() => currentPasskeyOffer())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => subscribePasskeyOffer((next) => { setOffer(next); setError('') }), [])

  if (!offer) return null

  const accept = async () => {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const { error: addError } = await apiAuth.addPasskey({ password: offer.password, lang: i18n.language }, runPasskeySetUp)
      if (addError) {
        setError(passkeyErrorText(t, addError))
        return
      }
      markPasskeyHere(offer.userId, true)
      toast.success(t('passkeys.setUpDone'))
      clearPasskeyOffer()
    } catch (err) {
      if (isPasskeyCancel(err)) return
      if (isPasskeyAlreadyHere(err)) {
        markPasskeyHere(offer.userId, true)
        clearPasskeyOffer()
        return
      }
      setError(passkeyErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  const decline = () => {
    dismissPasskeyOffer(offer.userId)
    clearPasskeyOffer()
  }

  const quietLink = cn('inline-flex min-h-11 w-full items-center justify-center rounded-lg text-sm text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING)

  return (
    <div className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm" style={{ zIndex: 2000 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="passkey-offer-title"
        data-testid="passkey-offer"
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-stone-200/70 bg-white p-6 text-center shadow-card-lg"
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
        <Fingerprint size={34} className="mx-auto text-red-600" aria-hidden="true" />
        <p id="passkey-offer-title" className="mt-3 text-base font-semibold text-stone-900">{t('passkeys.offerTitle')}</p>
        <p className="mt-2 text-sm text-stone-600">{t('passkeys.offerBody')}</p>
        {/* a key on a shared club laptop signs in anyone who can unlock it */}
        <Notice tone="warning" className="mt-3 text-left">{t('passkeys.ownDeviceOnly')}</Notice>
        <p className="mt-2 text-xs text-stone-400">{t('passkeys.privacy')}</p>
        {error && <p role="alert" className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <Button variant="hero" block onClick={accept} disabled={busy} loading={busy} className="mt-4">
          {busy ? t('passkeys.waiting') : t('passkeys.setUp')}
        </Button>
        <button type="button" onClick={decline} disabled={busy} className={quietLink}>
          {t('passkeys.notNow')}
        </button>
      </div>
    </div>
  )
}
