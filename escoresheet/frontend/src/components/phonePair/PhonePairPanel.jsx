import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Keyboard, Loader2, Smartphone, Unlink, X } from 'lucide-react'
import { Button, SegmentedControl, Skeleton, Switch } from '../../ui'
import { usePhoneSignTransports } from '../signature/PhoneSignPanel'
import { rememberTransport } from '../../utils/phoneSignTransport'
import { displayCode, phonePairPageUrl, phonePairUrl } from '../../lib/phonePairApi'
import { phonePairController, usePhonePairState } from './phonePairStore'

const REASON_KEYS = {
  none: 'phonePair.reasonNone',
  signIn: 'phonePair.reasonSignIn',
  role: 'phonePair.reasonRole',
  noNetwork: 'phonePair.reasonNoNetwork',
}

function formatLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** What to say when a pairing could not start (the Sign on phone rules). */
export function pairFailureKey(err, transport) {
  if (err?.status === 401 || err?.code === 'OV_AUTH_REQUIRED') return 'phonePair.reasonSignIn'
  if (transport === 'cloud' && err?.code === 'OV_PAIR_FORBIDDEN') return 'phonePair.reasonRole'
  if (transport === 'cloud' && err?.code === 'OV_PAIR_MATCH') return 'phonePair.notOnServer'
  return 'phonePair.startFailed'
}

/**
 * "Pair a phone" (the Match menu): the QR code and the short code of a new
 * pairing (Stop pairing while it waits), then "Phone connected" with Unpair.
 * One phone at a time: a new pairing ends the one before. Closing the panel
 * keeps the pairing; only Stop / Unpair (here or on the indicator), the
 * match closing, or 6 hours end it.
 *
 * @param {{ match: { matchId, matchKey, gamePin, context }, onClose: () => void, controller?: object }} props
 */
export default function PhonePairPanel({ match, onClose, controller = phonePairController() }) {
  const { t } = useTranslation()
  const state = usePhonePairState()
  const [hallIp, setHallIp] = useState(null)
  const { loading, transports } = usePhoneSignTransports(true, { hallIp })
  const [transport, setTransport] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const way = transport || transports.default
  const current = way ? transports[way] : null
  const both = !!(transports.cloud?.ok && transports.lan?.ok)
  const live = state.status === 'pending' || state.status === 'paired'

  // A new pairing when the panel opens and none is live (or the way changed)
  const start = (w = way, cur = current) => {
    if (!cur?.ok) return
    controller.start({ transport: w, apiBase: cur.apiBase, phoneBase: cur.phoneBase, matchKey: match?.matchKey, context: match?.context, gamePin: match?.gamePin, matchId: match?.matchId })
  }
  useEffect(() => {
    if (loading || live || state.status === 'starting' || state.status === 'error') return
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the ways are known
  }, [loading])

  useEffect(() => {
    if (state.status !== 'pending') return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state.status])

  const handle = state.handle
  const leftMs = handle ? handle.startedAt + 10 * 60 * 1000 - Math.max(now, handle.startedAt) : 0
  const pick = (value) => {
    if (value === way) return
    rememberTransport(value)
    setTransport(value)
    start(value, transports[value])
  }

  const noWay = !loading && !current?.ok
  return (
    <div className="ov-kit flex flex-col gap-3 text-sm" data-testid="phone-pair-panel">
      <p className="m-0 text-stone-600">{t('phonePair.intro')}</p>
      {both && state.status !== 'paired' && (
        <SegmentedControl
          options={[{ value: 'cloud', label: t('phoneSign.transportInternet') }, { value: 'lan', label: t('phoneSign.transportHall') }]}
          value={way}
          onChange={pick}
          ariaLabel={t('phonePair.title')}
        />
      )}
      {way === 'lan' && (transports.lan?.addresses || []).length > 1 && state.status === 'pending' && (
        <SegmentedControl
          options={transports.lan.addresses.map((i) => ({ value: i.ip, label: i.ip }))}
          value={current?.ip}
          onChange={(ip) => { setHallIp(ip); controller.unpair() }}
          ariaLabel={t('connectTablets.address', 'Address')}
        />
      )}

      {noWay && (
        <p className="m-0 rounded-lg bg-amber-50 px-3 py-2 text-amber-800" role="status" data-testid="phone-pair-reason">
          {t(REASON_KEYS[transports.reason] || REASON_KEYS.none)}
        </p>
      )}

      {state.status === 'paired' ? (
        <div className="flex flex-col gap-3" data-testid="phone-pair-connected">
          <p className={`m-0 flex items-center gap-2 text-base font-semibold ${state.phoneConnected ? 'text-emerald-700' : 'text-amber-700'}`} role="status" aria-live="polite">
            <Smartphone size={18} aria-hidden="true" />
            {state.phoneConnected ? t('phonePair.paired') : t('phonePair.phoneAway')}
          </p>
          <p className="m-0 text-stone-600">{t('phonePair.pairedHint')}</p>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-stone-200/70 bg-stone-50/60 px-3 py-2.5">
            <span className="text-stone-800">{t('phonePair.hideKeyboard')}</span>
            <Switch checked={state.hideKeyboard} onCheckedChange={(on) => controller.setHideKeyboard(on)} aria-label={t('phonePair.hideKeyboard')} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger-outline" size="xl" icon={Unlink} onClick={() => controller.unpair()} data-testid="phone-pair-unpair">{t('phonePair.unpair')}</Button>
            <Button variant="dark" size="xl" className="ml-auto" onClick={onClose} data-testid="phone-pair-done">{t('phonePair.done')}</Button>
          </div>
        </div>
      ) : state.status === 'pending' && handle ? (
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <figure className="m-0 flex flex-col items-center gap-1" data-testid="phone-pair-qr">
            <span className="rounded-xl border border-stone-200 bg-white p-3">
              <QRCodeSVG value={phonePairUrl(handle)} size={200} level="M" marginSize={2} title={t('phonePair.scanHint')} />
            </span>
          </figure>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="m-0 flex items-center gap-1.5 font-medium text-amber-700" role="status" aria-live="polite" data-testid="phone-pair-status">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('phonePair.waiting')}
            </p>
            <p className="m-0 text-stone-600">{t('phonePair.scanHint')}</p>
            <p className="m-0 text-stone-600">{t('phonePair.orCode', { url: phonePairPageUrl(handle).replace(/^https?:\/\//, '') })}</p>
            <p className="m-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('phonePair.code')}</span>
              <span className="block font-mono text-3xl font-semibold tracking-[0.3em] text-stone-900 tabular-nums" data-testid="phone-pair-code">{displayCode(handle.code)}</span>
            </p>
            <p className="m-0 tabular-nums text-xs text-stone-500">{t('phonePair.validFor', { time: formatLeft(leftMs) })}</p>
            <span className="sr-only" data-testid="phone-pair-link">{phonePairUrl(handle)}</span>
          </div>
          <div className="sm:col-span-2">
            <Button variant="danger-outline" size="xl" icon={X} onClick={() => controller.unpair()} data-testid="phone-pair-stop">{t('phonePair.stop')}</Button>
          </div>
        </div>
      ) : state.status === 'starting' || (loading && !noWay) ? (
        <Skeleton className="h-[226px] w-[226px] rounded-xl" />
      ) : !noWay ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 font-medium text-stone-700" role="status" data-testid="phone-pair-status">
            {state.status === 'error' ? t(pairFailureKey(state.error, way)) : state.ended === 'unpaired' ? t('phonePair.ended') : state.ended === 'stopped' ? t('phonePair.stopped') : t('phonePair.expired')}
          </p>
          <div>
            <Button variant="secondary" size="xl" icon={Keyboard} onClick={() => { controller.reset(); start() }} data-testid="phone-pair-again">{t('phonePair.newPairing')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
