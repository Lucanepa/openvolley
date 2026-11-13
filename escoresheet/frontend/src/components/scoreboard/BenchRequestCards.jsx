import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Timer, ArrowLeftRight, ChevronDown, ChevronUp, Check, ArrowRight } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { askText } from '../../utils/askText'
import { teamBoxStyle } from '../../utils/teamColours'

const KIND_ICON = { lineup: ClipboardList, timeout: Timer, substitution: ArrowLeftRight }
const FRONT = ['IV', 'III', 'II']
const BACK = ['V', 'VI', 'I']

/**
 * The bench requests waiting for the scorer, one card each (team colour,
 * what is asked, Accept / Decline). A stack in the top right corner, never
 * a modal: the scorer goes on scoring and answers when the rally is over
 * (Grant and Accept wait while a rally is in play), or ignores them and
 * records by hand as always. Folds into one pill.
 *
 * Accept runs the scorer's own path: the line-up dialog filled with the
 * bench's line-up (Confirm saves it, with every check), the time-out dialog
 * (with its warnings), each substitution's confirmation (or the illegal
 * substitution warning). The request is answered when the event is recorded
 * (useBenchRequestBridge).
 */
export default function BenchRequestCards({ queue, teams, rallyInPlay, donePairs = {}, unsent = {}, onAcceptLineup, onGrantTimeout, onAcceptPair, respond, top = 112 }) {
  const { t } = useTranslation()
  const [folded, setFolded] = useState(false)
  if (!queue || queue.length === 0) return null

  const decline = async (entry) => {
    const reason = await askText({
      title: t('benchRequests.scorer.declineTitle', 'Decline the request?'),
      message: t('benchRequests.scorer.declineMessage', 'The bench sees that it was declined, and your reason.'),
      label: t('benchRequests.scorer.reason', 'Reason (optional)'),
      confirmLabel: t('benchRequests.scorer.decline', 'Decline')
    })
    if (reason === null) return
    respond(entry.team, entry.request.id, 'declined', reason.trim() || null)
  }

  const title = (entry) => {
    const r = entry.request
    if (r.kind === 'lineup') return t('benchRequests.scorer.lineupTitle', { set: r.setIndex, defaultValue: 'Line-up for set {{set}}' })
    if (r.kind === 'timeout') return t('benchRequests.scorer.timeoutTitle', 'Time-out request')
    return t('benchRequests.scorer.substitutionTitle', 'Substitution request')
  }

  return (
    <div
      className="ov-kit no-print"
      data-bench-request-cards=""
      style={{ position: 'fixed', top: `calc(env(safe-area-inset-top, 0px) + ${top}px)`, right: 8, zIndex: 40, width: 'min(300px, calc(100vw - 16px))', maxHeight: `calc(100dvh - ${top + 16}px)`, overflowY: 'auto' }}
    >
      <button
        type="button"
        onClick={() => setFolded(!folded)}
        aria-expanded={!folded}
        className="ml-auto mb-1.5 flex h-8 items-center gap-1.5 rounded-full bg-slate-900 px-3 text-xs font-semibold text-white shadow-lg"
      >
        {t('benchRequests.scorer.count', { count: queue.length, defaultValue: '{{count}} bench requests' })}
        {folded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
      </button>
      {!folded && (
        <div className="space-y-2">
          {queue.map((entry) => {
            const r = entry.request
            const team = teams?.[entry.team] || {}
            const Icon = KIND_ICON[r.kind] || ClipboardList
            const waitRally = rallyInPlay && r.kind !== 'lineup'
            // own entries only: an id like 'constructor' must not find Object.prototype's
            const done = (Object.hasOwn(donePairs, r.id) && Array.isArray(donePairs[r.id])) ? donePairs[r.id] : []
            return (
              <div key={r.id} data-bench-card={r.kind} data-team={entry.team} className="rounded-2xl border border-stone-200/70 bg-white p-3 shadow-card-lg">
                <div className="flex items-center gap-2">
                  <span className="rounded-md px-2 py-0.5 text-xs font-bold truncate max-w-[45%]" style={teamBoxStyle(team.colour)}>{team.name}</span>
                  <Icon size={15} className="shrink-0 text-stone-500" aria-hidden="true" />
                  <span className="text-sm font-semibold text-stone-900 truncate">{title(entry)}</span>
                </div>

                {r.kind === 'lineup' && (
                  <div className="mt-2">
                    <div className="grid grid-cols-3 gap-1 text-center" aria-label={t('benchRequests.lineup', 'Line-up')}>
                      {[...FRONT, ...BACK].map((pos) => (
                        <div key={pos} className="flex items-baseline justify-center gap-1.5 rounded-md bg-stone-50 border border-stone-200 py-0.5">
                          <span className="text-[10px] font-bold text-stone-400">{pos}</span>
                          <span className="text-base font-bold tabular-nums text-stone-900">{r.lineup?.[pos]}</span>
                        </div>
                      ))}
                    </div>
                    {r.gameCaptain != null && (
                      <p className="mt-1.5 text-xs text-stone-600">{t('benchRequests.scorer.gameCaptain', { number: r.gameCaptain, defaultValue: 'Game captain: {{number}}' })}</p>
                    )}
                  </div>
                )}

                {r.kind === 'substitution' && (
                  <ul className="mt-2 divide-y divide-stone-100 rounded-lg border border-stone-200">
                    {(r.pairs || []).map((p, i) => {
                      const isDone = done.includes(i)
                      return (
                        <li key={i} className="flex items-center justify-between gap-2 px-2 py-1.5">
                          <span className="flex items-center gap-1.5 text-base font-bold tabular-nums">
                            <span className="text-[11px] font-medium text-stone-500">{t('benchRequests.subSheet.off', 'Off')}</span>{p.out}
                            <ArrowRight size={14} className="text-stone-400" aria-hidden="true" />
                            <span className="text-[11px] font-medium text-stone-500">{t('benchRequests.subSheet.on', 'On')}</span>{p.in}
                          </span>
                          {isDone ? (
                            <span className="flex items-center gap-1 text-xs font-medium text-emerald-700"><Check size={14} aria-hidden="true" />{t('benchRequests.scorer.recorded', 'Recorded')}</span>
                          ) : (
                            <Button size="sm" variant="dark" data-bench-pair-accept={i} disabled={waitRally} onClick={() => onAcceptPair(entry, p)}>
                              {t('benchRequests.scorer.substitute', 'Substitute')}
                            </Button>
                          )}
                        </li>
                      )
                    })}
                    {r.gameCaptain != null && (
                      <li className="px-2 py-1.5 text-xs text-stone-600">{t('benchRequests.scorer.gameCaptain', { number: r.gameCaptain, defaultValue: 'Game captain: {{number}}' })}</li>
                    )}
                  </ul>
                )}

                {waitRally && <p className="mt-2 text-xs font-medium text-amber-700">{t('benchRequests.scorer.afterRally', 'After the rally')}</p>}
                {Object.hasOwn(unsent, r.id) && unsent[r.id] === true && <p className="mt-2 text-xs font-medium text-red-700">{t('benchRequests.scorer.notSent', 'Answer not sent: no connection to the server')}</p>}

                <div className="mt-2.5 flex items-center justify-end gap-2">
                  <Button variant="secondary" size="md" data-bench-decline="" onClick={() => decline(entry)}>{t('benchRequests.scorer.decline', 'Decline')}</Button>
                  {r.kind === 'lineup' && (
                    <Button size="md" data-bench-accept="" onClick={() => onAcceptLineup(entry)}>{t('benchRequests.scorer.review', 'Review and accept')}</Button>
                  )}
                  {r.kind === 'timeout' && (
                    <Button size="md" data-bench-accept="" disabled={waitRally} onClick={() => onGrantTimeout(entry)}>{t('benchRequests.scorer.grant', 'Grant time-out')}</Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
