import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Timer, ArrowLeftRight, X } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { FOCUS_RING } from '../../ui/Button.jsx'
import {
  benchLineupAvailability, benchTimeoutAvailability, benchSubstitutionAvailability,
  latestBenchRequest, isOpenStatus, benchSetIndex
} from '../../domain/benchRequests'
import { useBenchRequests } from './useBenchRequests'
import BenchLineupSheet from './BenchLineupSheet'
import BenchSubstitutionSheet from './BenchSubstitutionSheet'
import { displaySetNumber } from '../../utils/matchFormat'

/**
 * The bench's requests to the scorer (like the bench app of a DataProject
 * e-scoresheet): its starting line-up before each set, a time-out request,
 * a prepared substitution. Three large buttons on one row under the TO / SUB
 * counters, each with what it can do now or the state of its last request
 * (pending, accepted, declined with the scorer's reason). An aid only: the
 * coach still asks the referee as always, the scorer records it.
 */
export default function BenchRequestPanel({ matchId, team, data, players, discStyle }) {
  const { t } = useTranslation()
  const { requests, send, cancel } = useBenchRequests(matchId, team)
  const [sheet, setSheet] = useState(null) // 'lineup' | 'substitution' | null
  const events = useMemo(() => data?.events || [], [data?.events])
  const setIndex = data?.set?.index ?? benchSetIndex(data?.allSets, data?.liveState)
  const intervalRunning = data?.liveState?.set_interval_active === true
  const bestOf = data?.match?.bestOf ?? 5
  const ctx = { match: data?.match, events, setIndex, team, intervalRunning }

  const lineupAvail = benchLineupAvailability(ctx)
  const timeoutAvail = benchTimeoutAvailability(ctx)
  const subAvail = benchSubstitutionAvailability(ctx)

  const lastLineup = latestBenchRequest(requests, 'lineup', setIndex)
  const lastTimeout = latestBenchRequest(requests, 'timeout', setIndex)
  const lastSub = latestBenchRequest(requests, 'substitution', setIndex)
  // An accepted line-up is locked (until the scorer's line-up shows here)
  const lineupLocked = lastLineup?.status === 'accepted'

  const statusText = (r) => {
    if (!r) return null
    const done = t(`benchRequests.done.${r.kind}`, { defaultValue: t('benchRequests.status.accepted') })
    switch (r.status) {
      case 'sending': return t('benchRequests.status.sending')
      case 'pending': return r.delivered === 0 ? t('benchRequests.status.waitingScorer') : t('benchRequests.status.pending')
      case 'seen': return t('benchRequests.status.seen')
      case 'accepted': return done
      case 'declined': return r.reason
        ? t('benchRequests.status.declinedBecause', { reason: r.reason })
        : t('benchRequests.status.declined')
      case 'refused': return t('benchRequests.status.refused', { reason: t(`benchRequests.refusal.${r.reason}`, { defaultValue: t('benchRequests.refusal.other') }) })
      case 'not_sent': return t('benchRequests.status.notSent')
      case 'cancelled': return t('benchRequests.status.cancelled')
      case 'expired': return t('benchRequests.status.expired')
      default: return null
    }
  }
  const tone = (r) => {
    if (!r) return 'quiet'
    if (r.status === 'accepted') return 'done'
    if (r.status === 'declined' || r.status === 'refused' || r.status === 'not_sent') return 'bad'
    if (isOpenStatus(r.status)) return 'open'
    return 'quiet'
  }
  const reasonText = (reason) => t(`benchRequests.unavailable.${reason}`)

  const tiles = [
    {
      key: 'lineup',
      icon: ClipboardList,
      label: t('benchRequests.lineup', 'Line-up'),
      enabled: lineupAvail.allowed && !lineupLocked,
      caption: lineupAvail.allowed
        ? (statusText(lastLineup) || t('benchRequests.forSet', { set: displaySetNumber(setIndex, bestOf) }))
        : (lastLineup?.status === 'accepted' && lineupAvail.reason === 'lineup_entered' ? statusText(lastLineup) : reasonText(lineupAvail.reason)),
      request: lineupAvail.allowed ? lastLineup : null,
      onTap: () => setSheet('lineup')
    },
    {
      key: 'timeout',
      icon: Timer,
      label: t('benchRequests.timeout', 'Time-out'),
      enabled: timeoutAvail.allowed && !isOpenStatus(lastTimeout?.status),
      caption: isOpenStatus(lastTimeout?.status) || (timeoutAvail.allowed && lastTimeout)
        ? statusText(lastTimeout)
        : (timeoutAvail.allowed ? t('benchRequests.tapToRequest') : reasonText(timeoutAvail.reason)),
      request: isOpenStatus(lastTimeout?.status) || timeoutAvail.allowed ? lastTimeout : null,
      onTap: () => send('timeout', setIndex)
    },
    {
      key: 'substitution',
      icon: ArrowLeftRight,
      label: t('benchRequests.substitution', 'Substitution'),
      enabled: subAvail.allowed,
      caption: isOpenStatus(lastSub?.status) || (subAvail.allowed && lastSub)
        ? statusText(lastSub)
        : (subAvail.allowed ? t('benchRequests.prepare') : reasonText(subAvail.reason)),
      request: isOpenStatus(lastSub?.status) || subAvail.allowed ? lastSub : null,
      onTap: () => setSheet('substitution')
    }
  ]

  return (
    <section data-bench-requests="" className="ov-kit" aria-label={t('benchRequests.title', 'Requests to the scorer')}>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((tile) => {
          const Icon = tile.icon
          const tn = tone(tile.request)
          const open = isOpenStatus(tile.request?.status)
          return (
            <div key={tile.key} className="relative min-w-0">
              <button
                type="button"
                data-bench-request={tile.key}
                data-state={tile.request?.status || (tile.enabled ? 'ready' : 'blocked')}
                disabled={!tile.enabled}
                onClick={tile.onTap}
                className={cn(
                  'w-full min-h-[64px] rounded-2xl border px-2 py-2 flex flex-col items-center justify-center gap-0.5 text-center transition-colors',
                  FOCUS_RING,
                  tile.enabled ? 'bg-white border-stone-300 text-stone-900 hover:bg-stone-50 active:bg-stone-100 shadow-card' : 'bg-stone-100 border-stone-200 text-stone-400',
                  open && 'border-sky-300 bg-sky-50 text-sky-950',
                  tn === 'done' && 'border-emerald-300 bg-emerald-50',
                  tn === 'bad' && 'border-red-200 bg-red-50'
                )}
              >
                <span className="flex items-center gap-1.5 text-[15px] sm:text-base font-semibold leading-tight">
                  <Icon size={18} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{tile.label}</span>
                </span>
                <span
                  data-bench-request-caption={tile.key}
                  className={cn(
                    'text-[11px] sm:text-xs leading-snug line-clamp-2',
                    tn === 'done' ? 'text-emerald-800' : tn === 'bad' ? 'text-red-700' : open ? 'text-sky-800' : tile.enabled ? 'text-stone-500' : 'text-stone-500'
                  )}
                >{tile.caption}</span>
              </button>
              {open && tile.request?.status !== 'sending' && (
                <button
                  type="button"
                  data-bench-request-cancel={tile.key}
                  onClick={() => cancel(tile.request)}
                  aria-label={t('benchRequests.cancel', 'Cancel request')}
                  title={t('benchRequests.cancel', 'Cancel request')}
                  className={cn('absolute -top-2 -right-1 h-7 w-7 rounded-full bg-white border border-stone-300 text-stone-600 flex items-center justify-center shadow-sm', FOCUS_RING)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {sheet === 'lineup' && (
        <BenchLineupSheet
          setIndex={setIndex}
          bestOf={bestOf}
          team={team}
          players={players}
          events={events}
          discStyle={discStyle}
          lastRequest={lastLineup}
          reserveBottom={data?.match?.test === true}
          onClose={() => setSheet(null)}
          onSend={(payload) => {
            send('lineup', setIndex, payload)
            setSheet(null)
          }}
        />
      )}
      {sheet === 'substitution' && (
        <BenchSubstitutionSheet
          setIndex={setIndex}
          bestOf={bestOf}
          team={team}
          players={players}
          events={events}
          reserveBottom={data?.match?.test === true}
          onClose={() => setSheet(null)}
          onSend={(payload) => {
            send('substitution', setIndex, payload)
            setSheet(null)
          }}
        />
      )}
    </section>
  )
}
