import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, X, ArrowRight } from 'lucide-react'
import { Modal } from '../../ui/Modal.jsx'
import { Button } from '../../ui/Button.jsx'
import { cn } from '../../ui/cn.js'
import { FOCUS_RING } from '../../ui/Button.jsx'
import { benchSubstitutionChoices } from '../../domain/benchRequests'

const str = (v) => (v === undefined || v === null ? '' : String(v))

/**
 * Prepare a substitution (FIVB 15.5, 15.6): who goes off (on court), who
 * comes on for him (bench), one pair after the other, several in one request
 * (15.10.3). Who may not come on is greyed with why, by the scorer's own rule
 * (domain/interruptionRequests substituteInIllegalReason). When the court
 * captain goes off, the coach names the new game captain (5.2).
 */
export default function BenchSubstitutionSheet({ setIndex, team, players = [], events = [], onClose, onSend, reserveBottom = false }) {
  const { t } = useTranslation()
  const [pairs, setPairs] = useState([])
  const [out, setOut] = useState(null)
  const [gameCaptain, setGameCaptain] = useState('')
  const choices = useMemo(() => benchSubstitutionChoices({ events, setIndex, team, players, pairs }), [events, setIndex, team, players, pairs])
  const candidates = out != null ? choices.candidatesFor(out) : []
  const full = choices.remaining <= 0
  const needCaptain = choices.captainGoesOff
  const captainOk = !needCaptain || choices.gameCaptainChoices.includes(str(gameCaptain))
  const canSend = pairs.length > 0 && out == null && captainOk
  const reasonText = (code) => t(`benchRequests.subSheet.why.${code}`, { defaultValue: t(`scoreboard.requestWarning.illegalShort.${code}`, { defaultValue: code }) })

  const chip = ({ number, reason, onTap, selected = false, testAttr }) => (
    <button
      key={number}
      type="button"
      {...testAttr}
      disabled={!!reason}
      aria-pressed={selected}
      title={reason ? reasonText(reason) : undefined}
      onClick={onTap}
      className={cn('min-h-12 min-w-14 px-2 py-1 rounded-xl border flex flex-col items-center justify-center leading-tight', FOCUS_RING,
        reason ? 'bg-stone-100 border-stone-200 text-stone-400' : selected ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-stone-300 text-stone-800 hover:bg-stone-50')}
    >
      <span className="text-lg font-bold tabular-nums">{number}</span>
      {reason && <span className="text-[10px] font-medium max-w-[7rem]">{reasonText(reason)}</span>}
    </button>
  )

  return (
    <Modal
      open
      sheet
      size="md"
      className="ov-kit"
      onClose={onClose}
      closeLabel={t('common.close', 'Close')}
      title={t('benchRequests.subSheet.title', { set: setIndex, defaultValue: 'Prepare substitution · set {{set}}' })}
      description={t('benchRequests.subSheet.left', { count: choices.remaining, defaultValue: '{{count}} substitutions left in this set' })}
      footer={(
        // the test match's badge (fixed, bottom right) stays clear of the buttons
        <div className="flex w-full flex-col items-end">
          <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button size="lg" icon={Send} data-bench-sub-send="" disabled={!canSend} onClick={() => onSend({ pairs, ...(needCaptain ? { gameCaptain: Number(gameCaptain) } : {}) })}>
            {t('benchRequests.subSheet.send', { count: pairs.length, defaultValue: 'Send ({{count}})' })}
          </Button>
          </div>
          {reserveBottom && <div className="h-9 sm:hidden" aria-hidden="true" />}
        </div>
      )}
    >
      {pairs.length > 0 && (
        <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200" data-sub-pairs="">
          {pairs.map((p, i) => (
            <li key={`${p.out}-${p.in}`} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="flex items-center gap-2 text-base font-semibold tabular-nums">
                <span className="text-stone-500 text-xs font-medium">{t('benchRequests.subSheet.off', 'Off')}</span>{p.out}
                <ArrowRight size={16} className="text-stone-400" aria-hidden="true" />
                <span className="text-stone-500 text-xs font-medium">{t('benchRequests.subSheet.on', 'On')}</span>{p.in}
              </span>
              <button
                type="button"
                onClick={() => setPairs(pairs.filter((_, j) => j !== i))}
                aria-label={t('benchRequests.subSheet.remove', 'Remove')}
                title={t('benchRequests.subSheet.remove', 'Remove')}
                className={cn('h-9 w-9 rounded-lg border border-stone-200 text-stone-500 flex items-center justify-center', FOCUS_RING)}
              ><X size={16} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}

      {out == null ? (
        <div className="space-y-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-800">{t('benchRequests.subSheet.pickOff', 'Who goes off?')}</span>
          {full ? (
            <p className="text-sm text-stone-600">{t('benchRequests.unavailable.substitution_limit')}</p>
          ) : (
            <div className="flex flex-wrap gap-2" data-sub-off="">
              {choices.onCourt.map((c) => chip({
                number: c.number,
                reason: c.reason,
                onTap: () => setOut(c.number),
                testAttr: { 'data-sub-out': String(c.number) }
              }))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-stone-800">{t('benchRequests.subSheet.pickOn', { out, defaultValue: 'Who comes on for {{out}}?' })}</span>
            <Button variant="ghost" size="sm" onClick={() => setOut(null)}>{t('common.back', 'Back')}</Button>
          </div>
          <div className="flex flex-wrap gap-2" data-sub-on="">
            {candidates.length === 0 && <p className="text-sm text-stone-600">{t('benchRequests.subSheet.nobody', 'Nobody on the bench may come on.')}</p>}
            {candidates.map((c) => chip({
              number: c.number,
              reason: c.reason,
              onTap: () => { setPairs([...pairs, { out, in: c.number }]); setOut(null) },
              testAttr: { 'data-sub-in': String(c.number) }
            }))}
          </div>
        </div>
      )}

      {needCaptain && out == null && (
        <div className="space-y-2" data-sub-game-captain="">
          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-800">{t('benchRequests.gameCaptain', 'Game captain')}</span>
          <p className="text-xs text-stone-600">{t('benchRequests.subSheet.gameCaptainHint', 'The game captain goes off: who leads the team on court?')}</p>
          <div className="flex flex-wrap gap-2">
            {choices.gameCaptainChoices.map((n) => (
              <button
                key={n}
                type="button"
                data-game-captain={n}
                aria-pressed={str(gameCaptain) === n}
                onClick={() => setGameCaptain(n)}
                className={cn('h-11 min-w-11 px-3 rounded-xl border text-base font-bold tabular-nums', FOCUS_RING,
                  str(gameCaptain) === n ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-stone-300 text-stone-800')}
              >{n}</button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}
