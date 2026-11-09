import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, RotateCcw } from 'lucide-react'
import { Modal } from '../../ui/Modal.jsx'
import { Button } from '../../ui/Button.jsx'
import { cn } from '../../ui/cn.js'
import { FOCUS_RING } from '../../ui/Button.jsx'
import { benchLineupCheck, COURT_ORDER, lineupNumber } from '../../domain/benchRequests'
import { lineupCandidates } from '../../domain/lineupEntry'

// The court as the coach writes the line-up sheet: front row IV III II at
// the net, back row V VI I (I serves)
const FRONT = ['IV', 'III', 'II']
const BACK = ['V', 'VI', 'I']
const FILL_ORDER = ['I', 'II', 'III', 'IV', 'V', 'VI']
const str = (v) => (v === undefined || v === null ? '' : String(v))

/** The team's starting line-up of an earlier set, for "As in set n". */
function startingLineup(events, setIndex, team) {
  const own = (events || []).filter((e) => e.type === 'lineup' && (e.setIndex ?? 1) === setIndex && e.payload?.team === team && e.payload?.lineup)
  if (own.length === 0) return null
  const first = own.find((e) => e.payload?.isInitial) || own.sort((a, b) => (a.seq || 0) - (b.seq || 0))[0]
  return Object.fromEntries(COURT_ORDER.map((p) => [p, str(lineupNumber(first.payload.lineup[p]))]))
}

/**
 * The bench's line-up editor (FIVB 7.3): pick a position, then a player
 * (or a player and it goes to the next empty position, I to VI); a player
 * tapped again leaves the court. Liberos are not in the line-up. When the
 * team captain is not among the six, the coach names the game captain (5.2).
 * Portrait first: a sheet from the bottom on phones and upright tablets.
 */
export default function BenchLineupSheet({ setIndex, team, players = [], events = [], discStyle, lastRequest, onClose, onSend, reserveBottom = false }) {
  const { t } = useTranslation()
  const previous = useMemo(() => (setIndex > 1 ? startingLineup(events, setIndex - 1, team) : null), [events, setIndex, team])
  const [lineup, setLineup] = useState(() => {
    const sent = lastRequest?.request?.lineup
    if (sent) return Object.fromEntries(COURT_ORDER.map((p) => [p, str(sent[p])]))
    return Object.fromEntries(COURT_ORDER.map((p) => [p, '']))
  })
  const [gameCaptain, setGameCaptain] = useState(() => str(lastRequest?.request?.gameCaptain))
  const [selected, setSelected] = useState(() => FILL_ORDER.find((p) => !lineup[p]) || null)

  const check = benchLineupCheck({ lineup, players, events, team, gameCaptain })
  const placed = new Set(Object.values(lineup).filter(Boolean))
  // Who can play: not a libero, not out of the game (lineupCandidates), plus the six placed
  const pool = useMemo(() => {
    const free = lineupCandidates({ players, lineup: [], events, team, setIndex })
    return free.map((p) => String(p.number))
  }, [players, events, team, setIndex])
  const liberos = (players || []).filter((p) => p.libero && p.libero !== '').map((p) => String(p.number))
  const captain = (players || []).find((p) => p.isCaptain || p.captain)
  const captainNo = captain ? String(captain.number) : null

  const place = (number) => {
    const n = String(number)
    const at = COURT_ORDER.find((p) => lineup[p] === n)
    if (at) {
      // tapped again: off the court, its position is next
      setLineup({ ...lineup, [at]: '' })
      setSelected(at)
      return
    }
    const target = selected && !lineup[selected] ? selected : (selected || FILL_ORDER.find((p) => !lineup[p]))
    if (!target) return
    const next = { ...lineup, [target]: n }
    setLineup(next)
    setSelected(FILL_ORDER.find((p) => !next[p]) || null)
  }

  const errorText = (code) => t(`scoreboard.lineupModal.errors.${code}`, { defaultValue: code })
  const paint = discStyle ? discStyle(false) : {}

  const slot = (pos) => {
    const n = lineup[pos]
    const err = check.errors[pos]
    return (
      <button
        key={pos}
        type="button"
        data-lineup-slot={pos}
        aria-pressed={selected === pos}
        aria-label={t('benchRequests.lineupSheet.position', { pos, defaultValue: 'Position {{pos}}' }) + (n ? ` · ${n}` : '')}
        onClick={() => setSelected(pos)}
        className={cn(
          'relative aspect-square w-full rounded-2xl border-2 flex flex-col items-center justify-center gap-0.5 bg-white',
          FOCUS_RING,
          selected === pos ? 'border-slate-900 ring-2 ring-slate-900/20' : err ? 'border-red-400 bg-red-50' : 'border-stone-200'
        )}
      >
        <span className="absolute top-1.5 left-2 text-[11px] font-bold text-stone-400">{pos}</span>
        {n ? (
          <span
            className="flex items-center justify-center rounded-full font-bold tabular-nums"
            style={{ width: '62%', aspectRatio: '1 / 1', fontSize: 'clamp(22px, 7vw, 40px)', background: paint.background || '#e7e5e4', color: paint.color || '#1c1917', textShadow: paint.textShadow }}
          >{n}</span>
        ) : (
          <span className="text-stone-300 text-2xl">–</span>
        )}
        {n && n === captainNo && <span className="absolute top-1.5 right-2 text-[11px] font-bold text-emerald-700">C</span>}
        {n && check.needsGameCaptain && str(gameCaptain) === n && <span className="absolute top-1.5 right-2 text-[11px] font-bold text-emerald-700">GC</span>}
        {err && <span className="absolute bottom-1 inset-x-1 text-[10px] font-medium text-red-700 leading-tight">{errorText(err)}</span>}
      </button>
    )
  }

  return (
    <Modal
      open
      sheet
      size="md"
      className="ov-kit"
      onClose={onClose}
      closeLabel={t('common.close', 'Close')}
      title={t('benchRequests.lineupSheet.title', { set: setIndex, defaultValue: 'Starting line-up · set {{set}}' })}
      description={t('benchRequests.lineupSheet.hint', 'Tap a position, then a player. Only the scorer sees it until the set starts.')}
      footer={(
        // the test match's badge (fixed, bottom right) stays clear of the buttons
        <div className="flex w-full flex-col items-end">
          <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button size="lg" icon={Send} data-bench-lineup-send="" disabled={!check.canSend} onClick={() => onSend(check.payload)}>
            {t('benchRequests.lineupSheet.send', 'Send line-up')}
          </Button>
          </div>
          {reserveBottom && <div className="h-9 sm:hidden" aria-hidden="true" />}
        </div>
      )}
    >
      {lastRequest?.status === 'declined' && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-lineup-declined="">
          {lastRequest.reason
            ? t('benchRequests.status.declinedBecause', { reason: lastRequest.reason })
            : t('benchRequests.status.declined')}
        </p>
      )}
      <div className="space-y-1">
        <div className="text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('benchRequests.lineupSheet.net', 'Net')}</div>
        <div className="h-1 rounded-full bg-stone-800" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-3 gap-2" data-lineup-court="">
        {FRONT.map(slot)}
        {BACK.map(slot)}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-800">{t('benchRequests.lineupSheet.players', 'Players')}</span>
          {previous && (
            <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => { setLineup(previous); setSelected(null) }}>
              {t('benchRequests.lineupSheet.asInSet', { set: setIndex - 1, defaultValue: 'As in set {{set}}' })}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2" data-lineup-pool="">
          {pool.map((n) => {
            const on = placed.has(n)
            return (
              <button
                key={n}
                type="button"
                data-lineup-player={n}
                aria-pressed={on}
                onClick={() => place(n)}
                className={cn('h-12 min-w-12 px-3 rounded-xl border text-lg font-bold tabular-nums', FOCUS_RING,
                  on ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-stone-300 text-stone-800 hover:bg-stone-50')}
              >
                {n}{n === captainNo && <span className="ml-1 text-xs font-bold text-emerald-600">C</span>}
              </button>
            )
          })}
        </div>
        {liberos.length > 0 && (
          <p className="text-xs text-stone-500">{t('benchRequests.lineupSheet.noLiberos', { numbers: liberos.join(', '), defaultValue: 'Liberos ({{numbers}}) are not in the line-up.' })}</p>
        )}
      </div>

      {check.needsGameCaptain && (
        <div className="space-y-2" data-lineup-game-captain="">
          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-800">{t('benchRequests.gameCaptain', 'Game captain')}</span>
          <p className="text-xs text-stone-600">{t('benchRequests.lineupSheet.gameCaptainHint', { captain: captainNo, defaultValue: 'Captain {{captain}} is not in the line-up: who is game captain on court?' })}</p>
          <div className="flex flex-wrap gap-2">
            {check.gameCaptainChoices.map((n) => (
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
