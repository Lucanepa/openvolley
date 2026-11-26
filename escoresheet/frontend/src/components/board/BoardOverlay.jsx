/**
 * The stream overlay (/board?overlay#CODE): a small score bug on a
 * see-through page, for OBS or any broadcast app with a browser source. The
 * score is drawn into the video, so it works the same on YouTube, Twitch or
 * any other platform.
 *
 * One row per team (left team on top, as the board's portrait view): a
 * stripe in the team's own colour (volleyui §7: the colour is data), the
 * name, the serve ball, sets won and the points. Under them the set number,
 * a time-out, the set break or the match end, and the finished sets. Sizes
 * follow the viewport width, so the bug keeps its share of the picture at any
 * browser source size. No animation: a point shows the moment it arrives.
 */
import { useTranslation } from 'react-i18next'
import { Volleyball } from '@phosphor-icons/react'
import { bandName } from './BoardScore'

/** A stripe with no team colour (a live state without one) */
const FALLBACK_COLOUR = '#a8a29e' // stone-400: visible on the dark bug

function TeamRow({ team, side, final }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-stretch" data-testid={`overlay-team-${side}`}>
      <span className="w-[0.3em] shrink-0" style={{ background: team.color || FALLBACK_COLOUR }} aria-hidden="true" />
      <span className="w-[10em] truncate px-[0.5em] py-[0.25em] font-semibold" data-testid={`overlay-name-${side}`} title={team.name}>
        {bandName(team)}
      </span>
      <span className="flex w-[1.1em] shrink-0 items-center justify-center" data-testid={`overlay-serve-${side}`} data-serving={!final && team.serving ? 'true' : 'false'}>
        {!final && team.serving && (
          <>
            <Volleyball size="0.8em" weight="fill" aria-hidden="true" />
            <span className="sr-only">{t('board.serving', 'Serving')}</span>
          </>
        )}
      </span>
      {!final && (
        <span className="flex w-[1.5em] shrink-0 items-center justify-center bg-white/10 font-semibold tabular-nums" data-testid={`overlay-sets-${side}`} aria-label={`${t('board.sets', 'Sets')} ${team.sets}`}>
          {team.sets}
        </span>
      )}
      <span className="flex w-[2.1em] shrink-0 items-center justify-center bg-white font-bold tabular-nums text-stone-900" data-testid={`overlay-points-${side}`}>
        {final ? team.sets : team.points}
      </span>
    </div>
  )
}

/** The score bug of a board view with left/right teams. */
export default function BoardOverlay({ view }) {
  const { t } = useTranslation()
  const final = view.phase === 'final'
  const phase = final ? t('board.matchEnd', 'Match end')
    : view.phase === 'timeout' ? t('board.timeout', 'Time-out')
      : view.phase === 'set_break' ? t('board.setBreak', 'Set break')
        : view.setNumber != null ? t('board.set', 'Set {{n}}', { n: view.setNumber }) : null
  const sets = (view.setResults || []).map((s) => `${s.left}–${s.right}`).join(' · ')
  // The score on screen may be old: a small dot the stream operator notices
  const stale = !view.connected || view.scorerPresent === false
  const staleLabel = !view.connected ? t('board.reconnecting', 'Reconnecting…') : t('board.scorerOffline', 'Scorer offline')
  return (
    <div
      className="fixed left-[2.5vw] top-[2.5vw] w-min overflow-hidden rounded-[0.3em] bg-stone-900/90 leading-tight text-white text-[length:clamp(12px,1.5vw,64px)]"
      data-testid="board-overlay"
      data-phase={view.phase}
    >
      <TeamRow team={view.left} side="left" final={final} />
      <div className="h-px bg-white/15" aria-hidden="true" />
      <TeamRow team={view.right} side="right" final={final} />
      {(phase || sets || stale) && (
        <div className="flex flex-wrap items-center gap-x-[0.6em] bg-stone-800 px-[0.6em] py-[0.2em] text-[0.7em] text-white/85" role="status" data-testid="overlay-phase">
          {stale && (
            <span className="inline-block h-[0.6em] w-[0.6em] rounded-full bg-amber-400" title={staleLabel} data-testid="overlay-stale">
              <span className="sr-only">{staleLabel}</span>
            </span>
          )}
          {phase && <span className="font-semibold">{phase}</span>}
          {sets && <span className="tabular-nums">{sets}</span>}
        </div>
      )}
    </div>
  )
}
