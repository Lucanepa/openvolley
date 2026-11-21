import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Keyboard, X } from 'lucide-react'
import Modal from '../Modal'
import { db } from '../../db/db'
import { MATCH_OVER_STATUSES } from '../../domain/matchEnd'
import PhonePairPanel from './PhonePairPanel'
import { closePhonePairPanel, openPhonePair, phonePairController, usePhonePairDock, usePhonePairPanel, usePhonePairState } from './phonePairStore'

const ARRIVAL_MS = 6000
const MATCH_CHECK_MS = 15000

// The indicator's size per place. 'corner': the fixed pill with its words
// (no slot on the screen: home, match setup); in a slot (PhonePairDock) only
// the keyboard, the words its name: 'phone' as the header's 44px squares,
// 'toolbar' as the tablet toolbar's buttons (cqw), 'strip' in the folded
// toolbar's 16px row.
const VARIANTS = {
  corner: { shape: 'rounded-full shadow-lg', box: { height: 36 }, main: { padding: '0 12px', fontSize: 12 }, stop: { width: 32 }, icon: 14, words: true },
  phone: { shape: 'rounded-xl', box: { height: 44 }, main: { width: 44, justifyContent: 'center' }, stop: { width: 36 }, icon: 20 },
  toolbar: { shape: 'rounded-lg', box: { boxSizing: 'border-box', height: '2.5cqw', fontSize: 'calc(1.28cqw * var(--cqf, 1))' }, main: { padding: '0 0.6cqw' }, stop: { padding: '0 0.5cqw' }, icon: '1.1em' },
  strip: { shape: 'rounded-full', box: { boxSizing: 'border-box', height: 16 }, main: { padding: '0 5px' }, stop: { padding: '0 4px' }, icon: 11 }
}

// Never take the focus from the field the phone types into
const keepFocus = { onPointerDown: (e) => e.preventDefault(), onMouseDown: (e) => e.preventDefault() }

/**
 * The "Phone keyboard" indicator: a tap opens the panel (Unpair, the code);
 * while the pairing still waits for the phone, its × stops it.
 */
export function PhonePairIndicator({ variant = 'corner', status, phoneConnected, label, stopLabel, onOpen, onStop }) {
  const v = VARIANTS[variant] || VARIANTS.corner
  const connected = status === 'paired' && phoneConnected
  const tone = connected ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'
  const rule = connected ? 'border-emerald-200' : 'border-amber-200'
  const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-400/60'
  return (
    // ov-kit: the kit's button reset, also in a legacy bar (the tablet toolbar's
    // plain buttons are the scoring green otherwise)
    <span className={`ov-kit inline-flex flex-none items-stretch overflow-hidden border font-semibold ${tone} ${v.shape}`} style={v.box} data-variant={variant} data-testid="phone-pair-pill">
      <button
        type="button"
        {...keepFocus}
        onClick={onOpen}
        title={label}
        aria-label={v.words ? undefined : label}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap transition-colors hover:bg-white/60 ${focus}`}
        style={v.main}
        data-testid="phone-pair-indicator"
      >
        <Keyboard size={v.icon} aria-hidden="true" />
        {v.words && label}
      </button>
      {status === 'pending' && (
        <button
          type="button"
          {...keepFocus}
          onClick={onStop}
          title={stopLabel}
          aria-label={stopLabel}
          className={`inline-flex items-center justify-center border-l transition-colors hover:bg-white/60 ${rule} ${focus}`}
          style={v.stop}
          data-testid="phone-pair-stop-pill"
        >
          <X size={v.icon} aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

/**
 * Pair a phone, mounted once beside the app (main.jsx): the pairing panel,
 * the "Phone keyboard" indicator while a pairing is live (tap: the panel with
 * Unpair; ×: stop a pairing still waiting for the phone), the line that shows
 * what arrived in an official field (the remarks), and the end of the pairing
 * when its match is closed. The indicator sits in the screen's own bar where
 * it keeps a place for it (PhonePairDock), else in the bottom left corner.
 */
export default function PhonePairHost() {
  const { t } = useTranslation()
  const state = usePhonePairState()
  const panel = usePhonePairPanel()
  const dock = usePhonePairDock()
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
  const indicator = (variant) => (
    <PhonePairIndicator
      variant={variant}
      status={state.status}
      phoneConnected={state.phoneConnected}
      label={label}
      stopLabel={t('phonePair.stop')}
      onOpen={() => openPhonePair(lastMatch.current || { matchId: state.matchId })}
      onStop={() => phonePairController().unpair()}
    />
  )
  const arrivalNote = arrival && (
    <p className="m-0 max-w-[min(90vw,420px)] rounded-lg border border-stone-200/70 bg-white px-3 py-2 text-xs text-stone-700 shadow-lg" role="status" aria-live="polite" data-testid="phone-pair-arrival">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('phonePair.arrived', { field: arrival.label || t('phonePair.textField') })}</span>
      <span className="line-clamp-3 whitespace-pre-wrap">{arrival.text}</span>
    </p>
  )
  const corner = { zIndex: 1050, bottom: 'max(8px, env(safe-area-inset-bottom, 0px))' }
  return (
    <>
      {panel && (
        <Modal title={t('phonePair.title')} open={true} onClose={closePhonePairPanel} width={620} zIndex={1100}>
          <PhonePairPanel match={panel} onClose={closePhonePairPanel} />
        </Modal>
      )}
      {live && !panel && dock && createPortal(indicator(dock.dataset?.variant || 'phone'), dock)}
      {/* In a slot, what arrived shows a few seconds in the corner, taps going through it */}
      {live && !panel && dock && arrivalNote && (
        <div className="ov-kit no-print pointer-events-none fixed left-2" style={corner}>{arrivalNote}</div>
      )}
      {live && !panel && !dock && (
        <div className="ov-kit no-print fixed left-2 flex flex-col items-start gap-1.5" style={corner}>
          {arrivalNote}
          {indicator('corner')}
        </div>
      )}
    </>
  )
}
