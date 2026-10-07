// Advanced: the full event log, collapsed, in human words (describeEvent):
// seq, time, what and the score "A x:y B". Remove takes the whole group
// (a point with its rotation and rally start) after a confirmation that
// names what goes. No Add here: adding is done in the cards above.
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { Switch } from '../../ui/Switch.jsx'
import { describeEvent, compareBySeq, humanize, tr, tsMs, formatScore, scoreBeforeEvent } from '../../domain/describe'
import { HIT } from './shared.jsx'

function clock(ts) {
  const ms = tsMs(ts)
  if (!ms) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function EventLogAdvanced({ events, filterSet, ctx, readOnly, onRemove }) {
  const t = ctx.t
  const [open, setOpen] = useState(false)
  const [showAuto, setShowAuto] = useState(false)
  const rows = useMemo(() => {
    if (!open) return []
    return [...(events || [])]
      .filter(e => filterSet === 'all' || (e.setIndex ?? 1) === Number(filterSet))
      .sort(compareBySeq)
      .map(e => ({ e, d: describeEvent(e, events, ctx) }))
      .filter(r => r.d || showAuto)
  }, [open, events, filterSet, showAuto, ctx])

  return (
    <details
      className="ov-kit rounded-2xl border border-stone-200/70 bg-white shadow-card"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none list-none px-4 py-3.5 text-sm font-semibold text-stone-700 flex items-center justify-between min-h-11">
        <span>{tr(t, 'corrections.section.advanced', 'Advanced: event log')}</span>
        <span aria-hidden="true" className="text-stone-400 text-xs">{open ? '▲' : '▼'}</span>
      </summary>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-xs text-stone-500 mb-3">
            {tr(t, 'corrections.hint.advanced', 'Every entry of the match log. Removing an entry removes everything that belongs to it. Use the cards above to add or change entries.')}
          </p>
          <div className="flex items-center justify-between gap-3 mb-2">
            <span id="ov-corr-auto" className="text-sm text-stone-700">{tr(t, 'corrections.action.showAutomatic', 'Show automatic entries')}</span>
            <Switch checked={showAuto} onCheckedChange={setShowAuto} aria-labelledby="ov-corr-auto" />
          </div>
          <ol className="divide-y divide-stone-100">
            {rows.map(({ e, d }) => (
              <li key={e.id} className="flex items-center gap-3 py-2">
                <span className="w-12 shrink-0 font-mono text-[11px] text-stone-400 tabular-nums">{e.seq}</span>
                <span className="w-10 shrink-0 text-xs text-stone-500 tabular-nums">{clock(e.ts)}</span>
                <span className="min-w-0 flex-1 text-sm text-stone-800">
                  {d ? d.title : <span className="text-stone-500">{humanize(e.type)}</span>}
                  {d?.detail && <span className="text-stone-500"> · {d.detail}</span>}
                  {d?.teamText && <span className="text-stone-500"> · {d.teamText}</span>}
                </span>
                <span className="shrink-0 text-xs text-stone-500 tabular-nums">{d?.score || formatScore(scoreBeforeEvent(events, e), null, ctx)}</span>
                {!readOnly && Number.isInteger(e.seq) && (
                  <Button
                    variant="danger-soft"
                    size="sm"
                    icon={X}
                    className={`${HIT} w-8 px-0`}
                    onClick={() => onRemove(e)}
                    aria-label={tr(t, 'corrections.action.removeEntry', 'Remove {{what}}', { what: d?.title || humanize(e.type) })}
                  />
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </details>
  )
}
