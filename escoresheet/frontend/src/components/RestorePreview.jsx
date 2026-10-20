import { useTranslation } from 'react-i18next'
import { cn } from '../ui'
import { summarizeBackup } from '../utils/backupPreview'

// Body of the Restore preview dialog (App.jsx keeps the dialog and its
// footer): what the chosen backup holds, home on the left, away on the right.
// Each per-team block sits in ONE two-column grid, so a team name that wraps
// on a phone moves both columns down together and the line-ups, time-outs and
// substitutions stay level.

const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const SIDES = ['home', 'away']

const SOURCE_PILL = {
  database: 'bg-sky-100 text-sky-800',
  pocketbase: 'bg-emerald-100 text-emerald-800',
  cloud: 'bg-violet-100 text-violet-800',
  local: 'bg-amber-100 text-amber-800'
}

const MICRO = 'text-[11px] font-bold uppercase tracking-wider text-stone-500'

function LineupGrid({ lineup, emptyLabel }) {
  if (!lineup) {
    return (
      <div className="flex h-full min-h-[5.5rem] items-center justify-center rounded-xl border border-dashed border-stone-200 px-2 text-center text-xs text-stone-400">
        {emptyLabel}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-1">
      {POSITIONS.map(pos => {
        const p = lineup[pos]
        const num = p && typeof p === 'object' ? p.number : p
        const isServing = !!(p && typeof p === 'object' && p.isServing)
        const isLibero = !!(p && typeof p === 'object' && p.isLibero)
        return (
          <div
            key={pos}
            className={cn(
              'rounded-lg border px-1 py-1.5 text-center',
              isServing ? 'border-green-200 bg-green-50' : isLibero ? 'border-orange-200 bg-orange-50' : 'border-stone-200/70 bg-stone-50'
            )}
          >
            <div className="text-[10px] leading-none text-stone-500">{pos}</div>
            <div className="mt-1 text-sm font-semibold leading-none tabular-nums text-stone-900">
              {num ?? '–'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function RestorePreview({ data, source, backupName }) {
  const { t } = useTranslation()
  const s = summarizeBackup(data)
  const name = (side) => s.teams[side] || t(side === 'home' ? 'common.home' : 'common.away')
  const tp = (key, opts) => t(`settings.backup.preview.${key}`, opts)

  const sourceLabel = source === 'database' ? t('settings.backup.fromDatabase', 'From database')
    : source === 'pocketbase' ? 'PocketBase backup'
      : source === 'cloud' ? t('settings.backup.restoreFromCloudBackup')
        : t('settings.backup.fromLocalFile')
  const hasSubs = s.substitutions.home.length > 0 || s.substitutions.away.length > 0

  return (
    <div className="space-y-4 text-sm text-stone-800">
      {/* Source and file */}
      <div className="flex flex-col items-center gap-1.5">
        <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium', SOURCE_PILL[source] || SOURCE_PILL.local)}>
          {sourceLabel}
        </span>
        {backupName && (
          // One unbroken word: allowed to break anywhere, or it ran off both
          // edges of a phone's dialog (2026-10-13)
          <span className="max-w-full break-all rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-center font-mono text-[11px] text-stone-600">
            {backupName.replace(/\.json$/, '')}
          </span>
        )}
      </div>

      {/* Teams and the latest set's score */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-xl border border-stone-200/70 bg-stone-50/60 px-3 py-3 sm:gap-4 sm:px-5">
        {SIDES.map((side, i) => (
          <div key={side} className={cn('min-w-0 text-center', i === 1 && 'order-3')}>
            <div className="break-words text-sm font-bold leading-snug text-stone-900 sm:text-base">{name(side)}</div>
            <div className="mt-0.5 text-[11px] text-stone-500">
              {t(side === 'home' ? 'common.home' : 'common.away')}
            </div>
          </div>
        ))}
        <div className="order-2 text-center">
          <div className="whitespace-nowrap text-2xl font-bold tabular-nums text-stone-900 sm:text-3xl">
            {s.score.home}<span className="px-1 text-stone-400">:</span>{s.score.away}
          </div>
          <div className="text-[11px] text-stone-500">{tp('set', { n: s.setIndex })}</div>
        </div>
      </div>

      {s.serving && (
        <div className="flex items-center justify-center gap-1.5 text-xs text-stone-600">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
          <span>{tp('serving')}:</span>
          <strong className="min-w-0 truncate font-semibold text-stone-900">{name(s.serving)}</strong>
        </div>
      )}

      {/* Per team, row by row in one grid: name, line-up, counts, substitutions */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:gap-x-5">
        <div className={cn(MICRO, 'col-span-2')}>{tp('lineup')} · {tp('set', { n: s.setIndex })}</div>
        {SIDES.map(side => (
          <div key={`name-${side}`} className="line-clamp-2 self-end break-words text-sm font-semibold leading-snug text-stone-800" title={name(side)}>
            {name(side)}
          </div>
        ))}
        {SIDES.map(side => (
          <LineupGrid key={`lineup-${side}`} lineup={s.lineup[side]} emptyLabel={tp('noLineup')} />
        ))}
        {SIDES.map(side => (
          <dl key={`counts-${side}`} className="mt-1 divide-y divide-stone-100 rounded-xl border border-stone-200/70 bg-stone-50/60 px-3 text-xs">
            <div className="flex items-baseline justify-between gap-2 py-1.5">
              <dt className="min-w-0 truncate text-stone-500">{tp('timeouts')}</dt>
              <dd className="font-semibold tabular-nums text-stone-900">{s.timeouts[side]}/2</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2 py-1.5">
              <dt className="min-w-0 truncate text-stone-500">{tp('substitutions')}</dt>
              <dd className="font-semibold tabular-nums text-stone-900">{s.substitutions[side].length}</dd>
            </div>
          </dl>
        ))}
        {hasSubs && SIDES.map(side => (
          <ul key={`subs-${side}`} className="space-y-1">
            {s.substitutions[side].length === 0 ? (
              <li className="px-1 text-xs text-stone-400">{tp('none')}</li>
            ) : s.substitutions[side].map(sub => {
              const title = tp('subTitle', { playerIn: sub.playerIn, playerOut: sub.playerOut, home: sub.home, away: sub.away })
              return (
                <li
                  key={sub.key}
                  title={title}
                  aria-label={title}
                  className="flex items-center justify-between gap-2 rounded-lg border border-stone-200/70 bg-white px-2.5 py-1.5 text-xs tabular-nums"
                >
                  <span className="whitespace-nowrap font-medium text-stone-800">
                    #{sub.playerIn} <span aria-hidden="true" className="text-stone-400">←</span> #{sub.playerOut}
                  </span>
                  <span className="whitespace-nowrap text-stone-500">{sub.home}:{sub.away}</span>
                </li>
              )
            })}
          </ul>
        ))}
      </div>

      {s.sanctions.length > 0 && (
        <div>
          <h4 className={cn(MICRO, 'mb-2')}>{tp('sanctions')} ({s.sanctions.length})</h4>
          <div className="flex flex-wrap gap-1.5">
            {s.sanctions.map((e, i) => (
              <span
                key={e.id ?? i}
                className={cn(
                  'rounded border px-1.5 py-1 text-xs',
                  e.payload?.type === 'red' ? 'border-red-200 bg-red-100 text-red-800'
                    : e.payload?.type === 'yellow' ? 'border-yellow-200 bg-yellow-100 text-yellow-900'
                      : 'border-stone-200 bg-white text-stone-700'
                )}
              >
                {name(e.payload?.team === 'away' ? 'away' : 'home')}{e.payload?.playerNumber ? ` #${e.payload.playerNumber}` : ''} – {e.payload?.type || 'sanction'}
              </span>
            ))}
          </div>
        </div>
      )}

      {s.sets.length > 0 && (
        <div>
          <h4 className={cn(MICRO, 'mb-2')}>{tp('setScores')}</h4>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {s.sets.map(set => (
              <div
                key={set.index}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-center',
                  set.finished ? 'border-stone-200 bg-white' : 'border-sky-200 bg-sky-50'
                )}
              >
                <div className="text-[11px] text-stone-500">{tp('set', { n: set.index })}</div>
                <div className="whitespace-nowrap text-sm font-semibold tabular-nums text-stone-900">
                  {set.home}<span className="px-0.5 text-stone-400">:</span>{set.away}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
