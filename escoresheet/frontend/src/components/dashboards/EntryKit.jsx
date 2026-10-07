// Shared pieces of the referee / bench / livescore / upload-roster entry
// screens, built from the volleyui kit (src/ui). Presentational only: every
// handler and every string comes from the caller.
//
//   EntryPage     - the centred, scrollable area under the dashboard header (.ov-kit scope)
//   EntryCard     - the one gate card of an entry screen (PIN, team choice, game list)
//   PinInput      - the large six-digit PIN field (font-mono, tracked, h-14)
//   GameRow       - one game in a list: date rail, home over away, game-number chip
//   NarrowScreenOverlay - "screen too small" blocker shared by the dashboards
import { Smartphone } from 'lucide-react';
import { cn } from '../../ui/cn.js';
import { Card } from '../../ui/Card.jsx';
import { Input } from '../../ui/Input.jsx';
import { Button } from '../../ui/Button.jsx';
import { Row, DateRail } from '../../ui/Row.jsx';
import { Chip } from '../../ui/Chip.jsx';
import { weekdayLabel, dayLabel, timeLabel } from '../../ui/format.js';

/** Centred content area under a dashboard header; scopes the kit preflight.
 *  Centred with auto margins, not justify-center: when the card is taller than
 *  the space (landscape phone) the overflow then scrolls from the top. */
export function EntryPage({ className, children }) {
  return (
    <div className={cn('ov-kit flex flex-1 min-h-0 flex-col items-center overflow-y-auto bg-gradient-to-b from-stone-50 to-stone-100 px-4 py-6', className)}>
      <div className="my-auto flex w-full flex-col items-center">{children}</div>
    </div>
  );
}

/**
 * The gate card: optional artwork, a title, a quieter subtitle, then the body.
 * `width` caps it (sm for a PIN, md for a list).
 */
export function EntryCard({ art, title, subtitle, width = 'sm', className, children }) {
  return (
    <Card
      stack={false}
      className={cn(
        'relative w-full overflow-hidden rounded-3xl p-6 text-center shadow-card-lg sm:p-8',
        width === 'md' ? 'max-w-lg' : 'max-w-sm',
        className,
      )}
    >
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" aria-hidden />
      {art && <div className="mb-4 flex justify-center">{art}</div>}
      {title && <h1 className="text-2xl font-bold tracking-tight text-stone-900">{title}</h1>}
      {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
      <div className={cn((title || subtitle) && 'mt-6')}>{children}</div>
    </Card>
  );
}

/** Six-digit PIN field: large, monospaced, tracked. Pass the same props as an <input>. */
export function PinInput({ invalid, className, ...rest }) {
  return (
    <Input
      size="lg"
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="one-time-code"
      invalid={invalid}
      className={cn('h-14 text-center font-mono text-2xl font-semibold tabular-nums tracking-[0.3em] placeholder:text-stone-300', className)}
      {...rest}
    />
  );
}

/** Small-caps label over a list or field group, with an optional control on the right. */
export function ListLabel({ children, action, className }) {
  return (
    <div className={cn('flex items-center justify-between gap-2 border-b-[1.5px] border-stone-800 pb-1.5 text-left', className)}>
      <span className="text-[11px] font-bold uppercase tracking-wider text-stone-800">{children}</span>
      {action}
    </div>
  );
}

/**
 * The server stores scheduled_at in UTC, sometimes without the zone suffix
 * (serverDataSync appends a Z for the same reason). Give format.js an instant.
 */
export function scheduledInstant(value) {
  if (!value || typeof value !== 'string') return value;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s.replace(' ', 'T')}Z`;
}

/**
 * One game of a list (referee, bench, upload roster).
 * @param {object} props
 * @param {object} props.match       a list entry: { scheduledAt, homeTeamName|homeTeam, awayTeamName|awayTeam, status }
 * @param {string} props.lang        i18n language for the weekday
 * @param {string} props.gameLabel   e.g. "Game #3412" (translated by the caller)
 * @param {string} props.home        home team name (caller applies its fallbacks)
 * @param {string} props.away        away team name
 * @param {string} [props.noDate]    shown in the rail when the game has no date ("TBD")
 * @param {Function} [props.onOpen]
 * @param {any} [props.status]       top-right indicator (keep it aria-hidden: the row label carries the meaning)
 * @param {string} [props.selectedLabel] when set, this row is the chosen one; the word ("Selected") ends its accessible name
 */
export function GameRow({ match, lang, gameLabel, home, away, noDate, onOpen, status, selectedLabel }) {
  const when = scheduledInstant(match?.scheduledAt);
  const date = when ? dayLabel(when) : '';
  const tone = match?.status === 'live' ? 'red' : 'stone';
  // An aria-label on the row button replaces its whole content, so build it
  // from that content: teams first, then the game number, the date, the state.
  const label = [
    [home, away].filter(Boolean).join(' – '),
    gameLabel,
    date ? `${weekdayLabel(when, lang)} ${date} ${timeLabel(when)}`.trim() : noDate,
    selectedLabel,
  ].filter(Boolean).join(', ');
  return (
    <Row
      tone={tone}
      leading={
        <DateRail
          tone={tone}
          weekday={date ? weekdayLabel(when, lang) : undefined}
          date={date || (noDate ?? '–')}
          time={date ? timeLabel(when) : undefined}
        />
      }
      title={
        <div className="min-w-0 text-left">
          <p className="text-sm font-semibold leading-snug break-words text-stone-900 sm:text-[15px]">{home}</p>
          <p className="text-sm leading-snug break-words text-stone-600 sm:text-[15px]">{away}</p>
        </div>
      }
      chips={gameLabel ? <Chip>{gameLabel}</Chip> : undefined}
      status={status}
      onOpen={onOpen}
      label={onOpen ? label : undefined}
      className="min-h-11"
    />
  );
}

/**
 * Full-screen blocker for screens below the dashboards' minimum size.
 * reason: 'width' (narrower than 357 px) or 'court' (the referee court gets
 * too little room for its player discs, e.g. a phone on its side).
 */
export function NarrowScreenOverlay({ t, reason = 'width' }) {
  return (
    <div
      className="ov-kit fixed inset-0 flex flex-col items-center justify-center bg-stone-900/60 p-6 text-center backdrop-blur-sm"
      style={{ zIndex: 99999 }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-stone-200/70 bg-white p-6 shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-500">
          <Smartphone size={26} strokeWidth={1.75} aria-hidden />
        </div>
        <h2 className="text-lg font-bold text-stone-900">
          {t('common.screenTooSmall', 'Screen too small')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          {reason === 'court'
            ? t('common.screenTooShortMessage', 'The court does not fit on this screen. Please rotate your device, leave split screen or use a larger screen.')
            : t('common.screenTooSmallMessage', 'This app requires a minimum screen width of 357px. Please use a device with a wider screen or rotate your device to landscape mode.')}
        </p>
        <Button
          variant="dark"
          size="xl"
          block
          className="mt-5"
          onClick={() => {
            if (document.documentElement.requestFullscreen) {
              document.documentElement.requestFullscreen().catch(() => { })
            }
          }}
        >
          <span aria-hidden>⛶</span>
          <span>{t('common.tryFullscreen', 'Try fullscreen')}</span>
        </Button>
        <p className="mt-3 text-xs text-stone-500">
          {t('common.fullscreenHint', 'Fullscreen may provide more space by hiding browser UI.')}
        </p>
      </div>
    </div>
  );
}
