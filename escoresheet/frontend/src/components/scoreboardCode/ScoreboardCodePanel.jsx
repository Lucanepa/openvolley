import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Copy, Loader2, MonitorPlay, RefreshCw, Unlink } from 'lucide-react'
import { Button, Skeleton, confirmDialog } from '../../ui'
import { dayLabel, timeLabel } from '../../ui/format'
import { boardPageUrl, displayScoreboardCode, relayStatusUrl, scoreboardCodes } from '../../utils/scoreboardCode'
import { scorerRelay } from '../../utils/relayPublisher'
import { isLocalRelayUrl } from '../../utils/backendConfig'
import { copyToClipboard } from '../../utils/networkInfo'

/** "20:45", or "22.11. 08:45" when it ends on another day than today. */
export function validUntilLabel(endsAt, now = Date.now()) {
  if (!Number.isFinite(endsAt)) return ''
  return dayLabel(endsAt) === dayLabel(now) ? timeLabel(endsAt) : `${dayLabel(endsAt)} ${timeLabel(endsAt)}`
}

const STATE_KEYS = {
  active: 'scoreboardCode.stateActive',
  waiting: 'scoreboardCode.stateWaiting',
  offline: 'scoreboardCode.stateOffline',
}
const REFUSED_KEYS = {
  expired: 'scoreboardCode.stateExpired',
  taken: 'scoreboardCode.stateTaken',
}

/**
 * "Show on a scoreboard": the match's scoreboard code and a QR code of the
 * board page with it, how long it is valid, whether the relay knows it, New
 * code and Stop sharing. Opening it makes a code when the match has none.
 * Closing it keeps the code: boards go on following.
 *
 * @param {{ match: { matchId, relayKey }, onClose: () => void, codes?: ReturnType<import('../../utils/scoreboardCode').createScoreboardCodes>, relay?: object, fetchImpl?: typeof fetch }} props
 */
export default function ScoreboardCodePanel({ match, onClose, codes = scoreboardCodes, relay = scorerRelay, fetchImpl = typeof fetch === 'function' ? fetch : null }) {
  const { t } = useTranslation()
  const matchId = match?.matchId ?? null
  const state = useSyncExternalStore(codes.subscribe, () => codes.get(matchId), () => null)
  const [stopped, setStopped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [relayStatus, setRelayStatus] = useState(null)
  const [copied, setCopied] = useState(false)
  const lan = !!relay?.url && isLocalRelayUrl(relay.url)

  useEffect(() => {
    if (matchId == null || !match?.relayKey) return
    codes.ensure({ matchId, relayKey: match.relayKey }).catch((err) => console.warn('[ScoreboardCode] could not make a code:', err?.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per match
  }, [matchId, match?.relayKey])

  // A relay of the hall: the board page is on its LAN address
  useEffect(() => {
    if (!lan || !fetchImpl) return undefined
    const url = relayStatusUrl()
    if (!url) return undefined
    let cancelled = false
    fetchImpl(url, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (!cancelled) setRelayStatus(s && typeof s === 'object' ? s : null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [lan, fetchImpl])

  const renew = async () => {
    const ok = await confirmDialog({ title: t('scoreboardCode.newCodeTitle'), message: t('scoreboardCode.newCodeBody'), confirmLabel: t('scoreboardCode.newCode'), tone: 'danger' })
    if (!ok) return
    setBusy(true)
    try { await codes.renew({ matchId, relayKey: match.relayKey }) } finally { setBusy(false) }
  }
  const stop = async () => {
    const ok = await confirmDialog({ title: t('scoreboardCode.stopTitle'), message: t('scoreboardCode.stopBody'), confirmLabel: t('scoreboardCode.stop'), tone: 'danger' })
    if (!ok) return
    setBusy(true)
    try {
      await codes.stop({ matchId, relayKey: match.relayKey })
      setStopped(true)
    } finally { setBusy(false) }
  }
  const make = async () => {
    setBusy(true)
    try {
      await codes.ensure({ matchId, relayKey: match.relayKey })
      setStopped(false)
    } finally { setBusy(false) }
  }

  if (!match?.relayKey) {
    return (
      <div className="ov-kit flex flex-col gap-3 text-sm" data-testid="scoreboard-code-panel">
        <p className="m-0 rounded-lg bg-amber-50 px-3 py-2 text-amber-800" role="status">{t('scoreboardCode.noMatchKey')}</p>
        <div className="flex justify-end"><Button variant="dark" size="xl" onClick={onClose}>{t('scoreboardCode.done')}</Button></div>
      </div>
    )
  }

  const url = state?.code ? boardPageUrl(state.code, { relayUrl: relay?.url ?? null, relayStatus }) : null
  const shownUrl = url ? url.split('#')[0].replace(/^https?:\/\//, '') : ''
  // The same board as a score bug for a live stream (components/board/BoardOverlay)
  const streamUrl = url ? url.replace('#', '?overlay#') : null
  const statusKey = state?.relay === 'refused'
    ? (REFUSED_KEYS[state.reason] || 'scoreboardCode.stateRefused')
    : STATE_KEYS[state?.relay] || STATE_KEYS.waiting
  const tone = state?.relay === 'active' ? 'text-emerald-700' : state?.relay === 'refused' ? 'text-red-700' : 'text-amber-700'

  return (
    <div className="ov-kit flex flex-col gap-3 text-sm" data-testid="scoreboard-code-panel">
      <p className="m-0 text-stone-600">{t('scoreboardCode.intro')}</p>
      {stopped ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 font-medium text-stone-700" role="status" data-testid="scoreboard-code-stopped">{t('scoreboardCode.stopped')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="xl" icon={MonitorPlay} onClick={make} loading={busy} data-testid="scoreboard-code-make">{t('scoreboardCode.make')}</Button>
            <Button variant="dark" size="xl" className="ml-auto" onClick={onClose}>{t('scoreboardCode.done')}</Button>
          </div>
        </div>
      ) : !state?.code ? (
        <Skeleton className="h-[226px] w-[226px] rounded-xl" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
            {url && (
              <figure className="m-0 flex flex-col items-center gap-1" data-testid="scoreboard-code-qr">
                <span className="rounded-xl border border-stone-200 bg-white p-3">
                  <QRCodeSVG value={url} size={200} level="M" marginSize={2} title={t('scoreboardCode.title')} />
                </span>
              </figure>
            )}
            <div className="flex min-w-0 flex-col gap-2">
              <p className={`m-0 flex items-center gap-1.5 font-medium ${tone}`} role="status" aria-live="polite" data-testid="scoreboard-code-status">
                {state.relay === 'waiting' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t(statusKey)}
              </p>
              {state.following && state.relay === 'active' && (
                <p className="m-0 text-emerald-700" data-testid="scoreboard-code-following">{t('scoreboardCode.following')}</p>
              )}
              {url && <p className="m-0 text-stone-600 break-words">{t('scoreboardCode.openAndType', { url: shownUrl })}</p>}
              <p className="m-0">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('scoreboardCode.code')}</span>
                <span className="block font-mono text-3xl font-semibold tracking-[0.3em] text-stone-900 tabular-nums" data-testid="scoreboard-code">{displayScoreboardCode(state.code)}</span>
              </p>
              <p className="m-0 tabular-nums text-xs text-stone-500">{t('scoreboardCode.validUntil', { time: validUntilLabel(state.endsAt) })}</p>
              <p className="m-0 text-xs text-stone-500">{t('scoreboardCode.readOnly')}</p>
              {url && <span className="sr-only" data-testid="scoreboard-code-link">{url}</span>}
              {streamUrl && (
                <div className="flex flex-col gap-1 border-t border-stone-100 pt-2" data-testid="scoreboard-code-stream">
                  <p className="m-0 text-xs text-stone-600">{t('scoreboardCode.streamOverlay')}</p>
                  <p className="m-0 break-all font-mono text-xs text-stone-800" data-testid="scoreboard-code-stream-link">{streamUrl}</p>
                  <Button variant="ghost" size="sm" icon={Copy} className="self-start" onClick={async () => { setCopied((await copyToClipboard(streamUrl))?.success === true) }} data-testid="scoreboard-code-stream-copy">
                    {copied ? t('scoreboardCode.copied') : t('scoreboardCode.copyLink')}
                  </Button>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="xl" icon={RefreshCw} onClick={renew} disabled={busy} data-testid="scoreboard-code-new">{t('scoreboardCode.newCode')}</Button>
            <Button variant="danger-outline" size="xl" icon={Unlink} onClick={stop} disabled={busy} data-testid="scoreboard-code-stop">{t('scoreboardCode.stop')}</Button>
            <Button variant="dark" size="xl" className="ml-auto" onClick={onClose} data-testid="scoreboard-code-done">{t('scoreboardCode.done')}</Button>
          </div>
        </>
      )}
    </div>
  )
}
