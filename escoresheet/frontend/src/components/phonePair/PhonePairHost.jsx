import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard } from 'lucide-react'
import Modal from '../Modal'
import { db } from '../../db/db'
import { MATCH_OVER_STATUSES } from '../../domain/matchEnd'
import PhonePairPanel from './PhonePairPanel'
import { closePhonePairPanel, openPhonePair, phonePairController, usePhonePairPanel, usePhonePairState } from './phonePairStore'

const ARRIVAL_MS = 6000
const MATCH_CHECK_MS = 15000

/**
 * Pair a phone, mounted once beside the app (main.jsx): the pairing panel,
 * the "Phone keyboard" indicator while a pairing is live (tap: the panel with
 * Unpair), the line that shows what arrived in an official field (the
 * remarks), and the end of the pairing when its match is closed.
 */
export default function PhonePairHost() {
  const { t } = useTranslation()
  const state = usePhonePairState()
  const panel = usePhonePairPanel()
  const lastMatch = useRef(null)
  const [arrival, setArrival] = useState(null)
  const live = state.status === 'pending' || state.status === 'paired'
  if (panel) lastMatch.current = panel

  // What arrived in an official field: shown a few seconds
  useEffect(() => {
    if (!state.arrival) return undefined
    setArrival(state.arrival)
    const timer = setTimeout(() => setArrival(null), ARRIVAL_MS)
    return () => clearTimeout(timer)
  }, [state.arrival])

  // The match closed (approved / final / ended): unpair
  useEffect(() => {
    if (!live || state.matchId == null) return undefined
    let cancelled = false
    const check = async () => {
      try {
        const m = await db.matches.get(state.matchId)
        if (!cancelled && m && MATCH_OVER_STATUSES.includes(m.status) && m.status !== 'ended') phonePairController().unpair()
      } catch { /* no database (tests) */ }
    }
    check()
    const timer = setInterval(check, MATCH_CHECK_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [live, state.matchId])

  // The tab goes away: the pairing ends with it
  useEffect(() => {
    const onHide = (e) => { if (!e.persisted) phonePairController().unpair({ keepalive: true }) }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  const label = state.status === 'pending' ? t('phonePair.indicatorWaiting') : state.phoneConnected ? t('phonePair.indicator') : t('phonePair.indicatorAway')
  return (
    <>
      {panel && (
        <Modal title={t('phonePair.title')} open={true} onClose={closePhonePairPanel} width={620} zIndex={1100}>
          <PhonePairPanel match={panel} onClose={closePhonePairPanel} />
        </Modal>
      )}
      {live && !panel && (
        <div className="ov-kit no-print fixed left-2 flex flex-col items-start gap-1.5" style={{ zIndex: 1050, bottom: 'max(8px, env(safe-area-inset-bottom, 0px))' }}>
          {arrival && (
            <p className="m-0 max-w-[min(90vw,420px)] rounded-lg border border-stone-200/70 bg-white px-3 py-2 text-xs text-stone-700 shadow-lg" role="status" aria-live="polite" data-testid="phone-pair-arrival">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('phonePair.arrived', { field: arrival.label || t('phonePair.textField') })}</span>
              <span className="line-clamp-3 whitespace-pre-wrap">{arrival.text}</span>
            </p>
          )}
          <button
            type="button"
            // never take the focus from the field the phone types into
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openPhonePair(lastMatch.current || { matchId: state.matchId })}
            className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 ${
              state.status === 'paired' && state.phoneConnected ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}
            data-testid="phone-pair-indicator"
          >
            <Keyboard size={14} aria-hidden="true" />
            {label}
          </button>
        </div>
      )}
    </>
  )
}
