import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Loader2, Share2, Smartphone, Wifi } from 'lucide-react'
import { Button, SegmentedControl, Skeleton } from '../../ui'
import { useAuth } from '../../contexts/AuthContext'
import { getCloudApiBaseUrl, getLocalServerStatusUrl, isCloudBlockedOnThisPort, isServedFromLanOrigin } from '../../utils/backendConfig'
import { availableTransports, rememberTransport, rememberedTransport } from '../../utils/phoneSignTransport'
import { wifiQrString } from '../../utils/tabletLinks'
import { displayedWifi, firewall, hotspot, isTabletNetworkAvailable, needsFirewallStep } from '../../utils/tabletNetwork'
import { copyToClipboard } from '../../utils/networkInfo'
import * as defaultApi from '../../lib/phoneSignApi'
import { phoneSignatureDataUrl, validateStrokes } from '../../domain/phoneSignature'
import { FirewallTip } from '../connect/NetworkPanels'

const LAN_HINT_MS = 45000
const RETRY_MS = 2000
const GIVE_UP_AFTER_MS = 5 * 60 * 1000

function readConnectView() {
  try { return JSON.parse(localStorage.getItem('ov_connect_tablets_view') || 'null') || {} } catch { return {} }
}

/**
 * The ways a phone can reach a signing session right now (utils/phoneSignTransport),
 * read once when `active` turns on: the account, the connection, the relay that
 * serves this page and (desktop app) the laptop's own Wi-Fi.
 * @returns {{ loading: boolean, transports: ReturnType<typeof availableTransports> }}
 */
export function usePhoneSignTransports(active, { fetchImpl = typeof fetch === 'function' ? fetch : null, win = typeof window !== 'undefined' ? window : undefined, hallIp = null } = {}) {
  // Outside an AuthProvider (a test, an embedded page) there is no account
  let auth = null
  try { auth = useAuth() || null } catch { auth = null }
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const [relay, setRelay] = useState({ loading: false, status: null })
  const [hs, setHs] = useState(null)
  const [fw, setFw] = useState(undefined)
  const statusUrl = getLocalServerStatusUrl()
  const desktop = isTabletNetworkAvailable(win)

  useEffect(() => {
    if (!active || typeof window === 'undefined') return undefined
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [active])

  useEffect(() => {
    if (!active || !statusUrl || !fetchImpl) return undefined
    let cancelled = false
    setRelay((r) => ({ ...r, loading: true }))
    fetchImpl(statusUrl, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((status) => { if (!cancelled) setRelay({ loading: false, status: status && typeof status === 'object' ? status : null }) })
      .catch(() => { if (!cancelled) setRelay({ loading: false, status: null }) })
    return () => { cancelled = true }
  }, [active, statusUrl, fetchImpl])

  useEffect(() => {
    if (!active || !desktop) return undefined
    let cancelled = false
    hotspot.status(win).then((s) => { if (!cancelled) setHs(s || null) }).catch(() => {})
    firewall.status(win).then((s) => { if (!cancelled) setFw(s || null) }).catch(() => { if (!cancelled) setFw(null) })
    return () => { cancelled = true }
  }, [active, desktop, win])

  const transports = useMemo(() => {
    const cloudBlocked = isCloudBlockedOnThisPort()
    const view = readConnectView()
    const t = availableTransports({
      online,
      cloudApiBase: cloudBlocked ? null : getCloudApiBaseUrl(),
      cloudBlocked,
      signedIn: !!auth?.user,
      access: auth?.access || null,
      relayOrigin: statusUrl && relay.status ? new URL(statusUrl).origin : null,
      relayStatus: relay.status,
      pageOrigin: typeof window !== 'undefined' ? window.location.origin : null,
      pageOnLanAddress: isServedFromLanOrigin(),
      lanMode: view.lanMode === 'laptop' ? 'laptop' : 'hall',
      hallIp,
      hotspot: hs,
      remembered: rememberedTransport(),
    })
    if (t.lan.ok && t.lan.wifiStep) {
      const wifi = displayedWifi(hs)
      t.lan.wifi = wifi?.ssid && wifi?.password ? wifi : null
    }
    t.lan.firewallStep = desktop && needsFirewallStep(fw, hs)
    return t
  }, [online, auth?.user, auth?.access, statusUrl, relay.status, hs, fw, desktop, hallIp])

  return { loading: relay.loading, transports }
}

function formatLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * "Sign on phone" inside the signature modal (spec 5.3): starts a session on
 * the chosen transport, shows the QR code of the phone page, the link to copy
 * or share and the live state, then the received signature to use or
 * discard. Unmounting (the modal closed by any route) aborts the wait and
 * closes the session. Nothing is started before it mounts.
 *
 * @param {{
 *   transports: ReturnType<typeof availableTransports>,
 *   slot: string, matchKey?: string|null, context: object, gamePin?: string|null,
 *   onUse: (dataUrl: string, meta: { source: 'phone', transport: 'cloud'|'lan' }) => void,
 *   onHallIp?: (ip: string) => void,
 *   onOpenConnectTablets?: () => void,
 *   api?: { startPhoneSign, waitPhoneSign, closePhoneSign, phoneSignUrl },
 *   renderSignature?: (pad, strokes) => string,
 * }} props
 */
export default function PhoneSignPanel({ transports, slot, matchKey = null, context, gamePin = null, onUse, onHallIp, onOpenConnectTablets, api = defaultApi, renderSignature = phoneSignatureDataUrl }) {
  const { t } = useTranslation()
  const [transport, setTransport] = useState(() => transports?.default || 'cloud')
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState('starting') // starting | waiting | opened | received | expired | cancelled | error
  const [handle, setHandle] = useState(null)
  const [signature, setSignature] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [lanHint, setLanHint] = useState(false)
  const [copyState, setCopyState] = useState(null) // 'copied' | 'failed' | null
  const [startError, setStartError] = useState(null) // why start failed: { status, code }
  const handleRef = useRef(null)
  const fellBackRef = useRef(false)

  const both = !!(transports?.cloud?.ok && transports?.lan?.ok)
  const current = transports?.[transport]

  const closeSession = useCallback((keepalive = false) => {
    const h = handleRef.current
    handleRef.current = null
    if (h) api.closePhoneSign(h, { keepalive })
  }, [api])

  // Start, then follow the session until it is signed, expired or closed
  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    setPhase('starting')
    setHandle(null)
    setSignature(null)
    setLanHint(false)
    setStartError(null)
    const run = async () => {
      if (!current?.ok) {
        setPhase('error')
        return
      }
      const r = await api.startPhoneSign({ transport, apiBase: current.apiBase, phoneBase: current.phoneBase, slot, matchKey, context, gamePin })
      if (!alive) {
        if (r.ok) api.closePhoneSign(r.handle, { keepalive: true })
        return
      }
      if (!r.ok) {
        // Offline / unreachable / an older relay: the other way, once
        const other = transport === 'cloud' ? 'lan' : 'cloud'
        if (!fellBackRef.current && transports?.[other]?.ok && (r.network || r.status >= 500 || r.code === 'OV_SIGN_UNSUPPORTED')) {
          fellBackRef.current = true
          setTransport(other)
          return
        }
        setStartError({ status: r.status, code: r.code })
        setPhase('error')
        return
      }
      handleRef.current = r.handle
      setHandle(r.handle)
      setPhase('waiting')
      let known = 'pending'
      while (alive) {
        const w = await api.waitPhoneSign(r.handle, known, { signal: ac.signal })
        if (!alive) return
        if (!w.ok) {
          if (w.code === 'OV_SIGN_ABORTED') return
          if (w.code === 'OV_SIGN_NOT_FOUND') { setPhase('expired'); return } // the relay restarted (D4)
          // Unreachable past the link's life (plus the relay's 5 min for a
          // signature not yet fetched): nothing can come any more, stop asking
          if (Date.now() > r.handle.startedAt + r.handle.ttlSeconds * 1000 + GIVE_UP_AFTER_MS) { setPhase('expired'); return }
          await new Promise((res) => setTimeout(res, RETRY_MS))
          continue
        }
        if (w.state === 'pending' || w.state === 'opened') {
          known = w.state
          if (w.state === 'opened') setPhase('opened')
        } else if (w.state === 'signed') {
          if (!validateStrokes(w.pad, w.strokes).ok) { setPhase('error'); return }
          setSignature(renderSignature(w.pad, w.strokes))
          setPhase('received')
          return
        } else if (w.state === 'closed') {
          setPhase('cancelled')
          return
        } else {
          setPhase('expired')
          return
        }
      }
    }
    run()
    return () => {
      alive = false
      ac.abort()
      closeSession(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new session per attempt / transport only
  }, [attempt, transport])

  // The tab or app goes away: the link stops working
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onHide = () => closeSession(true)
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [closeSession])

  // Countdown on this device's clock
  const live = phase === 'waiting' || phase === 'opened'
  useEffect(() => {
    if (!live || !handle) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, handle])
  const leftMs = handle ? handle.startedAt + handle.ttlSeconds * 1000 - Math.max(now, handle.startedAt) : 0
  useEffect(() => {
    if (live && handle && leftMs <= 0) setPhase('expired')
  }, [live, handle, leftMs])

  // The hall Wi-Fi may keep devices apart: say so after 45 s without the phone
  useEffect(() => {
    if (phase !== 'waiting' || transport !== 'lan') return undefined
    const timer = setTimeout(() => setLanHint(true), LAN_HINT_MS)
    return () => clearTimeout(timer)
  }, [phase, transport])

  const url = handle ? api.phoneSignUrl(handle) : ''
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const shareLink = async () => {
    if (!url) return
    if (canShare) {
      try {
        await navigator.share({ url })
        return
      } catch (err) {
        if (err?.name === 'AbortError') return
      }
    }
    const res = await copyToClipboard(url)
    setCopyState(res?.success ? 'copied' : 'failed')
    setTimeout(() => setCopyState(null), 4000)
  }

  const newLink = () => {
    closeSession()
    fellBackRef.current = false
    setAttempt((n) => n + 1)
  }
  const use = () => {
    if (!signature) return
    closeSession()
    onUse(signature, { source: 'phone', transport })
  }
  const pickTransport = (value) => {
    if (value === transport) return
    rememberTransport(value)
    closeSession()
    fellBackRef.current = false
    setTransport(value)
  }

  const transportOptions = [
    { value: 'cloud', label: t('phoneSign.transportInternet') },
    { value: 'lan', label: t('phoneSign.transportHall') },
  ]
  const addresses = transport === 'lan' && !current?.wifiStep ? (transports?.lan?.addresses || []) : []
  const wifiQr = transport === 'lan' && current?.wifi ? wifiQrString(current.wifi) : null

  return (
    <div className="flex flex-col gap-3" data-testid="phone-sign-panel">
      {both && phase !== 'received' && (
        <SegmentedControl options={transportOptions} value={transport} onChange={pickTransport} ariaLabel={t('phoneSign.signOnPhone')} />
      )}
      {addresses.length > 1 && phase !== 'received' && (
        <SegmentedControl
          options={addresses.map((i) => ({ value: i.ip, label: i.ip }))}
          value={current?.ip}
          onChange={(ip) => { closeSession(); onHallIp?.(ip); setAttempt((n) => n + 1) }}
          ariaLabel={t('connectTablets.address', 'Address')}
         
        />
      )}

      {phase === 'received' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-center overflow-hidden rounded-xl border border-stone-300 bg-white" style={{ height: 200 }}>
            <img src={signature} alt={t('common.signature')} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} data-testid="phone-signature-preview" />
          </div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
            <Smartphone size={15} aria-hidden="true" />
            {t('phoneSign.received')}
          </p>
          <div className="ov-kit flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="xl" className="font-medium" onClick={newLink} data-testid="phone-sign-discard">{t('phoneSign.discard')}</Button>
            <Button variant="positive" size="xl" className="ml-auto" icon={Check} onClick={use} data-testid="phone-sign-use">{t('phoneSign.useSignature')}</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <div className="flex flex-col items-center gap-2">
            {wifiQr && (
              <figure className="flex flex-col items-center gap-1 rounded-xl border border-stone-200/70 bg-stone-50/60 p-2" data-testid="phone-sign-wifi-qr">
                <span className="rounded-lg bg-white p-2"><QRCodeSVG value={wifiQr} size={132} level="M" marginSize={1} /></span>
                <figcaption className="text-center text-xs text-stone-600">
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('connectTablets.step1', 'Step 1')}</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-stone-800"><Wifi size={12} aria-hidden="true" />{t('phoneSign.joinWifiFirst')}</span>
                  <span className="block font-mono">{current.wifi.ssid}</span>
                </figcaption>
              </figure>
            )}
            <figure className="flex flex-col items-center gap-1" data-testid="phone-sign-qr">
              {handle && live ? (
                <span className="rounded-xl border border-stone-200 bg-white p-3">
                  <QRCodeSVG value={url} size={wifiQr ? 160 : 200} level="M" marginSize={2} title={t('phoneSign.scanHint')} />
                </span>
              ) : phase === 'starting' ? (
                <Skeleton className="h-[226px] w-[226px] rounded-xl" />
              ) : (
                <div className="flex h-[226px] w-[226px] items-center justify-center rounded-xl border border-dashed border-stone-300 px-4 text-center text-xs text-stone-400">
                  <Smartphone size={28} aria-hidden="true" />
                </div>
              )}
              {wifiQr && <figcaption className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('connectTablets.step2', 'Step 2')}</figcaption>}
            </figure>
          </div>

          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <StatusLine phase={phase} t={t} failure={startFailureKey(startError, transport)} />
            {live && (
              <>
                <p className="text-stone-600">{t('phoneSign.scanHint')}</p>
                <p className="tabular-nums text-xs text-stone-500" data-testid="phone-sign-countdown">{t('phoneSign.validFor', { time: formatLeft(leftMs) })}</p>
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-stone-600" data-testid="phone-sign-link">{url}</span>
                </div>
                <div className="ov-kit flex flex-wrap gap-2">
                  <Button variant="secondary" size="xl" className="font-medium" icon={canShare ? Share2 : Copy} onClick={shareLink} data-testid="phone-sign-copy">
                    {canShare ? t('phoneSign.sendLink') : t('phoneSign.copyLink')}
                  </Button>
                </div>
                {copyState && (
                  <p className="text-xs text-stone-600" role="status">
                    {copyState === 'copied' ? t('phoneSign.linkCopied') : t('phoneSign.copyFailedUseQr')}
                  </p>
                )}
                {transport === 'lan' && current?.firewallStep && <FirewallTip />}
                {lanHint && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-800" data-testid="phone-sign-hall-hint">
                    {t('phoneSign.hallBlocked')}
                    {onOpenConnectTablets && (
                      <button type="button" className="ml-1 font-semibold underline" onClick={onOpenConnectTablets}>{t('phoneSign.openConnectTablets')}</button>
                    )}
                  </p>
                )}
              </>
            )}
            {(phase === 'expired' || phase === 'cancelled' || phase === 'error') && (
              <div className="ov-kit">
                <Button variant="secondary" size="xl" className="font-medium" onClick={newLink} data-testid="phone-sign-new-link">{t('phoneSign.newLink')}</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * What to say when a link could not be made: the account's session ran out
 * (401), the account may not start one (403 on the internet), else the
 * generic "try again".
 */
export function startFailureKey(err, transport) {
  if (err?.status === 401 || err?.code === 'OV_AUTH_REQUIRED') return 'phoneSign.reasonSignIn'
  if (transport === 'cloud' && err?.code === 'OV_SIGN_FORBIDDEN') return 'phoneSign.reasonRole'
  return 'phoneSign.startFailed'
}

function StatusLine({ phase, t, failure = 'phoneSign.startFailed' }) {
  if (phase === 'starting') {
    return <p className="flex items-center gap-1.5 text-stone-500" role="status" aria-live="polite"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('phoneSign.waiting')}</p>
  }
  if (phase === 'waiting') {
    return <p className="flex items-center gap-1.5 font-medium text-amber-700" role="status" aria-live="polite" data-testid="phone-sign-status"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('phoneSign.waiting')}</p>
  }
  if (phase === 'opened') {
    return <p className="flex items-center gap-1.5 font-medium text-amber-700" role="status" aria-live="polite" data-testid="phone-sign-status"><Smartphone size={14} aria-hidden="true" />{t('phoneSign.opened')}</p>
  }
  const text = phase === 'expired' ? t('phoneSign.expired') : phase === 'cancelled' ? t('phoneSign.cancelled') : t(failure)
  return <p className="font-medium text-stone-700" role="status" aria-live="polite" data-testid="phone-sign-status">{text}</p>
}
