/**
 * The live part of the scoreboard page: two team bands in the teams' own
 * colours (volleyui §7: the colour is data, the text black or white by
 * contrast), huge tabular points, sets won, the serve ball, time-outs used
 * (2 per set) and substitutions (x/6), a banner for a time-out, the set break
 * and the match end, and the finished sets.
 *
 * Landscape: the bands side by side as on court. Portrait (a tablet held
 * upright): stacked, the left team on top. Sizes follow the viewport (vw/vh),
 * so the same page reads at 1920x1080, 1280x720 and on a tablet. No
 * animation: a point shows the moment it arrives.
 */
import { useTranslation } from 'react-i18next'
import { Volleyball } from '@phosphor-icons/react'
import { readableTextOn } from '../../utils/teamColours'
import { BOARD_SUBS_PER_SET, BOARD_TIMEOUTS_PER_SET } from '../../utils/boardFeed'
import { FitText } from '../../../scoresheet_pdf/components/FitText'

/** A band with no team colour (a live state without one) */
const FALLBACK_COLOUR = '#44403c' // stone-700
/**
 * The band name's largest font in px: the size the band's CSS gave it
 * (landscape min(4vw, 7vh), portrait min(6.5vw, 4.2vh), 20 to 112 px). The
 * full name (the short name is retired, 26.11.2026) shrinks from there until
 * it fits two lines. The page renders on every point, so a resize follows.
 */
function bandNameMax() {
  if (typeof window === 'undefined') return 112
  const w = window.innerWidth
  const h = window.innerHeight
  const fluid = h >= w ? Math.min(w * 0.065, h * 0.042) : Math.min(w * 0.04, h * 0.07)
  return Math.round(Math.min(112, Math.max(20, fluid)))
}

function ServeSlot({ serving, label, testId }) {
  // Always takes its place, so the digits never move when the serve changes
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: '0.36em' }} data-testid={testId} data-serving={serving ? 'true' : 'false'}>
      {serving && (
        <>
          <Volleyball size="0.34em" weight="fill" aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </>
      )}
    </span>
  )
}

function TimeoutDots({ used, side }) {
  const { t } = useTranslation()
  const n = Math.max(0, Math.min(BOARD_TIMEOUTS_PER_SET, Number(used) || 0))
  return (
    <div className="flex flex-col items-center gap-[0.6vmin]">
      <span className="font-medium opacity-80 text-[length:clamp(12px,1.5vw,34px)] portrait:text-[length:clamp(12px,2.6vw,34px)]">{t('board.timeouts', 'Time-outs')}</span>
      <span
        role="img"
        aria-label={t('board.timeoutsAria', 'Time-outs used: {{used}} of {{max}}', { used: n, max: BOARD_TIMEOUTS_PER_SET })}
        data-testid={`board-timeouts-${side}`}
        data-used={n}
        className="flex items-center gap-[1.2vmin]"
      >
        {Array.from({ length: BOARD_TIMEOUTS_PER_SET }, (_, i) => (
          <span
            key={i}
            className="block rounded-full border-current w-[clamp(14px,2.4vmin,48px)] h-[clamp(14px,2.4vmin,48px)]"
            style={{ borderWidth: 'clamp(2px, 0.4vmin, 6px)', borderStyle: 'solid', background: i < n ? 'currentColor' : 'transparent' }}
          />
        ))}
      </span>
    </div>
  )
}

function Stat({ label, value, testId, ariaLabel }) {
  return (
    <div className="flex flex-col items-center gap-[0.4vmin]">
      <span className="font-medium opacity-80 text-[length:clamp(12px,1.5vw,34px)] portrait:text-[length:clamp(12px,2.6vw,34px)]">{label}</span>
      <span
        className="font-bold tabular-nums leading-none text-[length:clamp(20px,min(4vw,7vh),110px)] portrait:text-[length:clamp(20px,min(7vw,4.5vh),110px)]"
        data-testid={testId}
        aria-label={ariaLabel}
      >
        {value}
      </span>
    </div>
  )
}

function TeamBand({ team, side, final, winner }) {
  const { t } = useTranslation()
  const colour = team.color || FALLBACK_COLOUR
  const text = readableTextOn(colour)
  const main = final ? team.sets : team.points
  const serveLeft = side === 'left'
  const nameMax = bandNameMax()
  return (
    <section
      className="flex min-h-0 min-w-0 flex-col items-center justify-between overflow-hidden rounded-3xl px-[2vmin] py-[2vmin]"
      style={{ background: colour, color: text }}
      aria-label={team.name}
      data-testid={`board-team-${side}`}
    >
      <h2 className="w-full font-semibold" data-testid={`board-name-${side}`} title={team.name}>
        <FitText
          multiline
          max={nameMax}
          min={10}
          className="w-full flex items-center justify-center text-center leading-tight [overflow-wrap:anywhere]"
          style={{ height: `${Math.round(nameMax * 2.5)}px` }}
        >
          {team.name}
        </FitText>
      </h2>

      <div className="flex w-full min-h-0 items-center justify-center font-bold leading-none tabular-nums text-[length:min(25vw,40vh)] portrait:text-[length:min(42vw,22vh)]">
        {serveLeft && <ServeSlot serving={!final && team.serving} label={t('board.serving', 'Serving')} testId={`board-serve-${side}`} />}
        <span data-testid={`board-points-${side}`} aria-label={final ? `${t('board.sets', 'Sets')} ${main}` : undefined}>{main}</span>
        {!serveLeft && <ServeSlot serving={!final && team.serving} label={t('board.serving', 'Serving')} testId={`board-serve-${side}`} />}
      </div>

      <div className="flex flex-wrap items-end justify-center gap-x-[4vmin] gap-y-[1vmin]">
        {final ? (
          winner && (
            <span className="rounded-full border-2 border-current px-[2vmin] py-[0.5vmin] font-bold text-[length:clamp(16px,2.4vw,56px)]" data-testid={`board-winner-${side}`}>
              {t('board.winnerMark', 'Winner')}
            </span>
          )
        ) : (
          <>
            <Stat label={t('board.sets', 'Sets')} value={team.sets} testId={`board-sets-${side}`} />
            {team.timeoutsUsed != null && <TimeoutDots used={team.timeoutsUsed} side={side} />}
            {team.subs != null && (
              <Stat
                label={t('board.subs', 'Substitutions')}
                value={`${team.subs}/${BOARD_SUBS_PER_SET}`}
                testId={`board-subs-${side}`}
                ariaLabel={t('board.subsAria', 'Substitutions: {{used}} of {{max}}', { used: team.subs, max: BOARD_SUBS_PER_SET })}
              />
            )}
          </>
        )}
      </div>
    </section>
  )
}

function PhaseBanner({ view }) {
  const { t } = useTranslation()
  const { phase, left, right } = view
  const big = 'font-bold leading-tight text-[length:clamp(22px,min(3.6vw,6vh),96px)] portrait:text-[length:clamp(22px,min(6vw,3.6vh),96px)]'
  if (phase === 'final') {
    const winner = left.sets > right.sets ? left : right.sets > left.sets ? right : null
    const score = left.sets >= right.sets ? `${left.sets}–${right.sets}` : `${right.sets}–${left.sets}`
    return (
      <div role="status" data-testid="board-banner" data-phase="final" className="flex flex-wrap items-baseline justify-center gap-x-[2vmin] rounded-2xl bg-emerald-700 px-[3vmin] py-[1vmin] text-white">
        <span className={big}>{t('board.matchEnd', 'Match end')}</span>
        {winner && <span className={`${big} font-semibold`}>{t('board.winner', '{{name}} wins {{score}}', { name: winner.name, score })}</span>}
      </div>
    )
  }
  if (phase === 'timeout' || phase === 'set_break') {
    return (
      <div role="status" data-testid="board-banner" data-phase={phase} className="flex items-center justify-center rounded-2xl bg-slate-900 px-[3vmin] py-[1vmin] text-white">
        <span className={big}>{phase === 'timeout' ? t('board.timeout', 'Time-out') : t('board.setBreak', 'Set break')}</span>
      </div>
    )
  }
  return null
}

function SetResults({ results }) {
  const { t } = useTranslation()
  if (!results?.length) return null
  return (
    <ol className="flex flex-wrap items-center justify-center gap-[1.5vmin]" aria-label={t('board.finishedSets', 'Finished sets')} data-testid="board-set-results">
      {results.map((s) => (
        <li key={s.set} className="flex items-baseline gap-[1vmin] rounded-xl border border-stone-200 bg-white px-[1.8vmin] py-[0.6vmin] text-stone-800">
          <span className="font-medium text-stone-500 text-[length:clamp(12px,1.4vw,32px)] portrait:text-[length:clamp(12px,2.4vw,32px)]">{t('board.set', 'Set {{n}}', { n: s.set })}</span>
          <span className="font-bold tabular-nums text-[length:clamp(18px,2.6vw,64px)] portrait:text-[length:clamp(18px,4.4vw,64px)]">{s.left}–{s.right}</span>
        </li>
      ))}
    </ol>
  )
}

/** The score screen of a board view with left/right teams. */
export default function BoardScore({ view }) {
  const { t } = useTranslation()
  const final = view.phase === 'final'
  const winnerSide = final ? (view.left.sets > view.right.sets ? 'left' : view.right.sets > view.left.sets ? 'right' : null) : null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[1.5vmin]">
      <div className="flex min-h-[clamp(32px,8vh,120px)] flex-wrap items-center justify-center gap-[2vmin]">
        {!final && view.setNumber != null && (
          <span className="rounded-xl bg-white px-[2vmin] py-[0.5vmin] font-bold tabular-nums text-stone-900 shadow-card text-[length:clamp(18px,min(3vw,5vh),80px)] portrait:text-[length:clamp(18px,min(5vw,3vh),80px)]" data-testid="board-set-number">
            {t('board.set', 'Set {{n}}', { n: view.setNumber })}
          </span>
        )}
        <PhaseBanner view={view} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-[1.5vmin] portrait:grid-cols-1 portrait:grid-rows-2">
        <TeamBand team={view.left} side="left" final={final} winner={winnerSide === 'left'} />
        <TeamBand team={view.right} side="right" final={final} winner={winnerSide === 'right'} />
      </div>
      <SetResults results={view.setResults} />
    </div>
  )
}
