import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '../../ui'
import { copyToClipboard } from '../../utils/networkInfo'
import { formatLiveCode, liveCodeUrl, liveCourtUrl, localTvUrl, newLiveCode, normalizeLiveCode, setLiveCode, setLiveCourt, useLiveCode, useLiveCourt } from '../../utils/globalLive'
import { getBackendOverride, isStaticDeployment } from '../../utils/backendConfig'
import { detectAppPlatform } from '../../utils/openAppWindow'

/**
 * Options › Live screen (every mode): the live screen for TVs
 * (utils/globalLive.js). One scorer device starts it and gets a live screen
 * code; the other scorer devices of the event enter the same code. The TVs open the link or
 * scan the QR code. Only the score goes to the page, never players.
 */
export default function GlobalLivePanel({ bare = false }) {
  const { t } = useTranslation()
  const code = useLiveCode()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = liveCodeUrl(code)
  const court = useLiveCourt()
  const courtUrl = liveCourtUrl(code, court)
  const venueUrl = code ? venueTvUrl(code) : null

  const join = () => {
    const c = normalizeLiveCode(typed)
    if (!c) { setError(true); return }
    setError(false)
    setTyped('')
    setLiveCode(c)
  }

  return (
    <div className={bare ? '' : 'mt-4 rounded-xl border border-stone-200 p-3'} data-testid="global-live-panel">
      {!bare && <div className="text-sm font-semibold text-stone-900">{t('globalLive.title')}</div>}
      <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{t('globalLive.intro')}</p>
      {code ? (
        <div className="mt-3 flex flex-wrap items-start gap-4">
          <div className="rounded-lg bg-white p-2 ring-1 ring-stone-200"><QRCodeSVG value={url} size={112} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-stone-500">{t('globalLive.codeLabel')}</div>
            <div className="font-mono text-2xl font-semibold tracking-wider text-stone-900" data-testid="global-live-code">{formatLiveCode(code)}</div>
            <div className="mt-1 break-all text-xs text-stone-600" data-testid="global-live-url">{url}</div>
            <p className="mt-1 text-xs text-stone-500">{t('globalLive.smartTv', { url: url.replace(/^https:\/\//, '') })}</p>
            {venueUrl && <p className="mt-1 break-all text-xs text-stone-500" data-testid="global-live-venue-url">{t('globalLive.venueUrl', { url: venueUrl })}</p>}
            <p className="mt-1 text-xs text-stone-500">{t('globalLive.otherDevices')}</p>
            <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
              <span>{t('globalLive.courtLabel')}</span>
              <input
                type="number"
                min="1"
                max="99"
                inputMode="numeric"
                value={court ?? ''}
                onChange={(e) => setLiveCourt(e.target.value === '' ? null : e.target.value)}
                placeholder="–"
                data-testid="global-live-court"
                className="h-9 w-16 rounded-lg border border-stone-300 px-2 text-sm"
              />
            </label>
            {courtUrl && <p className="mt-1 break-all text-xs text-stone-500" data-testid="global-live-court-url">{t('globalLive.courtUrl', { url: courtUrl.replace(/^https:\/\//, '') })}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" size="md" onClick={async () => { setCopied((await copyToClipboard(url))?.success === true) }}>
                {copied ? t('globalLive.copied') : t('globalLive.copyLink')}
              </Button>
              <Button variant="secondary" size="md" data-testid="global-live-off" onClick={() => setLiveCode(null)}>{t('globalLive.turnOff')}</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <Button variant="secondary" size="md" className="self-start" data-testid="global-live-start" onClick={() => setLiveCode(newLiveCode())}>{t('globalLive.start')}</Button>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={typed}
              onChange={(e) => { setTyped(e.target.value); setError(false) }}
              onKeyDown={(e) => { if (e.key === 'Enter') join() }}
              placeholder="ABCD 2345"
              aria-label={t('globalLive.enterCode')}
              data-testid="global-live-input"
              className="h-10 w-36 rounded-lg border border-stone-300 px-3 font-mono uppercase tracking-wider"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
            <Button variant="secondary" size="md" data-testid="global-live-join" onClick={join}>{t('globalLive.join')}</Button>
          </div>
          {error && <p role="alert" className="text-xs text-red-600">{t('globalLive.badCode')}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * The TV page on the venue relay this device scores through, for TVs on the
 * venue's Wi-Fi when it has no internet: a server override (Options › Server)
 * or the relay that served this page. Not the desktop app: its relay
 * (src-tauri relay.rs) has no TV page.
 */
function venueTvUrl(code) {
  if (detectAppPlatform() === 'tauri') return null
  let base = null
  try { base = getBackendOverride() } catch { base = null }
  if (!base && !isStaticDeployment() && typeof window !== 'undefined') base = window.location.origin
  if (!base || /(^|\.)openvolley\.app(:|\/|$)/.test(base.replace(/^https?:\/\//, ''))) return null
  return localTvUrl(base, code)
}
