/**
 * The scoreboard page (/board on the livescore app: livescore.openvolley.app/board,
 * /livescore/board, http://<relay>/livescore/board on a LAN relay). Any screen
 * (a TV, an HDMI stick, a tablet) follows one match by its scoreboard code or
 * a league game number (docs/scoreboard-code-spec.md, utils/boardFeed).
 *
 * - No code in the address: a big form (one field, a TV remote's arrows and
 *   OK work: autofocus, Enter submits). It puts the code in the fragment
 *   (#ABCD2345), which never reaches a server.
 * - A code: connecting, not found / ended / waiting for the scorer screens
 *   with plain instructions, or the score (BoardScore), with a small footer
 *   for the connection and the code.
 * - The screen is kept awake (Screen Wake Lock, where the browser has it).
 *
 * Plain DOM and CSS only (no exotic APIs): TV browsers and HDMI sticks run it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Maximize, Minimize } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { FOCUS_RING } from '../../ui/Button.jsx'
import BoardScore from './BoardScore'
import {
  createBoardFeed,
  emptyBoardView,
  formatBoardCode,
  parseBoardTarget,
  setBoardTargetInUrl,
  takeBoardTargetFromUrl
} from '../../utils/boardFeed'

const targetKey = (target) => (target ? `${target.kind}:${target.code || target.game}` : '')

/** Keep the screen on while `active` (guarded: not every browser has it). */
export function useWakeLock(active) {
  useEffect(() => {
    if (!active) return undefined
    const wakeLock = typeof navigator !== 'undefined' ? navigator.wakeLock : null
    if (!wakeLock || typeof wakeLock.request !== 'function') return undefined
    let sentinel = null
    let gone = false
    const request = async () => {
      try {
        const s = await wakeLock.request('screen')
        if (gone) { try { await s?.release?.() } catch { /* gone */ } } else sentinel = s
      } catch { /* refused (battery saver, not visible): the screen may sleep */ }
    }
    // The browser drops the lock when the page is hidden: ask again when it is back
    const onVisible = () => { if (document.visibilityState === 'visible') void request() }
    void request()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', onVisible)
      try { void sentinel?.release?.() } catch { /* gone */ }
    }
  }, [active])
}

const BIG_BUTTON = cn(
  'inline-flex items-center justify-center gap-2 rounded-xl px-[3vmin] font-semibold transition-colors',
  'min-h-[clamp(48px,8vh,96px)] text-[length:clamp(18px,2.4vw,44px)]',
  FOCUS_RING, 'focus-visible:ring-4'
)
const PRIMARY = cn(BIG_BUTTON, 'bg-red-600 text-white hover:bg-red-700 disabled:bg-stone-300')
const QUIET = cn(BIG_BUTTON, 'border border-stone-300 bg-white text-stone-800 hover:bg-stone-100')

function Panel({ children, testId, state }) {
  return (
    <div className="flex flex-1 items-center justify-center p-[3vmin]">
      <div
        className="w-full max-w-[min(92vw,1400px)] overflow-hidden rounded-3xl border border-stone-200/70 bg-white shadow-card-lg"
        data-testid={testId}
        data-state={state}
      >
        <div className="h-1 bg-gradient-to-r from-red-600 to-red-500" />
        <div className="flex flex-col items-center gap-[3vmin] p-[5vmin] text-center">{children}</div>
      </div>
    </div>
  )
}

const TITLE = 'font-bold tracking-tight text-stone-900 text-[length:clamp(26px,min(4.2vw,7vh),96px)]'
const BODY = 'max-w-[60ch] text-stone-600 text-[length:clamp(16px,min(2.2vw,3.8vh),48px)]'

export function BoardCodeForm({ onSubmit, initialValue = '' }) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState(false)
  const submit = (e) => {
    e.preventDefault()
    const target = parseBoardTarget(value)
    if (!target) {
      setError(true)
      return
    }
    setError(false)
    onSubmit(target)
  }
  return (
    <Panel testId="board-code-form" state="form">
      <h1 className={TITLE}>{t('board.formTitle', 'Show a match on this scoreboard')}</h1>
      <p className={BODY}>{t('board.formIntro', 'Type the scoreboard code from the scoring device (Match menu, Devices and data, Show on a scoreboard) or a league game number.')}</p>
      <form className="flex w-full max-w-[min(86vw,1000px)] flex-col items-stretch gap-[2vmin]" onSubmit={submit} noValidate>
        <label className="sr-only" htmlFor="board-code-input">{t('board.inputLabel', 'Scoreboard code or game number')}</label>
        <input
          id="board-code-input"
          data-testid="board-code-input"
          className={cn(
            'w-full rounded-xl border-2 border-stone-300 bg-white px-[2vmin] text-center font-mono font-semibold uppercase tracking-[0.2em] text-stone-900',
            'min-h-[clamp(56px,11vh,140px)] text-[length:clamp(26px,min(5vw,8vh),110px)]',
            'focus:border-red-600 focus:outline-none focus:ring-4 focus:ring-red-500/40',
            error && 'border-red-400 bg-red-50'
          )}
          value={value}
          onChange={(e) => { setValue(e.target.value); if (error) setError(false) }}
          placeholder="ABCD-2345"
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          enterKeyHint="go"
          aria-invalid={error || undefined}
          aria-describedby={error ? 'board-code-error' : undefined}
        />
        {error && (
          <p id="board-code-error" role="alert" className="font-medium text-red-700 text-[length:clamp(14px,1.8vw,36px)]">
            {t('board.invalid', 'That is not a code. A code has 8 letters and digits, like ABCD-2345. A game number has up to 7 digits.')}
          </p>
        )}
        <button type="submit" className={PRIMARY} data-testid="board-code-submit">{t('board.submit', 'Show match')}</button>
      </form>
    </Panel>
  )
}

function StatusScreen({ view, onAnother }) {
  const { t } = useTranslation()
  const game = view.game
  const content = {
    connecting: [t('board.connecting', 'Connecting…'), t('board.connectingBody', 'Looking for the match.')],
    'not-found': game
      ? [t('board.gameNotFoundTitle', 'Game {{game}} is not live', { game }), t('board.gameNotFoundBody', 'The score appears as soon as the scorer starts the match. This scoreboard checks again by itself.')]
      : [t('board.notFoundTitle', 'No match with this code'), t('board.notFoundBody', 'Check the code on the scoring device. This scoreboard checks again by itself.')],
    ended: [t('board.endedTitle', 'This code has ended'), t('board.endedBody', 'The scorer made a new code or stopped sharing the match. Type the new code to go on.')],
    waiting: [t('board.waitingTitle', 'Waiting for the scorer'), t('board.waitingBody', 'The match is found. The score appears as soon as the scoring device sends it.')],
    'rate-limited': [t('board.rateLimitedTitle', 'Too many tries'), t('board.rateLimitedBody', 'This scoreboard tries again in {{seconds}} s.', { seconds: view.retryAfter ?? 60 })],
    offline: [t('board.offlineTitle', 'No connection to the server'), t('board.offlineBody', 'Check the network of this screen. The scoreboard reconnects by itself.')]
  }[view.state] || [t('board.connecting', 'Connecting…'), '']
  const [title, body] = content
  return (
    <Panel testId="board-status" state={view.state}>
      {view.state === 'connecting' && <Loader2 className="h-[clamp(32px,7vmin,96px)] w-[clamp(32px,7vmin,96px)] animate-spin text-stone-400" aria-hidden="true" />}
      <h1 className={TITLE}>{title}</h1>
      {body && <p className={BODY}>{body}</p>}
      {(view.code || game) && (
        <p className="font-mono font-semibold tracking-[0.2em] text-stone-700 text-[length:clamp(20px,min(3vw,5vh),72px)]" data-testid="board-status-code">
          {view.code || t('board.gameLabel', 'Game {{game}}', { game })}
        </p>
      )}
      <button type="button" className={QUIET} onClick={onAnother} data-testid="board-another-code">
        {t('board.anotherCode', 'Enter another code')}
      </button>
    </Panel>
  )
}

function useFullscreen() {
  const can = typeof document !== 'undefined' && document.fullscreenEnabled === true && typeof document.documentElement?.requestFullscreen === 'function'
  const [on, setOn] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement)
  useEffect(() => {
    if (!can) return undefined
    const sync = () => setOn(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [can])
  const toggle = useCallback(() => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.()?.catch?.(() => {})
      else void document.documentElement.requestFullscreen()?.catch?.(() => {})
    } catch { /* not allowed here */ }
  }, [])
  return { can, on, toggle }
}

function Footer({ view, onAnother }) {
  const { t } = useTranslation()
  const full = useFullscreen()
  let status = t('board.live', 'Live')
  let tone = 'bg-green-600'
  if (!view.connected) {
    status = t('board.reconnecting', 'Reconnecting…')
    tone = 'bg-amber-500'
  } else if (view.scorerPresent === false) {
    status = t('board.scorerOffline', 'Scorer offline')
    tone = 'bg-amber-500'
  }
  const small = 'text-[length:clamp(12px,1.3vw,28px)] portrait:text-[length:clamp(12px,2.2vw,28px)]'
  const tool = cn('inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-[1.2vmin] text-stone-700 hover:bg-stone-100 min-h-[clamp(32px,4.5vh,56px)]', small, FOCUS_RING)
  return (
    <footer className="flex flex-wrap items-center justify-between gap-[1.5vmin] text-stone-600" data-testid="board-footer">
      <span className={cn('inline-flex items-center gap-[0.8vmin] font-medium', small)} role="status" data-testid="board-connection">
        <span className={cn('inline-block h-[0.7em] w-[0.7em] rounded-full', tone)} aria-hidden="true" />
        {status}
      </span>
      <span className="flex flex-wrap items-center gap-[1.2vmin]">
        {(view.code || view.game) && (
          <span className={cn('font-mono tracking-[0.15em] text-stone-500', small)} data-testid="board-code">
            {view.code || t('board.gameLabel', 'Game {{game}}', { game: view.game })}
          </span>
        )}
        <button type="button" className={tool} onClick={onAnother} data-testid="board-another-code">
          {t('board.anotherCode', 'Enter another code')}
        </button>
        {full.can && (
          <button type="button" className={tool} onClick={full.toggle} aria-label={full.on ? t('board.exitFullscreen', 'Leave full screen') : t('board.fullscreen', 'Full screen')} title={full.on ? t('board.exitFullscreen', 'Leave full screen') : t('board.fullscreen', 'Full screen')}>
            {full.on ? <Minimize size="1em" aria-hidden="true" /> : <Maximize size="1em" aria-hidden="true" />}
          </button>
        )}
      </span>
    </footer>
  )
}

const defaultCreateFeed = (opts) => createBoardFeed(opts)

/**
 * @param {object} props
 * @param {object|null} [props.initialTarget]  the target to follow (undefined: from the address)
 * @param {(opts: { target: object, onView: (v: object) => void }) => { start(): void, stop(): void }} [props.createFeed]
 */
export default function BoardApp({ initialTarget, createFeed = defaultCreateFeed }) {
  const { t } = useTranslation()
  const [target, setTarget] = useState(() => (initialTarget === undefined ? takeBoardTargetFromUrl() : initialTarget))
  const [view, setView] = useState(() => emptyBoardView(target))
  const createFeedRef = useRef(createFeed)
  createFeedRef.current = createFeed

  useEffect(() => {
    document.title = t('board.title', 'Scoreboard')
  }, [t])

  // A link opened on this page later (#code in the address bar)
  useEffect(() => {
    const onHash = () => {
      const next = parseBoardTarget(window.location.hash || '')
      if (next) setTarget((cur) => (targetKey(cur) === targetKey(next) ? cur : next))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const key = targetKey(target)
  useEffect(() => {
    if (!target) return undefined
    setView(emptyBoardView(target))
    const feed = createFeedRef.current({ target, onView: setView })
    feed.start()
    return () => feed.stop()
  }, [key]) // the key names the target

  useWakeLock(!!target)

  const choose = useCallback((next) => {
    setBoardTargetInUrl(next)
    setTarget(next)
  }, [])
  const another = useCallback(() => {
    setBoardTargetInUrl(null)
    setTarget(null)
  }, [])

  const hasScore = !!(target && view.left && view.right)
  return (
    <div
      className="ov-kit fixed inset-0 flex flex-col gap-[1.5vmin] overflow-hidden bg-gradient-to-b from-stone-50 to-stone-100 p-[1.5vmin] text-stone-900"
      style={{ paddingBottom: 'calc(1.5vmin + env(safe-area-inset-bottom, 0px))' }}
      translate="no"
      data-testid="board-state"
      data-state={target ? view.state : 'form'}
    >
      {!target ? (
        <BoardCodeForm onSubmit={choose} />
      ) : hasScore ? (
        <>
          <BoardScore view={view} />
          <Footer view={view} onAnother={another} />
        </>
      ) : (
        <StatusScreen view={{ ...view, code: view.code || (target.kind === 'code' ? formatBoardCode(target.code) : null) }} onAnother={another} />
      )}
    </div>
  )
}
