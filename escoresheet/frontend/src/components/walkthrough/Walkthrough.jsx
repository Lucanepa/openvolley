import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, Check, FastForward, ListOrdered, Loader2, X } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { IconButton } from '../../ui/IconButton.jsx'
import { cn } from '../../ui/cn.js'
import { CHAPTERS, STEPS, stepsOfChapter } from './walkthroughSteps'
import {
  useWalkthrough, getWalkthrough, nextStep, previousStep, skipChapter, goToChapter, endWalkthrough, setWalkthroughMatch
} from './walkthroughStore'
import { resolveTarget, boxOf, openDialogs, WALKTHROUGH_ROOT_ATTR } from './targets'
import { fastForwardToSet5 } from './walkthroughFlow'
import { removeDemoData } from './demoData'

// Above every dialog it may point into (legacy modals 1000-3000, the help
// panel 3100-3200, kit dialogs z-50), under the size gate (99999)
const Z = 3300
const PAD = 8
const GAP = 12
// a prepare that never ends (a screen that does not come) gives up
const PREPARE_MAX_MS = 180000

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

function sameBox(a, b) {
  if (!a || !b) return a === b
  return Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
}

function viewport() {
  return { w: window.innerWidth, h: window.innerHeight }
}

const overlap = (a, b) => (!a || !b ? 0 : Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) * Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)))

/**
 * Where the card goes: beside the box (under it, else over it, else to a
 * side), never over it when it fits; centred without a box. When nothing
 * beside it fits (a tall dialog, a narrow screen across its width), the top
 * or the bottom edge, whichever covers less of the control to tap (`keep`),
 * then of the box.
 */
function placeCard(box, card, { w, h }, keep = null) {
  const width = Math.min(380, w - 32)
  const ch = card?.height || 220
  if (!box) return { width, left: (w - width) / 2, top: Math.max(16, (h - ch) / 2) }
  const narrow = w < 600
  const cw = narrow ? w - 32 : width
  const clampLeft = (x) => Math.max(16, Math.min(x, w - cw - 16))
  const centreX = narrow ? 16 : clampLeft(box.left + box.width / 2 - cw / 2)
  if (h - box.bottom >= ch + GAP + 16) return { width: cw, left: centreX, top: box.bottom + GAP }
  if (box.top >= ch + GAP + 16) return { width: cw, left: centreX, top: box.top - GAP - ch }
  const clampTop = (y) => Math.max(16, Math.min(y, h - ch - 16))
  if (!narrow && w - box.right >= width + GAP + 16) return { width, left: box.right + GAP, top: clampTop(box.top) }
  if (!narrow && box.left >= width + GAP + 16) return { width, left: box.left - GAP - width, top: clampTop(box.top) }
  const left = narrow ? 16 : w - width - 16
  const options = [16, Math.max(16, h - ch - 16)].map(top => {
    const r = { top, bottom: top + ch, left, right: left + cw }
    return { top, cost: overlap(r, keep) * 1000 + overlap(r, box) }
  })
  options.sort((a, b) => a.cost - b.cost)
  return { width: cw, left, top: options[0].top }
}

/**
 * "Your first match" (owner plan 24.11.2026, Phase 2): a card with the step
 * (title, text, Back / Next, Skip chapter, End, progress, the chapters) over
 * the real app, and a spotlight on the control the step is about. The
 * control stays usable (the spotlight's hole lets the tap through); a step
 * that says so goes on when it is tapped. The spotlight follows the control
 * when the screen moves or resizes. While a dialog the step does not point
 * into is open, the screen is not dimmed: the card waits at the edge.
 * `appCtx` (App): the screens and the test match (walkthroughFlow.js).
 */
export default function Walkthrough({ appCtx }) {
  const { t, i18n } = useTranslation()
  const wt = useWalkthrough()
  const step = wt.active ? STEPS[wt.step] : null
  const [phase, setPhase] = useState('idle') // preparing | ready | missing | error
  const [waiting, setWaiting] = useState(null) // 'dialog' | 'preparing' | null
  const [box, setBox] = useState(null)
  const [keepBox, setKeepBox] = useState(null)
  const [dialogMode, setDialogMode] = useState(false)
  const [dialogBox, setDialogBox] = useState(null)
  const [chaptersOpen, setChaptersOpen] = useState(false)
  const [busy, setBusy] = useState(null) // the fast-forward: { set }
  const [retry, setRetry] = useState(0)
  const cardRef = useRef(null)
  const [cardSize, setCardSize] = useState(null)
  const leftByClick = useRef(false)

  // The flow's view of the app (walkthroughFlow.js): App's screens, live
  const ctx = useMemo(() => ({
    t,
    db: appCtx.db,
    get phone() { return appCtx.isPhone() },
    page: () => appCtx.page(),
    matchId: () => appCtx.matchId(),
    goHome: () => appCtx.goHome(),
    createTestMatch: () => appCtx.createTestMatch(),
    showSetup: (id) => appCtx.showSetup(id),
    showScoreboard: (id) => appCtx.showScoreboard(id),
    restoreTestRosters: (id) => appCtx.restoreTestRosters(id),
    walkthroughMatchId: () => getWalkthrough().matchId,
    rememberMatch: (id) => setWalkthroughMatch(id),
    waiting: (reason) => setWaiting(reason)
  }), [t, appCtx])

  // Each step: its screen first (prepare), then its control
  useEffect(() => {
    if (!step) return undefined
    let cancelled = false
    leftByClick.current = false
    setPhase('preparing')
    setBox(null)
    setChaptersOpen(false)
    ;(async () => {
      try {
        if (step.prepare) await withTimeout(Promise.resolve(step.prepare(ctx)), PREPARE_MAX_MS)
      } catch (err) {
        console.warn('[Walkthrough] step not ready:', step.id, err?.message)
        if (!cancelled) setPhase(step.target ? 'missing' : 'ready')
        return
      }
      if (cancelled) return
      if (!step.target) { setPhase('ready'); return }
      const end = Date.now() + 10000
      while (!cancelled && Date.now() < end) {
        if (resolveTarget(step.target, ctx).length) { setPhase('ready'); return }
        await new Promise(r => setTimeout(r, 150))
      }
      if (!cancelled) setPhase('missing')
    })()
    return () => {
      cancelled = true
      setWaiting(null)
      // what the step opened for itself (a dialog it shows) closes when the
      // walkthrough goes on with the card; not after a tap on the step's own
      // control (that tap opened what comes next)
      if (step.leave && !leftByClick.current) Promise.resolve(step.leave(ctx)).catch(() => {})
    }
  }, [wt.active, wt.step, wt.run, retry]) // eslint-disable-line react-hooks/exhaustive-deps

  // The demo data goes when the walkthrough ends (demoData.js), and at the
  // app's start what a walkthrough stopped by a reload left
  const wasActive = useRef(false)
  useEffect(() => {
    if (!getWalkthrough().active) removeDemoData(appCtx.db).catch(() => {})
  }, [appCtx.db])
  useEffect(() => {
    if (wasActive.current && !wt.active) removeDemoData(appCtx.db).catch(() => {})
    wasActive.current = wt.active
  }, [wt.active, appCtx.db])

  // The spotlight follows its control (layout changes, scrolling, resizing)
  const scrolledFor = useRef(null)
  const measure = useCallback(() => {
    if (!step) return
    const found = step.target && phase === 'ready' ? resolveTarget(step.target, ctx) : []
    if (found.length && scrolledFor.current !== `${wt.run}:${wt.step}`) {
      scrolledFor.current = `${wt.run}:${wt.step}`
      found[0].scrollIntoView?.({ block: 'center', inline: 'nearest' })
    }
    const next = found.length ? boxOf(found, PAD) : null
    setBox(prev => (sameBox(prev, next) ? prev : next))
    // the control a tap on goes on with: the card keeps clear of it
    const clickEls = found.length && step.click ? resolveTarget(step.click, ctx) : []
    const keep = clickEls.length ? boxOf(clickEls, PAD) : null
    setKeepBox(prev => (sameBox(prev, keep) ? prev : keep))
    // a dialog the step does not point into: no dimming, the card aside
    const dialogs = openDialogs()
    const into = found.length && dialogs.some(d => found.some(el => d.contains(el) || el.contains(d)))
    setDialogMode(dialogs.length > 0 && !into)
    // the open dialog's box: the card keeps clear of it
    const top = dialogs.length && !into ? dialogs[dialogs.length - 1].getBoundingClientRect() : null
    const next2 = top ? { top: top.top, bottom: top.bottom } : null
    setDialogBox(prev => (prev && next2 && prev.top === next2.top && prev.bottom === next2.bottom) || (!prev && !next2) ? prev : next2)
  }, [step, phase, ctx, wt.run, wt.step])

  useEffect(() => {
    if (!step) return undefined
    measure()
    const timer = setInterval(measure, 150)
    const onChange = () => measure()
    window.addEventListener('resize', onChange)
    window.addEventListener('scroll', onChange, true)
    return () => {
      clearInterval(timer)
      window.removeEventListener('resize', onChange)
      window.removeEventListener('scroll', onChange, true)
    }
  }, [step, measure])

  // A step that goes on with a tap on its control (advance 'click')
  useEffect(() => {
    if (!step || step.advance !== 'click' || phase !== 'ready') return undefined
    const onClick = (e) => {
      if (e.target?.closest?.(`[${WALKTHROUGH_ROOT_ATTR}]`)) return
      const els = resolveTarget(step.click || step.target, ctx)
      if (!els.some(el => el.contains(e.target))) return
      leftByClick.current = true
      const at = getWalkthrough().step
      // after the app has handled the tap
      setTimeout(() => { if (getWalkthrough().active && getWalkthrough().step === at) nextStep() }, 0)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [step, phase, ctx])

  // the full card's height (not the small one beside a dialog)
  const compactRef = useRef(false)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el || compactRef.current) return
    const r = el.getBoundingClientRect()
    setCardSize(prev => (prev && Math.abs(prev.height - r.height) < 1 ? prev : { height: r.height }))
  })

  if (!step || typeof document === 'undefined') return null

  const chapter = CHAPTERS[step.chapter]
  const ofChapter = stepsOfChapter(step.chapter)
  const inChapter = ofChapter.indexOf(wt.step) + 1
  const last = wt.step === STEPS.length - 1
  // the phone's scoring screen has controls of its own: a text of its own where it differs
  const stepKey = (k) => `walkthrough.steps.${step.id}.${k}`
  const onPhone = ctx.phone && step.screen === 'scoreboard'
  const title = onPhone && i18n.exists(stepKey('titlePhone')) ? t(stepKey('titlePhone')) : t(stepKey('title'))
  const text = onPhone && i18n.exists(stepKey('textPhone')) ? t(stepKey('textPhone')) : t(stepKey('text'))
  const vp = viewport()
  const showScrim = !dialogMode && !busy
  const spot = phase === 'ready' && showScrim ? box : null
  const pos = placeCard(dialogMode ? null : spot, cardSize, vp, keepBox)
  // a dialog open: the card waits beside it (above or below, where there is
  // more room), small when the room is short: never over the dialog's buttons
  const fullHeight = cardSize?.height || 220
  const roomAbove = dialogBox ? dialogBox.top - 24 : 0
  const roomBelow = dialogBox ? vp.h - dialogBox.bottom - 24 : vp.h
  const dialogWidth = Math.min(380, vp.w - 32)
  const dialogLeft = vp.w < 600 ? 16 : Math.max(16, vp.w - dialogWidth - 16)
  const compact = dialogMode && Math.max(roomAbove, roomBelow) < fullHeight
  compactRef.current = compact
  const cardStyle = !dialogMode
    ? { left: pos.left, top: pos.top, width: pos.width }
    : roomAbove > roomBelow
      ? { left: dialogLeft, top: 8, width: vp.w < 600 ? vp.w - 32 : dialogWidth }
      : { left: dialogLeft, bottom: 8, width: vp.w < 600 ? vp.w - 32 : dialogWidth }

  const runFastForward = async () => {
    setBusy({ set: null })
    try {
      await fastForwardToSet5(ctx, { onSet: (set) => setBusy({ set }) })
      if (getWalkthrough().active) nextStep()
    } catch (err) {
      console.warn('[Walkthrough] skip to set 5:', err?.message)
      setPhase('error')
    } finally {
      setBusy(null)
    }
  }

  const clip = spot ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${spot.left}px ${spot.top}px, ${spot.right}px ${spot.top}px, ${spot.right}px ${spot.bottom}px, ${spot.left}px ${spot.bottom}px, ${spot.left}px ${spot.top}px)` : undefined

  return createPortal(
    <div {...{ [WALKTHROUGH_ROOT_ATTR]: '' }} data-testid="walkthrough" data-step={step.id} data-phase={phase} className="no-print">
      {showScrim && (
        // the scrim takes the taps around the control (the hole lets its tap through)
        <div
          data-testid="walkthrough-scrim"
          aria-hidden="true"
          className="fixed inset-0 bg-stone-900/55"
          style={{ zIndex: Z, clipPath: clip, transition: 'clip-path 0.2s ease-out' }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {spot && (
        <div
          aria-hidden="true"
          data-testid="walkthrough-ring"
          className="pointer-events-none fixed rounded-xl border-2 border-white"
          style={{ zIndex: Z + 1, top: spot.top, left: spot.left, width: spot.width, height: spot.height, animation: 'ov-walkthrough-pulse 2s infinite' }}
        />
      )}
      <section
        ref={cardRef}
        aria-labelledby="walkthrough-title"
        data-testid="walkthrough-card"
        className="ov-kit fixed flex max-h-[85vh] flex-col overflow-y-auto rounded-2xl border border-stone-200/70 bg-white p-4 text-stone-800 shadow-card-lg"
        style={{ zIndex: Z + 2, ...cardStyle }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400" data-testid="walkthrough-chapter">
              {t('walkthrough.chapterOf', { n: step.chapter + 1, total: CHAPTERS.length })} · {t(`walkthrough.chapters.${chapter.id}`)}
            </div>
            <h2 id="walkthrough-title" className="mt-1 text-base font-bold leading-snug text-stone-900">{title}</h2>
          </div>
          <div className="-mr-2 -mt-1 flex shrink-0 items-center">
            <IconButton variant="close" icon={ListOrdered} label={t('walkthrough.chapterList')} onClick={() => setChaptersOpen(o => !o)} aria-expanded={chaptersOpen} data-testid="walkthrough-chapters" />
            <IconButton variant="close" icon={X} label={t('walkthrough.end')} onClick={() => endWalkthrough()} data-testid="walkthrough-end" />
          </div>
        </div>

        {compact ? (
          <p className="mt-1 text-xs text-stone-500" data-testid="walkthrough-compact">{waiting === 'dialog' ? t('walkthrough.waitingDialog') : t('walkthrough.dialogOpen')}</p>
        ) : chaptersOpen ? (
          <ol className="mt-3 divide-y divide-stone-100" data-testid="walkthrough-chapter-list">
            {CHAPTERS.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => { setChaptersOpen(false); goToChapter(i) }}
                  className={cn('flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-stone-50', i === step.chapter ? 'font-semibold text-stone-900' : 'text-stone-700')}
                >
                  <span className="min-w-0"><span className="tabular-nums text-stone-400">{i + 1}</span> · {t(`walkthrough.chapters.${c.id}`)}</span>
                  {i === step.chapter && <Check size={15} aria-hidden="true" className="shrink-0 text-stone-500" />}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-stone-600" data-testid="walkthrough-text">{text}</p>
            {waiting === 'dialog' && (
              <p className="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600" data-testid="walkthrough-waiting">{t('walkthrough.waitingDialog')}</p>
            )}
            {(phase === 'preparing' || waiting === 'preparing') && waiting !== 'dialog' && (
              <p className="mt-2 flex items-center gap-2 text-xs text-stone-500" data-testid="walkthrough-preparing">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                {t('walkthrough.preparing')}
              </p>
            )}
            {(phase === 'missing' || phase === 'error') && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="walkthrough-missing">
                <span className="min-w-0 flex-1">{t('walkthrough.notOnScreen')}</span>
                <Button variant="secondary" size="sm" onClick={() => setRetry(n => n + 1)}>{t('walkthrough.tryAgain')}</Button>
              </div>
            )}
            {phase === 'ready' && step.advance === 'click' && !dialogMode && (
              <p className="mt-2 text-xs font-medium text-stone-500" data-testid="walkthrough-tap-hint">{t('walkthrough.tapToGoOn')}</p>
            )}
            {step.action === 'fastForward' && (
              <Button variant="dark" size="lg" block className="mt-3" icon={FastForward} loading={!!busy} onClick={runFastForward} data-testid="walkthrough-fast-forward">
                {busy ? (busy.set ? t('walkthrough.fastForwardSet', { set: busy.set }) : t('walkthrough.fastForwardBusy')) : t('walkthrough.fastForward')}
              </Button>
            )}
          </>
        )}

        {/* progress: this chapter's steps */}
        <div className="mt-3 flex items-center gap-2" aria-label={t('walkthrough.progress', { n: inChapter, total: ofChapter.length })}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-stone-200">
            <div className="h-full rounded-full bg-slate-900" style={{ width: `${(inChapter / ofChapter.length) * 100}%` }} />
          </div>
          <span className="text-[11px] tabular-nums text-stone-500" data-testid="walkthrough-progress">{inChapter}/{ofChapter.length}</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="md" icon={ArrowLeft} onClick={previousStep} disabled={wt.step === 0 || !!busy} data-testid="walkthrough-back">{t('walkthrough.back')}</Button>
          <button type="button" onClick={skipChapter} disabled={!!busy} className="h-9 rounded-lg px-2 text-xs font-medium text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-stone-800 disabled:opacity-50" data-testid="walkthrough-skip">
            {t('walkthrough.skipChapter')}
          </button>
          <Button variant="dark" size="md" iconRight={last ? Check : ArrowRight} onClick={() => (last ? endWalkthrough() : nextStep())} disabled={!!busy} className="ml-auto" data-testid="walkthrough-next">
            {last ? t('walkthrough.finish') : t('walkthrough.next')}
          </Button>
        </div>
      </section>
      <style>{`
        @keyframes ov-walkthrough-pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.25), 0 0 20px rgba(255, 255, 255, 0.15); }
          50% { box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.4), 0 0 30px rgba(255, 255, 255, 0.3); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes ov-walkthrough-pulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.3); } }
        }
        /* Options > Effects and speed: nothing moves (html[data-no-motion]) */
        html[data-no-motion] [data-walkthrough-root] * { animation: none !important; transition: none !important; }
      `}</style>
    </div>,
    document.body
  )
}
